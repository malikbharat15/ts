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

// ─── SvelteKit Extractor ──────────────────────────────────────────────────────
// File-based routing: src/routes/**
// +server.ts   → HTTP API endpoint, named-export HTTP methods (GET/POST/...)
// +page.server.ts → load() = GET, actions = POST
// Path params: [userId] → :userId, [...path] → wildcard

let _sveltekitCounter = 0;
const nextId = () => `sveltekit_${++_sveltekitCounter}`;

export const sveltekitExtractor: IFrameworkExtractor = {
  framework: "sveltekit",

  canHandle(detection: PackageDetection): boolean {
    return (
      detection.backendFrameworks.includes("sveltekit") ||
      detection.frontendFrameworks.includes("sveltekit")
    );
  },

  async extract(
    files: ParsedFile[],
    _detection: PackageDetection
  ): Promise<ExtractedEndpoint[]> {
    const endpoints: ExtractedEndpoint[] = [];

    for (const file of files) {
      if (!file.ast) continue;

      if (isServerFile(file.filePath)) {
        // +server.ts — API endpoint
        const routePath = filePathToRoute(file.filePath);
        if (routePath) {
          endpoints.push(...extractServerEndpoints(file, routePath));
        }
      } else if (isPageServerFile(file.filePath)) {
        // +page.server.ts — load() and actions
        const routePath = filePathToRoute(file.filePath);
        if (routePath) {
          endpoints.push(...extractPageServerEndpoints(file, routePath));
        }
      }
    }

    return endpoints;
  },
};

// ─── File Detection ───────────────────────────────────────────────────────────

function isServerFile(filePath: string): boolean {
  return /[/\\]\+server\.(ts|js)$/.test(filePath);
}

function isPageServerFile(filePath: string): boolean {
  return /[/\\]\+page\.server\.(ts|js)$/.test(filePath);
}

// ─── File Path → URL Route ────────────────────────────────────────────────────
// /src/routes/api/users/[userId]/+server.ts → /api/users/:userId
// /src/routes/users/+page.server.ts → /users

function filePathToRoute(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");

  // Match the routes directory
  const match = normalized.match(/\/src\/routes(\/.*?)\/\+(?:server|page\.server)\.(ts|js)$/);
  if (!match) return null;

  let routePart = match[1] || "";
  if (!routePart) routePart = "/";

  // Convert SvelteKit path segment conventions:
  // [userId] → :userId     (dynamic param)
  // [...path] → *           (catch-all)
  // (group)  → strip         (route group)
  routePart = routePart
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      if (segment.startsWith("[...") && segment.endsWith("]")) return "*";
      if (segment.startsWith("[") && segment.endsWith("]"))
        return `:${segment.slice(1, -1)}`;
      if (segment.startsWith("(") && segment.endsWith(")")) return ""; // route group
      return segment;
    })
    .filter(Boolean)
    .join("/");

  return `/${routePart}`;
}

// ─── +server.ts Endpoint Extraction ──────────────────────────────────────────

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function extractServerEndpoints(
  file: ParsedFile,
  routePath: string
): ExtractedEndpoint[] {
  if (!file.ast) return [];
  const endpoints: ExtractedEndpoint[] = [];
  const pathParams = extractPathParams(routePath);

  for (const node of file.ast.body) {
    if (node.type !== "ExportNamedDeclaration") continue;
    const decl = node.declaration;
    if (!decl) continue;

    let fnName: string | null = null;
    let fnNode: TSESTree.FunctionLike | null = null;

    if (decl.type === "FunctionDeclaration" && decl.id) {
      fnName = decl.id.name;
      fnNode = decl;
    } else if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (
          d.id.type === "Identifier" &&
          d.init &&
          isFunctionLike(d.init)
        ) {
          fnName = (d.id as TSESTree.Identifier).name;
          fnNode = d.init as TSESTree.FunctionLike;
        }
      }
    }

    if (!fnName || !fnNode) continue;
    const method = fnName.toUpperCase();
    if (!HTTP_METHODS.includes(method)) continue;

    const body = getFunctionBody(fnNode);
    const queryParams: QueryParam[] = body
      ? extractQueryParamsFromBody(body)
      : [];
    const bodyFields: BodyField[] = body ? extractBodyFieldsFromBody(body) : [];
    const authRequired = body ? checkAuth(body) : false;

    const requestBody: RequestBodySchema | null =
      bodyFields.length > 0
        ? { source: "inferred", rawSchemaRef: null, fields: bodyFields }
        : null;

    endpoints.push({
      id: nextId(),
      method: method as ExtractedEndpoint["method"],
      path: routePath,
      pathParams,
      queryParams,
      requestBody,
      responseSchema: null,
      authRequired,
      authType: authRequired ? "session_cookie" : null,
      roles: [],
      confidence: 0.85,
      sourceLine: node.loc?.start.line ?? 0,
      flags: [],
      sourceFile: file.filePath,
      framework: "sveltekit",
    });
  }

  return endpoints;
}

// ─── +page.server.ts Endpoint Extraction ─────────────────────────────────────

