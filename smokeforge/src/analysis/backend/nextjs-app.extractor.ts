import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { IFrameworkExtractor } from "./index";
import type { ParsedFile } from "../parser";
import type { PackageDetection } from "../../ingestion/detector";
import type {
  ExtractedEndpoint,
  PathParam,
  QueryParam,
  RequestBodySchema,
  ExtractorFlag,
  AuthType,
} from "../../blueprint/types";
import { walk, extractStringValue } from "../../utils/ast-utils";
import { extractZodSchemas } from "../schemas/zod.extractor";
import path from "path";
import fs from "fs";

// ─── Counter ──────────────────────────────────────────────────────────────────

let epCounter = 0;
function nextId(): string {
  return `nextapp_ep_${String(++epCounter).padStart(3, "0")}`;
}

// ─── Route file → route path ──────────────────────────────────────────────────

/**
 * Converts app-router route.ts file path to the HTTP route.
 * Examples:
 *   app/api/users/route.ts              -> /api/users
 *   app/api/users/[userId]/route.ts     -> /api/users/:userId
 *   app/api/[...slug]/route.ts          -> /api/*
 *   app/(dashboard)/users/route.ts      -> /users (route group stripped)
 *   app/api/users/[userId]/orders/route.ts -> /api/users/:userId/orders
 */
function routeFileToPath(filePath: string, repoRoot: string): string {
  const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/");

  // Strip leading "app/" prefix (handle both "src/app/" and "app/")
  const appMatch = rel.match(/^(?:src\/)?app\/(.+)\/route\.[jt]sx?$/);
  if (!appMatch) return "/";

  const segments = appMatch[1].split("/").reduce<string[]>((acc, seg) => {
    // Strip route groups: (groupName)
    if (/^\(.*\)$/.test(seg)) return acc;
    // Catch-all: [...slug] → *
    if (/^\[\.\.\.(.+)\]$/.test(seg)) {
      acc.push("*");
      return acc;
    }
    // Dynamic: [param] → :param
    const dynMatch = seg.match(/^\[(.+)\]$/);
    if (dynMatch) {
      acc.push(`:${dynMatch[1]}`);
      return acc;
    }
    acc.push(seg);
    return acc;
  }, []);

  const routePath = "/" + segments.join("/");
  return routePath || "/";
}

function extractPathParamsFromRoute(route: string): PathParam[] {
  const params: PathParam[] = [];
  for (const seg of route.split("/")) {
    if (seg.startsWith(":")) {
      const name = seg.slice(1);
      params.push({ name, type: "string", example: `test-${name}` });
    }
  }
  return params;
}

// ─── HTTP method named export detection ──────────────────────────────────────

const VALID_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function extractExportedMethods(ast: TSESTree.Program): ExtractedEndpoint["method"][] {
  const methods: ExtractedEndpoint["method"][] = [];

  walk(ast, (node) => {
    // export async function GET(...) { ... }
    // export function POST(...) { ... }
    if (
      node.type === "ExportNamedDeclaration" &&
      node.declaration
    ) {
      const decl = node.declaration;
      if (
        (decl.type === "FunctionDeclaration" || decl.type === "TSDeclareFunction") &&
        decl.id?.type === "Identifier" &&
        VALID_HTTP_METHODS.has(decl.id.name)
      ) {
        methods.push(decl.id.name as ExtractedEndpoint["method"]);
      }
      // export const GET = async () => { ... }
      if (decl.type === "VariableDeclaration") {
        for (const decl2 of decl.declarations) {
          if (
            decl2.id.type === "Identifier" &&
            VALID_HTTP_METHODS.has(decl2.id.name)
          ) {
            methods.push(decl2.id.name as ExtractedEndpoint["method"]);
          }
        }
      }
    }
  });

  return methods;
}

// ─── Parameter, body, auth extraction ────────────────────────────────────────

interface RouteAnalysis {
  queryParams: QueryParam[];
  requestBody: RequestBodySchema | null;
  authRequired: boolean;
  authType: AuthType | null;
  pathParamsFromType: PathParam[];
}

const AUTH_RE = /getServerSession|getToken|withAuth|withSession|getSession/;
const COOKIES_AUTH_RE = /cookies\(\)/;

