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
} from "../../blueprint/types";

// ─── Hono Extractor ───────────────────────────────────────────────────────────
// Hono is Express-like for modern runtimes (CF Workers, Bun, Deno).
// Routes: app.get/.post/.put/.patch/.delete(path, ...middleware?, handler)
// Groups: app.route('/prefix', subApp)
// Validators: zValidator('json'|'query'|'param', Schema)
// Auth: app.use('*', bearerAuth(...)) or named middleware /auth|protect/i

let _honoCounter = 0;
const nextId = () => `hono_${++_honoCounter}`;

export const honoExtractor: IFrameworkExtractor = {
  framework: "hono",

  canHandle(detection: PackageDetection): boolean {
    return detection.backendFrameworks.includes("hono");
  },

  async extract(
    files: ParsedFile[],
    _detection: PackageDetection
  ): Promise<ExtractedEndpoint[]> {
    const endpoints: ExtractedEndpoint[] = [];

    for (const file of files) {
      if (!file.ast) continue;
      const fileEndpoints = extractFromFile(file);
      endpoints.push(...fileEndpoints);
    }

    return endpoints;
  },
};

// ─── Hono Instance State ──────────────────────────────────────────────────────

interface HonoInstance {
  varName: string;
  basePath: string;
  globalAuthRequired: boolean;
}

// ─── Per-File Extraction ──────────────────────────────────────────────────────

function extractFromFile(file: ParsedFile): ExtractedEndpoint[] {
  if (!file.ast) return [];
  const endpoints: ExtractedEndpoint[] = [];

  // Phase 1: Collect Hono instances and their base paths
  const instances = new Map<string, HonoInstance>();
  collectHonoInstances(file.ast, instances);

  // Phase 2: Detect global auth via app.use('*', ...)
  detectGlobalAuth(file.ast, instances);

  // Phase 3: Extract route declarations
  for (const stmt of file.ast.body) {
    walkAst(stmt, (node) => {
      if (node.type !== "CallExpression") return;
      const call = node as TSESTree.CallExpression;
      if (call.callee.type !== "MemberExpression") return;

      const callee = call.callee as TSESTree.MemberExpression;
      if (callee.object.type !== "Identifier") return;
      const instanceName = (callee.object as TSESTree.Identifier).name;
      const instance = instances.get(instanceName);
      if (!instance) return;

      if (callee.property.type !== "Identifier") return;
      const methodStr = (callee.property as TSESTree.Identifier).name;

      // Check for app.route('/prefix', subApp) — sub-routing
      if (methodStr === "route") {
        // handled separately — skip
        return;
      }

      const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "all"];
      if (!HTTP_METHODS.includes(methodStr)) return;
      if (call.arguments.length < 1) return;

      const pathArg = call.arguments[0];
      if (pathArg.type !== "Literal") return;
      const rawPath = String((pathArg as TSESTree.Literal).value);

      const fullPath = normalizePath(instance.basePath + rawPath);
      const method = methodStr === "all" ? "ALL" : methodStr.toUpperCase();
      const pathParams = extractPathParams(fullPath);

      // Find zValidator middleware and handler
      const middlewareAndHandler = call.arguments.slice(1);
      const { queryParams, bodyFields, authRequired } = analyzeMiddlewareAndHandler(
        middlewareAndHandler,
        instance.globalAuthRequired
      );

      const requestBody: RequestBodySchema | null =
        bodyFields.length > 0
          ? { source: "inferred", rawSchemaRef: null, fields: bodyFields }
          : null;

      endpoints.push({
        id: nextId(),
        method: method as ExtractedEndpoint["method"],
        path: fullPath,
        pathParams,
        queryParams,
        requestBody,
        responseSchema: null,
        authRequired,
        authType: authRequired ? "bearer_jwt" : null,
        roles: [],
        confidence: 0.82,
        sourceLine: call.loc?.start.line ?? 0,
        flags: [],
        sourceFile: file.filePath,
        framework: "hono",
      });
    });
  }

  return endpoints;
}

