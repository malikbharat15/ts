import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import type { PackageDetection } from "../../ingestion/detector";
import type { IFrameworkExtractor } from "./index";
import type {
  ExtractedEndpoint,
  PathParam,
  QueryParam,
  RequestBodySchema,
  BodyField,
  AuthType,
} from "../../blueprint/types";

// ─── Hapi Extractor ───────────────────────────────────────────────────────────
// Hapi uses server.route({ method, path, options: { auth, validate }, handler })
// Very structured — high extraction accuracy.
// Hapi plugin: server.register(plugin, { routes: { prefix } })
// Auth: server.auth.default('jwt') → all routes unless auth: false

let _hapiCounter = 0;
const nextId = () => `hapi_${++_hapiCounter}`;

export const hapiExtractor: IFrameworkExtractor = {
  framework: "hapi",

  canHandle(detection: PackageDetection): boolean {
    return detection.backendFrameworks.includes("hapi");
  },

  async extract(
    files: ParsedFile[],
    _detection: PackageDetection
  ): Promise<ExtractedEndpoint[]> {
    const endpoints: ExtractedEndpoint[] = [];
    let globalAuthStrategy: string | null = null;

    // Phase 1: Find global auth default (server.auth.default('jwt'))
    for (const file of files) {
      if (!file.ast) continue;
      const found = findGlobalAuthDefault(file.ast);
      if (found) { globalAuthStrategy = found; break; }
    }

    // Phase 2: Extract routes from all files
    for (const file of files) {
      if (!file.ast) continue;
      const fileEndpoints = extractFromFile(file, globalAuthStrategy);
      endpoints.push(...fileEndpoints);
    }

    return endpoints;
  },
};

// ─── Global Auth Detection ────────────────────────────────────────────────────

function findGlobalAuthDefault(ast: TSESTree.Program): string | null {
  let strategy: string | null = null;

  for (const stmt of ast.body) {
    walkAst(stmt, (node) => {
      // server.auth.default('jwt')
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.property.type === "Identifier" &&
        (node.callee.property as TSESTree.Identifier).name === "default" &&
        node.callee.object.type === "MemberExpression" &&
        (node.callee.object as TSESTree.MemberExpression).property.type === "Identifier" &&
        ((node.callee.object as TSESTree.MemberExpression).property as TSESTree.Identifier).name === "auth"
      ) {
        if (node.arguments[0]?.type === "Literal") {
          strategy = String((node.arguments[0] as TSESTree.Literal).value);
        }
      }
    });
  }

  return strategy;
}

// ─── Per-File Extraction ──────────────────────────────────────────────────────

function extractFromFile(
  file: ParsedFile,
  globalAuthStrategy: string | null
): ExtractedEndpoint[] {
  if (!file.ast) return [];
  const endpoints: ExtractedEndpoint[] = [];

  for (const stmt of file.ast.body) {
    walkAst(stmt, (node) => {
      if (node.type !== "CallExpression") return;
      const call = node as TSESTree.CallExpression;

      if (call.callee.type !== "MemberExpression") return;
      const callee = call.callee as TSESTree.MemberExpression;
      if (
        callee.property.type !== "Identifier" ||
        (callee.property as TSESTree.Identifier).name !== "route"
      )
        return;

      // server.route(routeConfig) or server.route([...routeConfigs])
      if (call.arguments.length === 0) return;
      const arg = call.arguments[0];

      if (arg.type === "ArrayExpression") {
        for (const el of (arg as TSESTree.ArrayExpression).elements) {
          if (el && el.type === "ObjectExpression") {
            const ep = parseRouteConfig(
              el as TSESTree.ObjectExpression,
              file.filePath,
              globalAuthStrategy
            );
            if (ep) endpoints.push(ep);
          }
        }
      } else if (arg.type === "ObjectExpression") {
        const ep = parseRouteConfig(
          arg as TSESTree.ObjectExpression,
          file.filePath,
          globalAuthStrategy
        );
        if (ep) endpoints.push(ep);
      }
    });
  }

  return endpoints;
}

// ─── Route Config Parser ──────────────────────────────────────────────────────

