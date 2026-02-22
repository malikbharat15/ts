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

// ─── Koa Extractor ────────────────────────────────────────────────────────────
// Supports @koa/router and koa-router.
// Routes: router.get/.post/.put/.patch/.delete(path, ...middleware)
// Params: ctx.query.x, ctx.request.body, ctx.params.x
// Auth: router.use(jwtMiddleware) / middleware name matching /auth|protect|require/i

let _koaCounter = 0;
const nextId = () => `koa_${++_koaCounter}`;

export const koaExtractor: IFrameworkExtractor = {
  framework: "koa",

  canHandle(detection: PackageDetection): boolean {
    return detection.backendFrameworks.includes("koa");
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

// ─── Per-File Extraction ──────────────────────────────────────────────────────

interface RouterInstance {
  varName: string;
  prefix: string;
  authRequired: boolean; // set by router.use(authMiddleware)
}

function extractFromFile(file: ParsedFile): ExtractedEndpoint[] {
  if (!file.ast) return [];
  const endpoints: ExtractedEndpoint[] = [];

  // Phase 1: Find Router instantiations
  // const router = new Router({ prefix: '/api/v1' })
  const routers = new Map<string, RouterInstance>();
  collectRouterInstances(file.ast, routers);

  // Phase 2: Scan router.use(authMiddleware) to detect auth applied to all routes
  applyRouterUseMiddleware(file.ast, routers);

  // Phase 3: Extract route registrations
  for (const stmt of file.ast.body) {
    walkAst(stmt, (node) => {
      if (node.type !== "CallExpression") return;
      const call = node as TSESTree.CallExpression;

      if (call.callee.type !== "MemberExpression") return;
      const callee = call.callee as TSESTree.MemberExpression;

      if (callee.property.type !== "Identifier") return;
      const methodName = (callee.property as TSESTree.Identifier).name;

      if (!["get", "post", "put", "patch", "delete", "head", "all"].includes(methodName)) return;
      if (callee.object.type !== "Identifier") return;

      const routerVarName = (callee.object as TSESTree.Identifier).name;
      const router = routers.get(routerVarName);
      if (!router) return;

      if (call.arguments.length < 1) return;
      const pathArg = call.arguments[0];
      if (pathArg.type !== "Literal") return;

      const rawPath = String((pathArg as TSESTree.Literal).value);
      const fullPath = normalizePath(router.prefix + rawPath);
      const method = methodName === "all" ? "ALL" : methodName.toUpperCase();
      const pathParams = extractPathParams(fullPath);

      // Check middleware args for auth
      const middlewareArgs = call.arguments.slice(1, -1); // skip first (path) and last (handler)
      const routeAuth = router.authRequired || middlewareImpliesAuth(middlewareArgs);

      // Get handler (last arg)
      const handler = call.arguments[call.arguments.length - 1];
      const handlerFn = isFunctionLike(handler)
        ? (handler as TSESTree.FunctionLike)
        : null;

      const queryParams: QueryParam[] = handlerFn
        ? extractQueryParams(handlerFn)
        : [];
      const bodyFields: BodyField[] = handlerFn
        ? extractBodyFields(handlerFn)
        : [];

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
        authRequired: routeAuth,
        authType: routeAuth ? "bearer_jwt" : null,
        roles: [],
        confidence: 0.8,
        sourceLine: call.loc?.start.line ?? 0,
        flags: [],
        sourceFile: file.filePath,
        framework: "koa",
      });
    });
  }

  return endpoints;
}

// ─── Router Instance Collection ───────────────────────────────────────────────

function collectRouterInstances(
  ast: TSESTree.Program,
  routers: Map<string, RouterInstance>
): void {
  for (const stmt of ast.body) {
    walkAst(stmt, (node) => {
      // const router = new Router({ prefix: '/api' })
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.init?.type === "NewExpression"
      ) {
        const newExpr = node.init as TSESTree.NewExpression;
        const ctorName =
          newExpr.callee.type === "Identifier"
            ? (newExpr.callee as TSESTree.Identifier).name
            : "";

        if (ctorName === "Router") {
          const varName = (node.id as TSESTree.Identifier).name;
          const prefix = extractRouterPrefix(newExpr);
          routers.set(varName, { varName, prefix, authRequired: false });
        }
      }
    });
  }
}