// ─── Hono Instance Collection ─────────────────────────────────────────────────

function collectHonoInstances(
  ast: TSESTree.Program,
  instances: Map<string, HonoInstance>
): void {
  for (const stmt of ast.body) {
    walkAst(stmt, (node) => {
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.init
      ) {
        const varName = (node.id as TSESTree.Identifier).name;
        const init = node.init;

        // const app = new Hono()
        if (
          init.type === "NewExpression" &&
          init.callee.type === "Identifier" &&
          (init.callee as TSESTree.Identifier).name === "Hono"
        ) {
          instances.set(varName, {
            varName,
            basePath: "",
            globalAuthRequired: false,
          });
        }

        // const app = new Hono().basePath('/api/v1')
        if (
          init.type === "CallExpression" &&
          init.callee.type === "MemberExpression" &&
          init.callee.property.type === "Identifier" &&
          (init.callee.property as TSESTree.Identifier).name === "basePath"
        ) {
          const obj = init.callee.object;
          const isHonoNew =
            obj.type === "NewExpression" &&
            obj.callee.type === "Identifier" &&
            (obj.callee as TSESTree.Identifier).name === "Hono";

          if (isHonoNew) {
            const bp =
              init.arguments[0]?.type === "Literal"
                ? String((init.arguments[0] as TSESTree.Literal).value)
                : "";
            instances.set(varName, {
              varName,
              basePath: bp,
              globalAuthRequired: false,
            });
          }
        }
      }
    });
  }
}

// ─── Global Auth Detection ────────────────────────────────────────────────────

function detectGlobalAuth(
  ast: TSESTree.Program,
  instances: Map<string, HonoInstance>
): void {
  for (const stmt of ast.body) {
    walkAst(stmt, (node) => {
      if (node.type !== "CallExpression") return;
      const call = node as TSESTree.CallExpression;

      if (
        call.callee.type === "MemberExpression" &&
        call.callee.property.type === "Identifier" &&
        (call.callee.property as TSESTree.Identifier).name === "use" &&
        call.callee.object.type === "Identifier"
      ) {
        const varName = (call.callee.object as TSESTree.Identifier).name;
        const instance = instances.get(varName);
        if (!instance) return;

        // app.use('*', bearerAuth(...)) or app.use('*', jwtMiddleware)
        const args = call.arguments;
        for (const arg of args) {
          if (
            arg.type === "Identifier" &&
            /auth|jwt|bearer|protect|require|verify/i.test(
              (arg as TSESTree.Identifier).name
            )
          ) {
            instance.globalAuthRequired = true;
          }
          if (
            arg.type === "CallExpression" &&
            arg.callee.type === "Identifier" &&
            /auth|jwt|bearer|protect|require|verify/i.test(
              (arg.callee as TSESTree.Identifier).name
            )
          ) {
            instance.globalAuthRequired = true;
          }
        }
      }
    });
  }
}

// ─── Middleware / Handler Analysis ───────────────────────────────────────────

interface RouteAnalysis {
  queryParams: QueryParam[];
  bodyFields: BodyField[];
  authRequired: boolean;
}