function parseRouteConfig(
  obj: TSESTree.ObjectExpression,
  sourceFile: string,
  globalAuthStrategy: string | null
): ExtractedEndpoint | null {
  let method: string | null = null;
  let rawPath: string | null = null;
  let optionsNode: TSESTree.ObjectExpression | null = null;

  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    if (prop.key.type !== "Identifier") continue;
    const key = (prop.key as TSESTree.Identifier).name;

    if (key === "method" && prop.value.type === "Literal") {
      method = String((prop.value as TSESTree.Literal).value).toUpperCase();
    } else if (key === "path" && prop.value.type === "Literal") {
      rawPath = String((prop.value as TSESTree.Literal).value);
    } else if (key === "options" && prop.value.type === "ObjectExpression") {
      optionsNode = prop.value as TSESTree.ObjectExpression;
    }
  }

  if (!method || !rawPath) return null;

  const normalizedPath = hapiPathToExpress(rawPath);
  const pathParams = extractPathParams(normalizedPath);

  // Auth from options.auth
  const { authRequired, authType } = resolveAuth(
    optionsNode,
    globalAuthStrategy
  );

  // Validate from options.validate
  const { queryParams, bodyFields } = extractValidate(optionsNode);

  const requestBody: RequestBodySchema | null =
    bodyFields.length > 0
      ? { source: "inferred", rawSchemaRef: null, fields: bodyFields }
      : null;

  return {
    id: nextId(),
    method: method as ExtractedEndpoint["method"],
    path: normalizedPath,
    pathParams,
    queryParams,
    requestBody,
    responseSchema: null,
    authRequired,
    authType,
    roles: [],
    confidence: 0.9,
    sourceLine: obj.loc?.start.line ?? 0,
    flags: [],
    sourceFile,
    framework: "hapi",
  };
}

// ─── Hapi Path → Express Path ─────────────────────────────────────────────────
// {userId} → :userId
// {userId?} → :userId
// {rest*} → * (wildcard)

function hapiPathToExpress(hapiPath: string): string {
  return hapiPath
    .replace(/\{([^}*?]+)\??\}/g, ":$1")   // {userId} or {userId?} → :userId
    .replace(/\{[^}]+\*\d*\}/g, "*");       // {rest*} or {rest*2} → *
}

// ─── Auth Resolution ──────────────────────────────────────────────────────────

function resolveAuth(
  options: TSESTree.ObjectExpression | null,
  globalAuthStrategy: string | null
): { authRequired: boolean; authType: AuthType | null } {
  if (!options) {
    // Use global default if set
    if (globalAuthStrategy) {
      return { authRequired: true, authType: strategyToAuthType(globalAuthStrategy) };
    }
    return { authRequired: false, authType: null };
  }

  for (const prop of options.properties) {
    if (prop.type !== "Property") continue;
    if (prop.key.type !== "Identifier") continue;
    if ((prop.key as TSESTree.Identifier).name !== "auth") continue;

    const val = prop.value;

    // auth: false → explicitly public
    if (val.type === "Literal" && (val as TSESTree.Literal).value === false) {
      return { authRequired: false, authType: null };
    }

    // auth: 'jwt' or auth: 'session' → named strategy
    if (val.type === "Literal") {
      const strat = String((val as TSESTree.Literal).value);
      return { authRequired: true, authType: strategyToAuthType(strat) };
    }

    // auth: { strategy: 'jwt', mode: 'required' }
    if (val.type === "ObjectExpression") {
      for (const p of (val as TSESTree.ObjectExpression).properties) {
        if (
          p.type === "Property" &&
          p.key.type === "Identifier" &&
          (p.key as TSESTree.Identifier).name === "strategy" &&
          p.value.type === "Literal"
        ) {
          const strat = String((p.value as TSESTree.Literal).value);
          return { authRequired: true, authType: strategyToAuthType(strat) };
        }
      }
      return { authRequired: true, authType: "bearer_jwt" };
    }
  }

  // No explicit auth — use global default
  if (globalAuthStrategy) {
    return { authRequired: true, authType: strategyToAuthType(globalAuthStrategy) };
  }
  return { authRequired: false, authType: null };
}

