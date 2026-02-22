import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { IFrameworkExtractor } from "./index";
import type { ParsedFile } from "../parser";
import type { PackageDetection } from "../../ingestion/detector";
import type {
  ExtractedEndpoint,
  QueryParam,
  RequestBodySchema,
  ExtractorFlag,
  AuthType,
} from "../../blueprint/types";
import { walk, extractStringValue } from "../../utils/ast-utils";
import { extractZodSchemas, extractInlineZodSchema } from "../schemas/zod.extractor";

// ─── Counter ──────────────────────────────────────────────────────────────────

let epCounter = 0;
function nextId(): string {
  return `trpc_ep_${String(++epCounter).padStart(3, "0")}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProcedureInfo {
  /** dot-separated path: "users.getAll" */
  path: string;
  procedureType: "query" | "mutation";
  inputSchema: RequestBodySchema | null;
  /** name of the base procedure builder: "publicProcedure", "protectedProcedure", etc. */
  builderName: string;
  sourceLine: number;
  sourceFile: string;
}

interface ProcedureBuilderInfo {
  name: string;
  authRequired: boolean;
  roles: string[];
}

// ─── Adapter / base-path detection ────────────────────────────────────────────

function detectBasePath(files: ParsedFile[]): string {
  // Check for Next.js pages adapter file: /pages/api/trpc/[trpc].ts
  const pagesAdapter = files.find((f) =>
    /\/pages\/api\/trpc\/\[.*\]\.(ts|js|tsx|jsx)$/.test(f.filePath.replace(/\\/g, "/"))
  );
  if (pagesAdapter) return "/api/trpc";

  // Check for Next.js app adapter file: /app/api/trpc/[trpc]/route.ts
  const appAdapter = files.find((f) =>
    /\/app\/api\/trpc\/\[.*\]\/route\.(ts|js|tsx|jsx)$/.test(f.filePath.replace(/\\/g, "/"))
  );
  if (appAdapter) return "/api/trpc";

  // Scan for fetchRequestHandler({ endpoint: '/api/trpc' })
  for (const pf of files) {
    let found: string | null = null;
    walk(pf.ast, (node) => {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "fetchRequestHandler" &&
        node.arguments.length >= 1 &&
        node.arguments[0].type === "ObjectExpression"
      ) {
        for (const prop of node.arguments[0].properties) {
          if (
            prop.type === "Property" &&
            prop.key.type === "Identifier" &&
            prop.key.name === "endpoint"
          ) {
            const val = extractStringValue(prop.value as TSESTree.Node);
            if (val) found = val;
          }
        }
      }
    });
    if (found) return found;
  }

  // Scan for Express: app.use('/trpc', createExpressMiddleware(...))
  for (const pf of files) {
    let found: string | null = null;
    walk(pf.ast, (node) => {
      if (
        node.type === "ExpressionStatement" &&
        node.expression.type === "CallExpression" &&
        node.expression.callee.type === "MemberExpression" &&
        node.expression.callee.property.type === "Identifier" &&
        node.expression.callee.property.name === "use" &&
        node.expression.arguments.length >= 2
      ) {
        const prefixArg = node.expression.arguments[0];
        const middlewareArg = node.expression.arguments[1];
        const prefix = extractStringValue(prefixArg as TSESTree.Node);
        if (
          prefix &&
          middlewareArg.type === "CallExpression" &&
          middlewareArg.callee.type === "Identifier" &&
          middlewareArg.callee.name === "createExpressMiddleware"
        ) {
          found = prefix;
        }
      }
    });
    if (found) return found;
  }

  // Default fallback
  return "/api/trpc";
}

// ─── Procedure builder auth analysis ─────────────────────────────────────────

/**
 * Finds variable declarations like:
 *   const protectedProcedure = publicProcedure.use(middleware)
 * and checks if the middleware throws TRPCError with UNAUTHORIZED/FORBIDDEN.
 */
function analyzeProcedureBuilders(files: ParsedFile[]): Map<string, ProcedureBuilderInfo> {
  const builders = new Map<string, ProcedureBuilderInfo>();

  // publicProcedure is always the base — not auth-required
  builders.set("publicProcedure", { name: "publicProcedure", authRequired: false, roles: [] });
  builders.set("t.procedure", { name: "t.procedure", authRequired: false, roles: [] });

  for (const pf of files) {
    walk(pf.ast, (node) => {
      if (
        node.type !== "VariableDeclaration" &&
        node.type !== "ExportNamedDeclaration"
      ) return;

      const decls: TSESTree.VariableDeclarator[] = [];
      if (node.type === "VariableDeclaration") {
        decls.push(...node.declarations);
      }
      if (
        node.type === "ExportNamedDeclaration" &&
        node.declaration?.type === "VariableDeclaration"
      ) {
        decls.push(...node.declaration.declarations);
      }

      for (const decl of decls) {
        if (decl.id.type !== "Identifier") continue;
        const name = decl.id.name;
        if (!decl.init) continue;

        // Must be a chain ending in .use(...)
        if (!chainContainsUse(decl.init)) continue;

        // Check if the middleware chain throws TRPCError UNAUTHORIZED/FORBIDDEN
        const authRequired = chainHasAuthCheck(decl.init);
        const roles = extractRolesFromChain(decl.init);

        builders.set(name, { name, authRequired, roles });
      }
    });
  }

  return builders;
}

function chainContainsUse(node: TSESTree.Node): boolean {
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "use"
  ) {
    return true;
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression"
  ) {
    return chainContainsUse(node.callee.object);
  }
  return false;
}

function chainHasAuthCheck(node: TSESTree.Node): boolean {
  let found = false;
  walk(node, (n) => {
    // throw new TRPCError({ code: 'UNAUTHORIZED' }) or TRPCError({ code: 'FORBIDDEN' })
    if (n.type === "ThrowStatement" && n.argument) {
      const arg = n.argument as TSESTree.Node;
      const isNew = arg.type === "NewExpression";
      const isCall = arg.type === "CallExpression";
      if (!isNew && !isCall) return;
      const ctor = arg as TSESTree.NewExpression | TSESTree.CallExpression;
      if (
        ctor.callee.type === "Identifier" &&
        ctor.callee.name === "TRPCError" &&
        ctor.arguments.length > 0 &&
        ctor.arguments[0].type === "ObjectExpression"
      ) {
        for (const prop of ctor.arguments[0].properties) {
          if (
            prop.type === "Property" &&
            prop.key.type === "Identifier" &&
            prop.key.name === "code"
          ) {
            const val = extractStringValue(prop.value as TSESTree.Node);
            if (val === "UNAUTHORIZED" || val === "FORBIDDEN") {
              found = true;
            }
          }
        }
      }
    }
  });
  return found;
}

function extractRolesFromChain(node: TSESTree.Node): string[] {
  const roles: string[] = [];
  walk(node, (n) => {
    // Look for Roles guard pattern or role-string enums
    if (
      n.type === "CallExpression" &&
      n.callee.type === "Identifier" &&
      /[Rr]oles?/.test(n.callee.name)
    ) {
      for (const arg of n.arguments) {
        const val = extractStringValue(arg as TSESTree.Node);
        if (val) roles.push(val);
      }
    }
  });
  return roles;
}

// ─── Router + procedure extraction ───────────────────────────────────────────

/**
 * Recursively extracts procedures from a tRPC router object expression.
 * Handles nested routers.
 */
function extractFromRouterObject(
  obj: TSESTree.ObjectExpression,
  prefixParts: string[],
  zodSchemas: Map<string, RequestBodySchema>,
  sourceFile: string,
  sourceLine: number,
  out: ProcedureInfo[]
): void {
  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;

    const keyName =
      prop.key.type === "Identifier"
        ? prop.key.name
        : prop.key.type === "Literal" && typeof prop.key.value === "string"
        ? prop.key.value
        : null;
    if (!keyName) continue;

    const currentPath = [...prefixParts, keyName];

    const value = prop.value;

    // Nested router({ ... }) call — recurse
    if (isRouterCall(value)) {
      const routerObj = getRouterObjectArg(value);
      if (routerObj) {
        extractFromRouterObject(
          routerObj,
          currentPath,
          zodSchemas,
          sourceFile,
          (value as TSESTree.CallExpression).loc?.start.line ?? sourceLine,
          out
        );
      }
      continue;
    }

    // Inline router variable reference — can't easily follow, skip
    // Procedure chain: publicProcedure(.input(...))?.query/mutation
    const procedureInfo = extractProcedureChain(
      value,
      currentPath.join("."),
      zodSchemas,
      sourceFile,
      prop.loc?.start.line ?? sourceLine
    );
    if (procedureInfo) {
      out.push(procedureInfo);
    }
  }
}

function isRouterCall(node: TSESTree.Node): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type === "Identifier" && callee.name === "router") return true;
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "router"
  ) return true;
  // t.router(...)
  if (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "t" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "router"
  ) return true;
  return false;
}

function getRouterObjectArg(node: TSESTree.Node): TSESTree.ObjectExpression | null {
  if (node.type !== "CallExpression") return null;
  if (node.arguments.length === 0) return null;
  const arg = node.arguments[0];
  return arg.type === "ObjectExpression" ? arg : null;
}

/**
 * Walk a procedure chain like:
 *   protectedProcedure.input(CreateUserSchema).mutation(...)
 * Returns ProcedureInfo if this is a terminal .query() or .mutation().
 */
function extractProcedureChain(
  node: TSESTree.Node,
  procedurePath: string,
  zodSchemas: Map<string, RequestBodySchema>,
  sourceFile: string,
  sourceLine: number
): ProcedureInfo | null {
  // Terminal call must be .query() or .mutation()
  if (node.type !== "CallExpression") return null;
  if (node.callee.type !== "MemberExpression") return null;
  if (node.callee.property.type !== "Identifier") return null;

  const terminal = node.callee.property.name;
  if (terminal !== "query" && terminal !== "mutation") {
    // Could be a longer chain — unwrap one level
    // e.g. .use().use().query() — recurse on the call result
    return extractProcedureChain(
      node.callee.object,
      procedurePath,
      zodSchemas,
      sourceFile,
      sourceLine
    );
  }

  const procedureType = terminal as "query" | "mutation";

  // Walk back the chain to find .input() and the base builder name
  let inputSchema: RequestBodySchema | null = null;
  let builderName = "publicProcedure";

  let current: TSESTree.Node = node.callee.object;
  while (current.type === "CallExpression") {
    const ce = current as TSESTree.CallExpression;
    if (
      ce.callee.type === "MemberExpression" &&
      ce.callee.property.type === "Identifier"
    ) {
      const methodName = ce.callee.property.name;
      if (methodName === "input" && ce.arguments.length > 0) {
        const inputArg = ce.arguments[0];
        // Identifier reference to a Zod schema
        if (inputArg.type === "Identifier") {
          const schema = zodSchemas.get(inputArg.name);
          if (schema) inputSchema = schema;
        }
        // Inline Zod call expression
        if (inputArg.type === "CallExpression") {
          const inline = extractInlineZodSchema(inputArg);
          if (inline) inputSchema = inline;
        }
      }
      current = ce.callee.object;
    } else if (ce.callee.type === "Identifier") {
      builderName = ce.callee.name;
      break;
    } else {
      break;
    }
  }

  // If current is an Identifier, that is the procedure builder
  if (current.type === "Identifier") {
    builderName = (current as TSESTree.Identifier).name;
  }
  // MemberExpression: t.procedure
  if (current.type === "MemberExpression") {
    const me = current as TSESTree.MemberExpression;
    if (
      me.object.type === "Identifier" &&
      me.property.type === "Identifier"
    ) {
      builderName = `${me.object.name}.${me.property.name}`;
    }
  }

  return {
    path: procedurePath,
    procedureType,
    inputSchema,
    builderName,
    sourceLine,
    sourceFile,
  };
}

// ─── Main router extraction ───────────────────────────────────────────────────

function extractAllProcedures(
  files: ParsedFile[],
  zodSchemas: Map<string, RequestBodySchema>
): ProcedureInfo[] {
  const procedures: ProcedureInfo[] = [];

  for (const pf of files) {
    walk(pf.ast, (node) => {
      // Look for: router({ ... }) or createTRPCRouter({ ... })
      if (node.type !== "CallExpression") return;
      if (!isRouterCall(node) && !isCreateTRPCRouterCall(node)) return;

      const obj = getRouterObjectArg(node);
      if (!obj) return;

      extractFromRouterObject(
        obj,
        [],
        zodSchemas,
        pf.filePath,
        (node as TSESTree.CallExpression).loc?.start.line ?? 0,
        procedures
      );
    });
  }

  return procedures;
}

function isCreateTRPCRouterCall(node: TSESTree.Node): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return /createTRPCRouter|createRouter|initTRPC/.test(callee.name);
  }
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  ) {
    return /createTRPCRouter|createRouter|router/.test(callee.property.name);
  }
  return false;
}

// ─── tRPC Extractor ───────────────────────────────────────────────────────────

class TRPCExtractor implements IFrameworkExtractor {
  readonly framework = "trpc" as const;

  canHandle(detection: PackageDetection): boolean {
    return detection.backendFrameworks.includes("trpc");
  }

  async extract(
    files: ParsedFile[],
    _detection: PackageDetection
  ): Promise<ExtractedEndpoint[]> {
    const endpoints: ExtractedEndpoint[] = [];
    const zodSchemas = extractZodSchemas(files);

    // Detect base path from adapter patterns
    const basePath = detectBasePath(files);

    // Analyze procedure builders for auth
    const procedureBuilders = analyzeProcedureBuilders(files);

    // Extract all procedures from router definitions
    const procedures = extractAllProcedures(files, zodSchemas);

    for (const proc of procedures) {
      const method: ExtractedEndpoint["method"] =
        proc.procedureType === "query" ? "GET" : "POST";

      const fullPath = `${basePath}/${proc.path}`;

      // Look up procedure builder auth
      const builder = procedureBuilders.get(proc.builderName);
      const authRequired = builder?.authRequired ?? false;
      const roles = builder?.roles ?? [];

      // Build query params for GET with input
      const queryParams: QueryParam[] = [];
      let requestBody: RequestBodySchema | null = null;

      if (proc.inputSchema) {
        if (method === "GET") {
          // For queries, input goes as ?input= query param
          queryParams.push({
            name: "input",
            type: "json",
            required: true,
          });
        } else {
          requestBody = proc.inputSchema;
        }
      }

      let authType: AuthType | null = null;
      if (authRequired) authType = "bearer_jwt";

      const flags: ExtractorFlag[] = [];
      let confidence = 0.80;
      if (!proc.inputSchema && method === "POST") confidence -= 0.05;
      if (authRequired) confidence += 0.05;
      confidence = Math.min(0.95, confidence);

      endpoints.push({
        id: nextId(),
        method,
        path: fullPath,
        pathParams: [],
        queryParams,
        requestBody,
        responseSchema: null,
        authRequired,
        authType,
        roles,
        sourceFile: proc.sourceFile,
        sourceLine: proc.sourceLine,
        framework: "trpc",
        confidence,
        flags,
      });
    }

    return endpoints;
  }
}

export const trpcExtractor = new TRPCExtractor();
