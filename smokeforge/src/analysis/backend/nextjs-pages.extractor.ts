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

// ─── Counters ─────────────────────────────────────────────────────────────────

let epCounter = 0;
function nextId(): string {
  return `nextpages_ep_${String(++epCounter).padStart(3, "0")}`;
}

// ─── File → route path mapping ────────────────────────────────────────────────

/**
 * Converts a /pages/api/** file path to an API route path.
 * /pages/api/users.ts              → /api/users
 * /pages/api/users/[id].ts         → /api/users/:id
 * /pages/api/users/[id]/orders.ts  → /api/users/:id/orders
 * /pages/api/[...slug].ts          → /api/*
 * /pages/api/users/index.ts        → /api/users
 */
function filePathToRoute(filePath: string, repoRoot: string): string {
  // Get relative path from repo root
  const rel = path.relative(repoRoot, filePath);
  // Normalize separators
  const normalized = rel.replace(/\\/g, "/");
  // Strip /pages/api prefix and extension
  const withoutPages = normalized.replace(/^.*\/pages\/api\//, "");
  const withoutExt = withoutPages.replace(/\.(ts|tsx|js|jsx)$/, "");
  // Handle index files
  const cleaned = withoutExt.replace(/\/index$/, "").replace(/^index$/, "");

  const segments = cleaned.split("/").map((seg) => {
    // Catch-all: [...slug] → *
    if (/^\[\.\.\.(.+)\]$/.test(seg)) return "*";
    // Dynamic: [id] → :id
    const dynMatch = seg.match(/^\[(.+)\]$/);
    if (dynMatch) return `:${dynMatch[1]}`;
    return seg;
  });

  return "/api/" + segments.join("/").replace(/\/+$/, "");
}

function extractPathParamsFromRoute(route: string): PathParam[] {
  const params: PathParam[] = [];
  for (const seg of route.split("/")) {
    if (seg.startsWith(":")) {
      const name = seg.slice(1).replace(/[?*+]$/, "");
      params.push({ name, type: "string", example: `test-${name}` });
    }
  }
  return params;
}

// ─── Method detection ─────────────────────────────────────────────────────────

type HttpMethod = ExtractedEndpoint["method"];

interface MethodDetectionResult {
  methods: HttpMethod[];
  isNextConnect: boolean;
  authRequired: boolean;
  authType: AuthType | null;
  queryParams: QueryParam[];
  requestBody: RequestBodySchema | null;
  flags: ExtractorFlag[];
}

const AUTH_WRAPPER_RE = /withAuth|withSession|authenticate|requireAuth|withProtect|withGuard|isAuthenticated|requireLogin/i;
const GET_SERVER_SESSION_RE = /getServerSession|getSession|withIronSession/i;

function detectMethods(ast: TSESTree.Program, zodSchemas: Map<string, RequestBodySchema>): MethodDetectionResult {
  const methods = new Set<HttpMethod>();
  let authRequired = false;
  let authType: AuthType | null = null;
  const flags: ExtractorFlag[] = [];
  const queryParams: QueryParam[] = [];
  let requestBody: RequestBodySchema | null = null;

  // Check for next-connect usage
  let isNextConnect = false;
  const nextConnectMethods: HttpMethod[] = [];

  walk(ast, (node) => {
    // Pattern 5: next-connect handler.get/post/etc.
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier"
    ) {
      const method = node.callee.property.name.toUpperCase();
      if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
        // Check if object is nc() or handler (next-connect pattern)
        if (node.callee.object.type === "Identifier") {
          const objName = node.callee.object.name;
          if (/handler|router|nc|api/i.test(objName)) {
            nextConnectMethods.push(method as HttpMethod);
            isNextConnect = true;
          }
        }
      }
    }

    // Pattern 1: switch(req.method) { case 'GET': ... }
    if (node.type === "SwitchStatement") {
      const disc = node.discriminant;
      if (
        disc.type === "MemberExpression" &&
        disc.property.type === "Identifier" &&
        disc.property.name === "method"
      ) {
        for (const cas of node.cases) {
          if (cas.test) {
            const val = extractStringValue(cas.test as TSESTree.Node);
            if (val && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(val)) {
              methods.add(val as HttpMethod);
            }
          }
        }
      }
    }

    // Pattern 2: if (req.method === 'GET') / if (req.method !== 'GET')
    if (node.type === "IfStatement") {
      const test = node.test;
      if (
        test.type === "BinaryExpression" &&
        (test.operator === "===" || test.operator === "!==" || test.operator === "==" || test.operator === "!=")
      ) {
        let methodVal: string | null = null;
        if (
          test.left.type === "MemberExpression" &&
          test.left.property.type === "Identifier" &&
          test.left.property.name === "method"
        ) {
          methodVal = extractStringValue(test.right as TSESTree.Node);
        } else if (
          test.right.type === "MemberExpression" &&
          test.right.property.type === "Identifier" &&
          test.right.property.name === "method"
        ) {
          methodVal = extractStringValue(test.left as TSESTree.Node);
        }
        if (methodVal && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(methodVal)) {
          methods.add(methodVal as HttpMethod);
        }
      }
    }

    // Pattern 3: const handlers = { GET: fn, POST: fn }
    if (node.type === "VariableDeclarator") {
      if (
        node.id.type === "Identifier" &&
        /handlers?/i.test(node.id.name) &&
        node.init?.type === "ObjectExpression"
      ) {
        for (const prop of node.init.properties) {
          if (
            prop.type === "Property" &&
            prop.key.type === "Identifier"
          ) {
            const m = prop.key.name.toUpperCase();
            if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(m)) {
              methods.add(m as HttpMethod);
            }
          }
        }
      }
    }

    // Auth: higher-order wrappers in export default
    if (
      node.type === "ExportDefaultDeclaration" ||
      node.type === "ExpressionStatement"
    ) {
      const decl = node.type === "ExportDefaultDeclaration" ? node.declaration : node.expression;
      if (decl.type === "CallExpression" && decl.callee.type === "Identifier") {
        if (AUTH_WRAPPER_RE.test(decl.callee.name)) {
          authRequired = true;
        }
      }
    }

    // Auth: getServerSession usage
    if (
      node.type === "VariableDeclarator" &&
      node.init?.type === "AwaitExpression" &&
      node.init.argument.type === "CallExpression"
    ) {
      const callee = node.init.argument.callee;
      if (callee.type === "Identifier" && GET_SERVER_SESSION_RE.test(callee.name)) {
        authRequired = true;
        authType = "next_auth";
      }
    }

    // Query params: req.query.xxx or const { x } = req.query
    if (
      node.type === "MemberExpression" &&
      node.object.type === "MemberExpression" &&
      node.object.property.type === "Identifier" &&
      node.object.property.name === "query" &&
      node.property.type === "Identifier"
    ) {
      const paramName = node.property.name;
      if (!queryParams.find((q) => q.name === paramName)) {
        queryParams.push({ name: paramName, type: "string", required: false });
      }
    }

    // Body fields: req.body.xxx
    if (
      node.type === "MemberExpression" &&
      node.object.type === "MemberExpression" &&
      node.object.property.type === "Identifier" &&
      node.object.property.name === "body" &&
      node.property.type === "Identifier"
    ) {
      const fieldName = node.property.name;
      if (!requestBody) {
        requestBody = {
          source: "inferred",
          fields: [],
          rawSchemaRef: null,
        };
      }
      if (!requestBody.fields.find((f) => f.name === fieldName)) {
        requestBody.fields.push({
          name: fieldName,
          type: "string",
          required: false,
          validators: [],
          example: null,
        });
      }
    }

    // Body destructuring: const { email, password } = req.body
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      node.init?.type === "MemberExpression" &&
      node.init.property.type === "Identifier" &&
      node.init.property.name === "body"
    ) {
      if (!requestBody) {
        requestBody = { source: "inferred", fields: [], rawSchemaRef: null };
      }
      for (const prop of node.id.properties) {
        if (prop.type === "Property" && prop.key.type === "Identifier") {
          const fieldName = prop.key.name;
          if (!requestBody.fields.find((f) => f.name === fieldName)) {
            requestBody.fields.push({
              name: fieldName,
              type: "string",
              required: true,
              validators: [],
              example: null,
            });
          }
        } else if (prop.type === "RestElement" && prop.argument.type === "Identifier") {
          // skip rest elements
        }
      }
    }

    // Query destructuring: const { id } = req.query
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      node.init?.type === "MemberExpression" &&
      node.init.property.type === "Identifier" &&
      node.init.property.name === "query"
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

    // Zod schema.parse(req.body) detection
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      (node.callee.property.name === "parse" || node.callee.property.name === "safeParse") &&
      node.arguments.length > 0
    ) {
      const firstArg = node.arguments[0];
      if (
        firstArg.type === "MemberExpression" &&
        firstArg.property.type === "Identifier" &&
        firstArg.property.name === "body"
      ) {
        // Try to match schema variable name
        if (node.callee.object.type === "Identifier") {
          const schemaName = node.callee.object.name;
          const zodSchema = zodSchemas.get(schemaName);
          if (zodSchema) requestBody = zodSchema;
        }
      }
    }
  });

  if (isNextConnect && nextConnectMethods.length > 0) {
    for (const m of nextConnectMethods) methods.add(m);
  }

  // Pattern 4: no method detected → ALL
  if (methods.size === 0 && !isNextConnect) {
    methods.add("ALL");
    flags.push("WILDCARD_HANDLER");
  }

  return {
    methods: Array.from(methods),
    isNextConnect,
    authRequired,
    authType,
    queryParams,
    requestBody,
    flags,
  };
}