function extractPageServerEndpoints(
  file: ParsedFile,
  routePath: string
): ExtractedEndpoint[] {
  if (!file.ast) return [];
  const endpoints: ExtractedEndpoint[] = [];
  const pathParams = extractPathParams(routePath);

  let hasLoad = false;
  let hasActions = false;
  const actionNames: string[] = [];
  let authRequired = false;

  for (const node of file.ast.body) {
    if (node.type !== "ExportNamedDeclaration") continue;
    const decl = node.declaration;
    if (!decl) continue;

    // export async function load(...)
    if (decl.type === "FunctionDeclaration" && decl.id?.name === "load") {
      hasLoad = true;
      const body = getFunctionBody(decl);
      if (body && checkAuth(body)) authRequired = true;
    }

    // export const actions = { default: ..., create: ..., delete: ... }
    if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (
          d.id.type === "Identifier" &&
          (d.id as TSESTree.Identifier).name === "actions" &&
          d.init?.type === "ObjectExpression"
        ) {
          hasActions = true;
          for (const prop of (d.init as TSESTree.ObjectExpression).properties) {
            if (
              prop.type === "Property" &&
              prop.key.type === "Identifier"
            ) {
              actionNames.push((prop.key as TSESTree.Identifier).name);
            }
          }
        }
      }
    }
  }

  // load() → GET
  if (hasLoad) {
    const queryParams = extractQueryParamsFromFile(file.ast);
    endpoints.push({
      id: nextId(),
      method: "GET",
      path: routePath,
      pathParams,
      queryParams,
      requestBody: null,
      responseSchema: null,
      authRequired,
      authType: authRequired ? "session_cookie" : null,
      roles: [],
      confidence: 0.8,
      sourceLine: 0,
      flags: [],
      sourceFile: file.filePath,
      framework: "sveltekit",
    });
  }

  // actions → POST (one per named action — suffix ?/actionName)
  if (hasActions) {
    for (const actionName of actionNames) {
      const actionPath =
        actionName === "default" ? routePath : `${routePath}?/${actionName}`;
      endpoints.push({
        id: nextId(),
        method: "POST",
        path: actionPath,
        pathParams,
        queryParams: [],
        requestBody: { source: "inferred", rawSchemaRef: null, fields: [] },
        responseSchema: null,
        authRequired,
        authType: authRequired ? "session_cookie" : null,
        roles: [],
        confidence: 0.75,
        sourceLine: 0,
        flags: [],
        sourceFile: file.filePath,
        framework: "sveltekit",
      });
    }
  }

  return endpoints;
}

// ─── Body / Query Extraction ──────────────────────────────────────────────────

function extractQueryParamsFromBody(body: TSESTree.BlockStatement): QueryParam[] {
  const params: QueryParam[] = [];

  walkAst(body, (node) => {
    // url.searchParams.get('page') or searchParams.get('page')
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      (node.callee.property as TSESTree.Identifier).name === "get"
    ) {
      const obj = node.callee.object;
      const isSearchParams =
        (obj.type === "Identifier" &&
          /searchparams/i.test((obj as TSESTree.Identifier).name)) ||
        (obj.type === "MemberExpression" &&
          obj.property.type === "Identifier" &&
          (obj.property as TSESTree.Identifier).name === "searchParams");

      if (isSearchParams && node.arguments[0]?.type === "Literal") {
        const name = String((node.arguments[0] as TSESTree.Literal).value);
        if (!params.find((p) => p.name === name)) {
          params.push({ name, type: "string", required: false });
        }
      }
    }
  });

  return params;
}

function extractQueryParamsFromFile(ast: TSESTree.Program): QueryParam[] {
  const params: QueryParam[] = [];
  for (const stmt of ast.body) {
    walkAst(stmt, (node) => {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.property.type === "Identifier" &&
        (node.callee.property as TSESTree.Identifier).name === "get"
      ) {
        const obj = node.callee.object;
        const isSearchParams =
          (obj.type === "Identifier" &&
            /searchparams/i.test((obj as TSESTree.Identifier).name)) ||
          (obj.type === "MemberExpression" &&
            obj.property.type === "Identifier" &&
            (obj.property as TSESTree.Identifier).name === "searchParams");

        if (isSearchParams && node.arguments[0]?.type === "Literal") {
          const name = String((node.arguments[0] as TSESTree.Literal).value);
          if (!params.find((p) => p.name === name)) {
            params.push({ name, type: "string", required: false });
          }
        }
      }
    });
  }
  return params;
}

function extractBodyFieldsFromBody(body: TSESTree.BlockStatement): BodyField[] {
  const fields: BodyField[] = [];

  walkAst(body, (node) => {
    // const body = await request.json()
    // const { email } = await request.json()
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

// ─── Auth Detection ───────────────────────────────────────────────────────────

function checkAuth(body: TSESTree.BlockStatement): boolean {
  let auth = false;

  walkAst(body, (node) => {
    // const session = await locals.getSession()
    // if (!session) throw error(401, ...)
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      (node.callee.property as TSESTree.Identifier).name === "getSession"
    ) {
      auth = true;
    }

    // throw error(401, ...)
    if (
      node.type === "ThrowStatement"
    ) {
      const arg = node.argument as TSESTree.Node | null;
      if (arg !== null && arg.type === "CallExpression") {
        const call = arg as TSESTree.CallExpression;
        if (
          call.callee.type === "Identifier" &&
          (call.callee as TSESTree.Identifier).name === "error" &&
          call.arguments[0]?.type === "Literal"
        ) {
          const code = Number((call.arguments[0] as TSESTree.Literal).value);
          if (code === 401 || code === 403) auth = true;
        }
      }
    }

    // redirect(302, '/login')
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      (node.callee as TSESTree.Identifier).name === "redirect"
    ) {
      auth = true;
    }

    // if (!locals.user) redirect(...)
    if (
      node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      (node.object as TSESTree.Identifier).name === "locals" &&
      node.property.type === "Identifier" &&
      (node.property as TSESTree.Identifier).name === "user"
    ) {
      auth = true;
    }
  });

  return auth;
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