function extractRouterPrefix(newExpr: TSESTree.NewExpression): string {
  if (newExpr.arguments.length === 0) return "";
  const opts = newExpr.arguments[0];
  if (opts.type !== "ObjectExpression") return "";

  for (const prop of (opts as TSESTree.ObjectExpression).properties) {
    if (
      prop.type === "Property" &&
      prop.key.type === "Identifier" &&
      (prop.key as TSESTree.Identifier).name === "prefix" &&
      prop.value.type === "Literal"
    ) {
      return String((prop.value as TSESTree.Literal).value);
    }
  }
  return "";
}

// ─── Router Middleware Auth ───────────────────────────────────────────────────

function applyRouterUseMiddleware(
  ast: TSESTree.Program,
  routers: Map<string, RouterInstance>
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
        const router = routers.get(varName);
        if (!router) return;

        // Check if any middleware arg implies auth
        if (middlewareImpliesAuth(call.arguments)) {
          router.authRequired = true;
        }
      }
    });
  }
}

// ─── Auth Detection ───────────────────────────────────────────────────────────

function middlewareImpliesAuth(args: TSESTree.Node[]): boolean {
  for (const arg of args) {
    if (
      arg.type === "Identifier" &&
      /auth|jwt|protect|require|verify|guard/i.test(
        (arg as TSESTree.Identifier).name
      )
    ) {
      return true;
    }
    // jwt({ secret: ... }) call
    if (
      arg.type === "CallExpression" &&
      arg.callee.type === "Identifier" &&
      /auth|jwt|protect|require|verify/i.test(
        (arg.callee as TSESTree.Identifier).name
      )
    ) {
      return true;
    }
  }
  return false;
}

// ─── Param Extraction ─────────────────────────────────────────────────────────

function extractPathParams(routePath: string): PathParam[] {
  const params: PathParam[] = [];
  const regex = /:([^/?]+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(routePath)) !== null) {
    params.push({ name: m[1], type: "string", example: m[1] });
  }
  return params;
}

function extractQueryParams(fn: TSESTree.FunctionLike): QueryParam[] {
  const params: QueryParam[] = [];
  const body = getFunctionBody(fn);
  if (!body) return params;

  walkAst(body, (node) => {
    // const { page } = ctx.query
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      node.init?.type === "MemberExpression"
    ) {
      const init = node.init as TSESTree.MemberExpression;
      if (
        init.property.type === "Identifier" &&
        (init.property as TSESTree.Identifier).name === "query"
      ) {
        for (const prop of (node.id as TSESTree.ObjectPattern).properties) {
          if (prop.type === "Property" && prop.key.type === "Identifier") {
            const name = (prop.key as TSESTree.Identifier).name;
            if (!params.find((p) => p.name === name)) {
              params.push({ name, type: "string", required: false });
            }
          }
        }
      }
    }

    // ctx.query.page
    if (
      node.type === "MemberExpression" &&
      node.object.type === "MemberExpression" &&
      (node.object as TSESTree.MemberExpression).property.type === "Identifier" &&
      ((node.object as TSESTree.MemberExpression).property as TSESTree.Identifier).name === "query" &&
      node.property.type === "Identifier"
    ) {
      const name = (node.property as TSESTree.Identifier).name;
      if (!params.find((p) => p.name === name)) {
        params.push({ name, type: "string", required: false });
      }
    }
  });

  return params;
}

function extractBodyFields(fn: TSESTree.FunctionLike): BodyField[] {
  const fields: BodyField[] = [];
  const body = getFunctionBody(fn);
  if (!body) return fields;

  walkAst(body, (node) => {
    // const { email } = ctx.request.body
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      node.init?.type === "MemberExpression"
    ) {
      const init = node.init as TSESTree.MemberExpression;
      if (
        init.property.type === "Identifier" &&
        (init.property as TSESTree.Identifier).name === "body"
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

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return ("/" + p.replace(/\/+/g, "/")).replace(/\/+$/, "") || "/";
}

function isFunctionLike(node: TSESTree.Node): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  );
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