// ─── Middleware matcher auth ──────────────────────────────────────────────────

/**
 * Check middleware.ts / middleware.js for matcher config. Returns list of
 * path patterns that require auth.
 */
function extractMiddlewareMatchers(files: ParsedFile[]): string[] {
  const matchers: string[] = [];

  const middlewareFile = files.find((f) =>
    /[/\\]middleware\.(ts|js|tsx|jsx)$/.test(f.filePath) &&
    !f.filePath.includes("node_modules")
  );
  if (!middlewareFile) return matchers;

  walk(middlewareFile.ast, (node) => {
    // export const config = { matcher: ['/api/...'] }
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
  // Convert Next.js matcher pattern to a basic regex
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

// ─── Next.js Pages Router Extractor ──────────────────────────────────────────

class NextJsPagesExtractor implements IFrameworkExtractor {
  readonly framework = "nextjs" as const;

  canHandle(detection: PackageDetection): boolean {
    if (!detection.backendFrameworks.includes("nextjs")) return false;
    // Check if /pages/api directory exists
    const pagesApiDir = path.join(detection.rootPath, "pages", "api");
    return fs.existsSync(pagesApiDir);
  }

  async extract(
    files: ParsedFile[],
    detection: PackageDetection
  ): Promise<ExtractedEndpoint[]> {
    const endpoints: ExtractedEndpoint[] = [];

    // Build zod schema registry for the repo
    const zodSchemas = extractZodSchemas(files);

    // Find middleware matchers for auth
    const middlewareMatchers = extractMiddlewareMatchers(files);

    // Filter to only /pages/api/** files
    const pagesApiDir = path.join(detection.rootPath, "pages", "api");
    const apiFiles = files.filter((f) => {
      const normalized = f.filePath.replace(/\\/g, "/");
      return normalized.includes("/pages/api/");
    });

    // Also handle when rootPath has pages/api
    const pagesApiFiles = apiFiles.length > 0
      ? apiFiles
      : files.filter((f) => f.filePath.startsWith(pagesApiDir));

    for (const pf of pagesApiFiles) {
      const route = filePathToRoute(pf.filePath, detection.rootPath);
      const pathParams = extractPathParamsFromRoute(route);

      const { methods, authRequired: fileAuth, authType: fileAuthType, queryParams, requestBody, flags } =
        detectMethods(pf.ast, zodSchemas);

      // Check middleware-based auth
      let authRequired = fileAuth;
      let authType: AuthType | null = fileAuthType;
      for (const matcher of middlewareMatchers) {
        if (routeMatchesPattern(route, matcher)) {
          authRequired = true;
          if (!authType) authType = "session_cookie";
          break;
        }
      }

      const isWildcard = route.endsWith("*");
      const isDynamic = route.includes(":");

      let confidence = 0.80;
      if (isWildcard) confidence -= 0.1;
      if (!authRequired && methods.some((m) => ["POST", "PUT", "DELETE"].includes(m))) {
        confidence -= 0.05;
      }

      for (const method of methods) {
        endpoints.push({
          id: nextId(),
          method,
          path: route,
          pathParams,
          queryParams,
          requestBody,
          responseSchema: null,
          authRequired,
          authType,
          roles: [],
          sourceFile: pf.filePath,
          sourceLine: 1,
          framework: "nextjs",
          confidence,
          flags: [
            ...flags,
            ...(isDynamic ? (["DYNAMIC_PATH"] as ExtractorFlag[]) : []),
          ],
        });
      }
    }

    return endpoints;
  }
}

export const nextjsPagesExtractor = new NextJsPagesExtractor();