function analyzeMiddlewareAndHandler(
  args: TSESTree.Node[],
  globalAuth: boolean
): RouteAnalysis {
  const queryParams: QueryParam[] = [];
  const bodyFields: BodyField[] = [];
  let authRequired = globalAuth;

  for (const arg of args) {
    // zValidator('json', Schema) or zValidator('query', Schema) or zValidator('param', Schema)
    if (
      arg.type === "CallExpression" &&
      arg.callee.type === "Identifier" &&
      (arg.callee as TSESTree.Identifier).name === "zValidator"
    ) {
      const target =
        arg.arguments[0]?.type === "Literal"
          ? String((arg.arguments[0] as TSESTree.Literal).value)
          : "";

      if (target === "json") {
        const schemaFields = extractZodObjectKeys(arg.arguments[1]);
        bodyFields.push(...schemaFields.map((name): BodyField => ({
          name,
          type: "string",
          required: false,
          validators: [],
          example: null,
        })));
      } else if (target === "query") {
        const schemaFields = extractZodObjectKeys(arg.arguments[1]);
        queryParams.push(
          ...schemaFields.map((name): QueryParam => ({
            name,
            type: "string",
            required: false,
          }))
        );
      }
    }

    // Named middleware that looks like auth
    if (
      arg.type === "Identifier" &&
      /auth|jwt|bearer|protect|require|verify/i.test(
        (arg as TSESTree.Identifier).name
      )
    ) {
      authRequired = true;
    }

    // Handler function — scan for c.req.json() destructuring and c.req.query()
    if (
      arg.type === "ArrowFunctionExpression" ||
      arg.type === "FunctionExpression"
    ) {
      const fn = arg as TSESTree.FunctionLike;
      const handlerBody = getFunctionBody(fn);
      if (handlerBody) {
        const inferred = inferBodyFromHandler(handlerBody);
        bodyFields.push(...inferred);
      }
    }
  }

  return { queryParams, bodyFields, authRequired };
}

// ─── Zod Object Key Extraction ────────────────────────────────────────────────
// For zValidator('json', z.object({ email: z.string() }))

function extractZodObjectKeys(schemaNode: TSESTree.Node | undefined): string[] {
  if (!schemaNode) return [];

  // z.object({ ... })
  if (
    schemaNode.type === "CallExpression" &&
    schemaNode.callee.type === "MemberExpression" &&
    schemaNode.callee.property.type === "Identifier" &&
    (schemaNode.callee.property as TSESTree.Identifier).name === "object" &&
    schemaNode.arguments[0]?.type === "ObjectExpression"
  ) {
    const names: string[] = [];
    for (const prop of (schemaNode.arguments[0] as TSESTree.ObjectExpression)
      .properties) {
      if (prop.type === "Property" && prop.key.type === "Identifier") {
        names.push((prop.key as TSESTree.Identifier).name);
      }
    }
    return names;
  }

  // Named schema reference — return a placeholder
  if (schemaNode.type === "Identifier") {
    return [`[${(schemaNode as TSESTree.Identifier).name}]`];
  }

  return [];
}

// ─── Handler Body Inference ───────────────────────────────────────────────────
// const { email } = await c.req.json()

function inferBodyFromHandler(body: TSESTree.BlockStatement): BodyField[] {
  const fields: BodyField[] = [];

  walkAst(body, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      node.init?.type === "AwaitExpression"
    ) {
      const call = node.init.argument;
      if (
        call.type === "CallExpression" &&
        call.callee.type === "MemberExpression" &&
        call.callee.property.type === "Identifier" &&
        (call.callee.property as TSESTree.Identifier).name === "json"
      ) {
        for (const prop of (node.id as TSESTree.ObjectPattern).properties) {
          if (prop.type === "Property" && prop.key.type === "Identifier") {
            const name = (prop.key as TSESTree.Identifier).name;
            if (!fields.find((f) => f.name === name)) {
              fields.push({
                name,
                type: "string",
                required: false,
                validators: [],
                example: null,
              });
            }
          }
        }
      }
    }
  });

  return fields;
}

// ─── Path Param Extraction ────────────────────────────────────────────────────

function extractPathParams(routePath: string): PathParam[] {
  const params: PathParam[] = [];
  const regex = /:([^/?]+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(routePath)) !== null) {
    params.push({ name: m[1], type: "string", example: m[1] });
  }
  return params;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return ("/" + p.replace(/\/+/g, "/")).replace(/\/+$/, "") || "/";
}

function getFunctionBody(
  fn: TSESTree.FunctionLike
): TSESTree.BlockStatement | null {
  if (fn.body?.type === "BlockStatement") {
    return fn.body as TSESTree.BlockStatement;
  }
  return null;
}

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