function analyzeRouteHandler(
  ast: TSESTree.Program,
  zodSchemas: Map<string, RequestBodySchema>
): RouteAnalysis {
  const queryParams: QueryParam[] = [];
  let requestBody: RequestBodySchema | null = null;
  let authRequired = false;
  let authType: AuthType | null = null;
  const pathParamsFromType: PathParam[] = [];

  // Track variable names assigned from `await request.json()` so we can
  // resolve second-hop destructuring: `const body = await req.json(); const { a, b } = body;`
  const jsonBodyVarNames = new Set<string>();

  walk(ast, (node) => {
    // Auth detection: getServerSession / getToken
    if (node.type === "CallExpression") {
      const callee = node.callee;
      let calleeName: string | null = null;
      if (callee.type === "Identifier") calleeName = callee.name;
      if (
        callee.type === "MemberExpression" &&
        callee.property.type === "Identifier"
      ) {
        calleeName = callee.property.name;
      }
      if (calleeName && AUTH_RE.test(calleeName)) {
        authRequired = true;
        authType = "next_auth";
      }
    }

    // Auth: cookies() usage
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      COOKIES_AUTH_RE.test(node.callee.name)
    ) {
      authRequired = true;
      if (!authType) authType = "session_cookie";
    }

    // Request body: const body = await request.json()  (simple identifier binding)
    // Record the variable name so we can resolve second-hop destructuring below.
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "AwaitExpression" &&
      node.init.argument.type === "CallExpression" &&
      node.init.argument.callee.type === "MemberExpression" &&
      node.init.argument.callee.property.type === "Identifier" &&
      node.init.argument.callee.property.name === "json"
    ) {
      jsonBodyVarNames.add((node.id as TSESTree.Identifier).name);
      if (!requestBody) {
        requestBody = { source: "inferred", fields: [], rawSchemaRef: null };
      }
    }

    // Request body: const { field } = await request.json()  (direct destructure)
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      node.init?.type === "AwaitExpression" &&
      node.init.argument.type === "CallExpression" &&
      node.init.argument.callee.type === "MemberExpression" &&
      node.init.argument.callee.property.type === "Identifier" &&
      node.init.argument.callee.property.name === "json"
    ) {
      requestBody = { source: "inferred", fields: [], rawSchemaRef: null };
      for (const prop of node.id.properties) {
        if (prop.type === "Property" && prop.key.type === "Identifier") {
          requestBody.fields.push({
            name: prop.key.name,
            type: "string",
            required: true,
            validators: [],
            example: null,
          });
        }
      }
    }

    // Request body: second-hop destructure — const { ids, readAll } = body
    // where `body` was previously assigned from `await request.json()`.
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      node.init?.type === "Identifier" &&
      jsonBodyVarNames.has((node.init as TSESTree.Identifier).name)
    ) {
      // Upgrade the inferred body with the actual field names
      if (!requestBody) {
        requestBody = { source: "inferred", fields: [], rawSchemaRef: null };
      }
      // Only populate if we have no fields yet (don't overwrite Zod-sourced fields)
      if (requestBody.fields.length === 0) {
        for (const prop of (node.id as TSESTree.ObjectPattern).properties) {
          if (prop.type === "Property" && prop.key.type === "Identifier") {
            requestBody.fields.push({
              name: prop.key.name,
              type: "string",
              required: false, // destructured without defaults → optional from route's perspective
              validators: [],
              example: null,
            });
          }
        }
      }
    }

    // Zod: schema.parse(body) or schema.safeParse(body)
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      (node.callee.property.name === "parse" || node.callee.property.name === "safeParse") &&
      node.callee.object.type === "Identifier"
    ) {
      const schemaName = node.callee.object.name;
      const zodSchema = zodSchemas.get(schemaName);
      if (zodSchema) requestBody = zodSchema;
    }

    // Query params: searchParams.get('page') / request.nextUrl.searchParams.get('page')
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "get" &&
      node.arguments.length > 0
    ) {
      const parent = node.callee.object;
      const isSearchParams =
        parent.type === "Identifier" && /searchParams/i.test(parent.name) ||
        (parent.type === "MemberExpression" &&
          parent.property.type === "Identifier" &&
          parent.property.name === "searchParams");
      if (isSearchParams) {
        const paramName = extractStringValue(node.arguments[0] as TSESTree.Node);
        if (paramName && !queryParams.find((q) => q.name === paramName)) {
          queryParams.push({ name: paramName, type: "string", required: false });
        }
      }
    }

    // Query params: Object.fromEntries(request.nextUrl.searchParams)
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      node.init?.type === "CallExpression" &&
      node.init.callee.type === "MemberExpression" &&
      node.init.callee.property.type === "Identifier" &&
      node.init.callee.property.name === "fromEntries"
    ) {
      for (const prop of node.id.properties) {
        if (prop.type === "Property" && prop.key.type === "Identifier") {
          const paramName = prop.key.name;
          if (!queryParams.find((q) => q.name === paramName)) {
            queryParams.push({ name: paramName, type: "string", required: false });
          }
        }
      }
    }

    // Path params from type annotation: { params }: { params: { userId: string } }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression"
    ) {
      for (const param of node.params) {
        // Looking for { params }: { params: { userId: string } }
        if (param.type === "ObjectPattern") {
          for (const prop of param.properties) {
            if (
              prop.type === "Property" &&
              prop.key.type === "Identifier" &&
              prop.key.name === "params" &&
              prop.value.type === "Identifier"
            ) {
              // Has params destructuring — try to get type from typeAnnotation
            }
          }
          // Check typeAnnotation on the pattern itself
          if (
            param.typeAnnotation?.typeAnnotation.type === "TSTypeLiteral"
          ) {
            for (const member of param.typeAnnotation.typeAnnotation.members) {
              if (
                member.type === "TSPropertySignature" &&
                member.key.type === "Identifier" &&
                member.key.name === "params" &&
                member.typeAnnotation?.typeAnnotation.type === "TSTypeLiteral"
              ) {
                for (const innerMember of member.typeAnnotation.typeAnnotation.members) {
                  if (
                    innerMember.type === "TSPropertySignature" &&
                    innerMember.key.type === "Identifier"
                  ) {
                    const paramName = innerMember.key.name;
                    let pType: PathParam["type"] = "string";
                    if (innerMember.typeAnnotation?.typeAnnotation.type === "TSNumberKeyword") {
                      pType = "number";
                    }
                    if (!pathParamsFromType.find((p) => p.name === paramName)) {
                      pathParamsFromType.push({
                        name: paramName,
                        type: pType,
                        example: pType === "number" ? "1" : `test-${paramName}`,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  return { queryParams, requestBody, authRequired, authType, pathParamsFromType };
}

// ─── Middleware matcher (shared logic) ────────────────────────────────────────

function extractMiddlewareMatchers(files: ParsedFile[]): string[] {
  const matchers: string[] = [];
  const middlewareFile = files.find((f) =>
    /[/\\]middleware\.(ts|js|tsx|jsx)$/.test(f.filePath) &&
    !f.filePath.includes("node_modules")
  );
  if (!middlewareFile) return matchers;

  walk(middlewareFile.ast, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === "config" &&
      node.init?.type === "ObjectExpression"
    ) {
      for (const prop of node.init.properties) {
        if (
          prop.type === "Property" &&
          prop.key.type === "Identifier" &&
          prop.key.name === "matcher"
        ) {
          if (prop.value.type === "ArrayExpression") {
            for (const el of prop.value.elements) {
              if (!el) continue;
              const val = extractStringValue(el as TSESTree.Node);
              if (val) matchers.push(val);
            }
          } else {
            const val = extractStringValue(prop.value as TSESTree.Node);
            if (val) matchers.push(val);
          }
        }
      }
    }
  });

  return matchers;
}

function routeMatchesPattern(route: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\//g, "\\/")
    .replace(/:\w+\*/g, ".*")
    .replace(/:\w+/g, "[^/]+")
    .replace(/\*/g, ".*");
  try {
    return new RegExp(`^${regexStr}`).test(route);
  } catch {
    return false;
  }
}

// ─── Next.js App Router Extractor ────────────────────────────────────────────

class NextJsAppExtractor implements IFrameworkExtractor {
  readonly framework = "nextjs" as const;

  canHandle(detection: PackageDetection): boolean {
    if (!detection.backendFrameworks.includes("nextjs")) return false;
    // Check if /app directory exists with any route.ts files
    const appDir = path.join(detection.rootPath, "app");
    const srcAppDir = path.join(detection.rootPath, "src", "app");
    const hasApp = fs.existsSync(appDir) || fs.existsSync(srcAppDir);
    if (!hasApp) return false;
    // Ensure at least one route file
    const checkDir = fs.existsSync(appDir) ? appDir : srcAppDir;
    try {
      const { execSync } = require("child_process") as typeof import("child_process");
      const result = execSync(`find "${checkDir}" -name "route.ts" -o -name "route.tsx" -o -name "route.js" 2>/dev/null | head -1`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      return result.length > 0;
    } catch {
      return false;
    }
  }

  async extract(
    files: ParsedFile[],
    detection: PackageDetection
  ): Promise<ExtractedEndpoint[]> {
    const endpoints: ExtractedEndpoint[] = [];
    const zodSchemas = extractZodSchemas(files);
    const middlewareMatchers = extractMiddlewareMatchers(files);

    // Filter to route.ts / route.tsx / route.js files under /app/
    const routeFiles = files.filter((f) => {
      const normalized = f.filePath.replace(/\\/g, "/");
      return (
        /\/app\/.*\/route\.[jt]sx?$/.test(normalized) &&
        !normalized.includes("node_modules")
      );
    });

    for (const pf of routeFiles) {
      const route = routeFileToPath(pf.filePath, detection.rootPath);
      const httpMethods = extractExportedMethods(pf.ast);

      if (httpMethods.length === 0) continue;

      const analysis = analyzeRouteHandler(pf.ast, zodSchemas);

      // Merge path params: from route string + from type annotations
      const routePathParams = extractPathParamsFromRoute(route);
      const mergedPathParams = [...routePathParams];
      for (const tp of analysis.pathParamsFromType) {
        const existing = mergedPathParams.find((p) => p.name === tp.name);
        if (existing) {
          // Upgrade type if we have better info from TypeScript
          if (tp.type !== "string") existing.type = tp.type;
        } else {
          mergedPathParams.push(tp);
        }
      }

      // Middleware auth
      let authRequired = analysis.authRequired;
      let authType: AuthType | null = analysis.authType;
      for (const matcher of middlewareMatchers) {
        if (routeMatchesPattern(route, matcher)) {
          authRequired = true;
          if (!authType) authType = "session_cookie";
          break;
        }
      }

      const isWildcard = route.endsWith("*");
      const isDynamic = route.includes(":");
      const flags: ExtractorFlag[] = [];
      if (isWildcard) flags.push("WILDCARD_HANDLER");
      if (isDynamic) flags.push("DYNAMIC_PATH");

      let confidence = 0.85;
      if (isWildcard) confidence -= 0.1;

      // HTTP methods that never carry a request body (per RFC 7231)
      const NO_BODY_METHODS = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);
      // HTTP methods that typically don't use URL query params (body is the intent vehicle)
      const BODY_PRIMARY_METHODS = new Set(["POST", "PUT", "PATCH"]);

      for (const method of httpMethods) {
        endpoints.push({
          id: nextId(),
          method,
          path: route,
          pathParams: mergedPathParams,
          // GET/HEAD/DELETE/OPTIONS must not show request body fields — they carry no body.
          // requestBody from file-level analysis comes from POST/PUT/PATCH Zod schemas which
          // would bleed onto sibling GET handlers if not filtered here.
          queryParams: BODY_PRIMARY_METHODS.has(method) ? [] : analysis.queryParams,
          requestBody: NO_BODY_METHODS.has(method) ? null : analysis.requestBody,
          responseSchema: null,
          authRequired,
          authType,
          roles: [],
          sourceFile: pf.filePath,
          sourceLine: 1,
          framework: "nextjs",
          confidence,
          flags,
        });
      }
    }

    return endpoints;
  }
}

export const nextjsAppExtractor = new NextJsAppExtractor();