function strategyToAuthType(strategy: string): AuthType {
  const s = strategy.toLowerCase();
  if (s.includes("jwt") || s.includes("bearer")) return "bearer_jwt";
  if (s.includes("session") || s.includes("cookie")) return "session_cookie";
  if (s.includes("basic")) return "basic_auth";
  return "bearer_jwt";
}

// ─── Validate Options ─────────────────────────────────────────────────────────

function extractValidate(
  options: TSESTree.ObjectExpression | null
): { queryParams: QueryParam[]; bodyFields: BodyField[] } {
  if (!options) return { queryParams: [], bodyFields: [] };

  for (const prop of options.properties) {
    if (prop.type !== "Property") continue;
    if (prop.key.type !== "Identifier") continue;
    if ((prop.key as TSESTree.Identifier).name !== "validate") continue;

    if (prop.value.type !== "ObjectExpression") continue;
    const validateObj = prop.value as TSESTree.ObjectExpression;

    const queryParams = extractJoiFields(validateObj, "query");
    const bodyFields = extractJoiFieldsAsBodyFields(validateObj, "payload");

    return { queryParams, bodyFields };
  }

  return { queryParams: [], bodyFields: [] };
}

function extractJoiFields(
  validateObj: TSESTree.ObjectExpression,
  key: string
): QueryParam[] {
  for (const prop of validateObj.properties) {
    if (prop.type !== "Property") continue;
    if (prop.key.type !== "Identifier") continue;
    if ((prop.key as TSESTree.Identifier).name !== key) continue;

    // Joi.object({ page: Joi.number() })
    if (
      prop.value.type === "CallExpression" &&
      prop.value.callee.type === "MemberExpression"
    ) {
      return extractJoiObjectKeys(prop.value as TSESTree.CallExpression).map(
        (name) => ({ name, type: "string", required: false })
      );
    }
  }
  return [];
}

function extractJoiFieldsAsBodyFields(
  validateObj: TSESTree.ObjectExpression,
  key: string
): BodyField[] {
  for (const prop of validateObj.properties) {
    if (prop.type !== "Property") continue;
    if (prop.key.type !== "Identifier") continue;
    if ((prop.key as TSESTree.Identifier).name !== key) continue;

    if (
      prop.value.type === "CallExpression" &&
      prop.value.callee.type === "MemberExpression"
    ) {
      return extractJoiObjectKeys(prop.value as TSESTree.CallExpression).map(
        (name): BodyField => ({
          name,
          type: "string",
          required: false,
          validators: [],
          example: null,
        })
      );
    }

    // Reference to a named schema variable — flag it
    if (prop.value.type === "Identifier") {
      const schemaName = (prop.value as TSESTree.Identifier).name;
      return [
        {
          name: `[${schemaName}]`,
          type: "object",
          required: false,
          validators: [],
          example: null,
        },
      ];
    }
  }
  return [];
}

function extractJoiObjectKeys(call: TSESTree.CallExpression): string[] {
  // Joi.object({ ... }) — find the .object() call and extract key names
  const names: string[] = [];

  if (
    call.callee.type === "MemberExpression" &&
    call.callee.property.type === "Identifier" &&
    (call.callee.property as TSESTree.Identifier).name === "object" &&
    call.arguments[0]?.type === "ObjectExpression"
  ) {
    for (const prop of (call.arguments[0] as TSESTree.ObjectExpression).properties) {
      if (prop.type === "Property" && prop.key.type === "Identifier") {
        names.push((prop.key as TSESTree.Identifier).name);
      }
    }
  }

  return names;
}

// ─── Path Param Extraction ────────────────────────────────────────────────────

function extractPathParams(routePath: string): PathParam[] {
  const params: PathParam[] = [];
  const regex = /:([^/?*]+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(routePath)) !== null) {
    params.push({ name: m[1], type: "string", example: m[1] });
  }
  return params;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

type AstVisitor = (node: TSESTree.Node) => void;

function walkAst(node: TSESTree.Node, visitor: AstVisitor): void {
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && "type" in item) {
            walkAst(item as TSESTree.Node, visitor);
          }
        }
      } else if ("type" in (child as object)) {
        walkAst(child as TSESTree.Node, visitor);
      }
    }
  }
}
