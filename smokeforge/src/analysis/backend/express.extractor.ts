import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { IFrameworkExtractor } from "./index";
import type { ParsedFile } from "../parser";
import { parseFile } from "../parser";
import type { PackageDetection } from "../../ingestion/detector";
import type {
  ExtractedEndpoint,
  PathParam,
  QueryParam,
  ExtractorFlag,
} from "../../blueprint/types";
import {
  walk,
  extractStringValue,
  collectImports,
  extractRequirePath,
} from "../../utils/ast-utils";
import { resolveImportPath } from "../../utils/file-utils";
import { extractZodSchemas } from "../schemas/zod.extractor";
import { extractTypeScriptTypes } from "../schemas/typescript-types.extractor";

// ─── Constants ────────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "all",
]);

const AUTH_MIDDLEWARE_RE = /auth|authenticate|requireauth|passport|protect|verify|jwt|bearer/i;
const ROLE_MIDDLEWARE_RE = /role|authorize|permission|access/i;
const UPLOAD_MIDDLEWARE_RE = /upload|multer|multipart/i;
const ROUTER_CREATOR_RE = /Router|router/;

let epCounter = 0;
function nextId(): string {
  return `ep_${String(++epCounter).padStart(3, "0")}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePath(...parts: string[]): string {
  const joined = parts.join("/").replace(/\/+/g, "/");
  return joined.startsWith("/") ? joined : "/" + joined;
}

function extractParamsFromPath(path: string): PathParam[] {
  const params: PathParam[] = [];
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg.startsWith(":")) {
      const name = seg.slice(1).replace(/[?*+]$/, "");
      params.push({ name, type: "string", example: `test-${name}` });
    }
  }
  return params;
}

function methodFromString(s: string): ExtractedEndpoint["method"] {
  const up = s.toUpperCase() as ExtractedEndpoint["method"];
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"].includes(up) ? up : "GET";
}

/**
 * Walk a route handler function body and extract query param names from
 * `req.query` / `request.query` destructuring patterns.
 *
 * Handles:
 *   const { page = '1', limit = '50', userId } = req.query;
 *   const { page = '1' } = req.query as Record<string, string>;
 */
function extractQueryParamsFromHandler(handlerNode: TSESTree.Node): QueryParam[] {
  const params: QueryParam[] = [];

  // The handler may be ArrowFunctionExpression, FunctionExpression, or Identifier.
  // For Identifier (named function), we can't resolve it statically here — skip.
  const getBody = (node: TSESTree.Node): TSESTree.Node | null => {
    if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
      return (node as TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression).body;
    }
    return null;
  };

  const handlerBody = getBody(handlerNode);
  if (!handlerBody) return params;

  // Unwrap TSAsExpression to get the real expression
  function unwrap(node: TSESTree.Node): TSESTree.Node {
    if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") {
      return unwrap((node as TSESTree.TSAsExpression).expression);
    }
    return node;
  }

  // Check if a node is `req.query` or `request.query`
  function isReqQuery(node: TSESTree.Node): boolean {
    const inner = unwrap(node);
    if (inner.type !== "MemberExpression") return false;
    const me = inner as TSESTree.MemberExpression;
    const obj = me.object;
    const prop = me.property;
    if (obj.type !== "Identifier") return false;
    if (prop.type !== "Identifier") return false;
    const objName = (obj as TSESTree.Identifier).name;
    const propName = (prop as TSESTree.Identifier).name;
    return (objName === "req" || objName === "request") && propName === "query";
  }

  walk(handlerBody, (node) => {
    if (node.type !== "VariableDeclaration") return;
    const decl = node as TSESTree.VariableDeclaration;
    for (const declarator of decl.declarations) {
      if (!declarator.init) continue;
      if (!isReqQuery(declarator.init)) continue;
      // Found: const { ... } = req.query
      const id = declarator.id;
      if (id.type !== "ObjectPattern") continue;
      const op = id as TSESTree.ObjectPattern;
      for (const prop of op.properties) {
        if (prop.type !== "Property") continue;
        const p = prop as TSESTree.Property;
        // Key is the param name
        if (p.key.type !== "Identifier") continue;
        const name = (p.key as TSESTree.Identifier).name;
        // Value may be AssignmentPattern (has default) or Identifier (no default)
        let defaultValue: unknown;
        let required = true;
        if (p.value.type === "AssignmentPattern") {
          const ap = p.value as TSESTree.AssignmentPattern;
          required = false;
          if (ap.right.type === "Literal") {
            defaultValue = (ap.right as TSESTree.Literal).value;
          }
        } else {
          required = false; // query params are generally optional
        }
        // Infer type from name heuristics
        let type = "string";
        if (/^(page|limit|offset|skip|take|size|count|num|max|min)$/i.test(name)) {
          type = "number";
        } else if (/Id$/i.test(name)) {
          type = "uuid";
        } else if (/^(is[A-Z]|has[A-Z]|active|enabled|deleted|archived)/i.test(name)) {
          type = "boolean";
        }
        params.push({ name, type, required, ...(defaultValue !== undefined ? { default: defaultValue } : {}) });
      }
    }
  });

  return params;
}

function identifierNamesFromArgs(args: TSESTree.Node[]): string[] {
  const names: string[] = [];
  for (const arg of args) {
    if (arg.type === "Identifier") names.push((arg as TSESTree.Identifier).name);
    else if (arg.type === "CallExpression") {
      const callee = (arg as TSESTree.CallExpression).callee;
      if (callee.type === "Identifier") names.push(callee.name);
      else if (
        callee.type === "MemberExpression" &&
        callee.property.type === "Identifier"
      ) {
        // Push both object name (e.g. "upload" from upload.single) and method name
        if (callee.object.type === "Identifier") {
          names.push(callee.object.name);
        }
        names.push(callee.property.name);
      }
    }
  }
  return names;
}

/**
 * Walk a chained CallExpression like router.route('/path').get(h1).post(h2)
 * to find the base .route('/path') call and return its path string, or null.
 */
function findRoutePathInChain(callNode: TSESTree.CallExpression): string | null {
  const callee = callNode.callee;
  if (callee.type !== "MemberExpression") return null;
  if (callee.property.type !== "Identifier") return null;
  if (callee.property.name === "route") {
    if (callNode.arguments.length >= 1) {
      return extractStringValue(callNode.arguments[0] as TSESTree.Node);
    }
    return null;
  }
  // Recurse into the chained object
  if (callee.object.type === "CallExpression") {
    return findRoutePathInChain(callee.object as TSESTree.CallExpression);
  }
  return null;
}

function extractRolesFromMiddleware(middlewareNames: string[]): string[] {
  // Heuristic: if middleware argument list contained string literals from a requireRole call
  return middlewareNames
    .filter((n) => n.startsWith("__role__:"))
    .map((n) => n.replace("__role__:", ""));
}

// ─── Phase A: Build Router Graph ─────────────────────────────────────────────

function buildRouterGraph(
  file: ParsedFile,
  allParsed: Map<string, ParsedFile>,
  prefixContext: Map<string, string[]>,
  visited: Set<string>,
  depth: number
): Map<string, string[]> {
  if (depth > 5 || visited.has(file.filePath)) return prefixContext;
  visited.add(file.filePath);

  const imports = collectImports(file.ast);

  // Map: localName → resolved file path (for import-based resolution)
  const importedRouters = new Map<string, string>();
  for (const imp of imports) {
    const src = imp.source.value as string;
    if (!src.startsWith(".")) continue;
    const resolved = resolveImportPath(src, file.filePath);
    if (!resolved) continue;
    for (const spec of imp.specifiers) {
      importedRouters.set(spec.local.name, resolved);
    }
  }

  walk(file.ast, (node) => {
    if (node.type !== "ExpressionStatement") return;
    const expr = (node as TSESTree.ExpressionStatement).expression;
    if (expr.type !== "CallExpression") return;
    const call = expr as TSESTree.CallExpression;
    const callee = call.callee;
    if (callee.type !== "MemberExpression") return;
    const prop = callee.property;
    if (prop.type !== "Identifier") return;
    if (prop.name !== "use") return;

    // app.use(prefix, router) or app.use(router)
    const args = call.arguments as TSESTree.Node[];
    if (args.length < 1) return;

    let prefix: string | null = null;
    let routerArgNode: TSESTree.Node | null = null;

    if (args.length >= 2) {
      const firstStr = extractStringValue(args[0] as TSESTree.Node);
      if (firstStr !== null) {
        prefix = firstStr;
        routerArgNode = args[1] as TSESTree.Node;
      }
    }

    if (!routerArgNode) return;

    let routerName: string | null = null;

    // Identifier reference
    if (routerArgNode.type === "Identifier") {
      routerName = (routerArgNode as TSESTree.Identifier).name;
    }
    // require('./routes')
    else if (routerArgNode.type === "CallExpression") {
      const reqPath = extractRequirePath(routerArgNode as TSESTree.CallExpression);
      if (reqPath && reqPath.startsWith(".")) {
        const resolved = resolveImportPath(reqPath, file.filePath);
        if (resolved) {
          const targetFile = allParsed.get(resolved) ?? parseFile(resolved);
          if (targetFile) {
            if (!allParsed.has(resolved)) allParsed.set(resolved, targetFile);
            if (prefix) {
              const existing = prefixContext.get(resolved) ?? [];
              if (!existing.includes(prefix)) {
                prefixContext.set(resolved, [...existing, prefix]);
              }
            }
            buildRouterGraph(targetFile, allParsed, prefixContext, visited, depth + 1);
          }
        }
        return;
      }
    }

    if (routerName && prefix) {
      // Resolve through import
      const importedPath = importedRouters.get(routerName);
      if (importedPath) {
        const existing = prefixContext.get(importedPath) ?? [];
        if (!existing.includes(prefix)) {
          prefixContext.set(importedPath, [...existing, prefix]);
        }
        const targetFile = allParsed.get(importedPath) ?? parseFile(importedPath);
        if (targetFile) {
          if (!allParsed.has(importedPath)) allParsed.set(importedPath, targetFile);
          buildRouterGraph(targetFile, allParsed, prefixContext, visited, depth + 1);
        }
      } else {
        // Same-file router variable
        const existing = prefixContext.get(`${file.filePath}::${routerName}`) ?? [];
        if (!existing.includes(prefix)) {
          prefixContext.set(`${file.filePath}::${routerName}`, [...existing, prefix]);
        }
      }
    }
  });

  return prefixContext;
}

// ─── Phase B + C + D + E: Extract routes ─────────────────────────────────────

function extractRoutesFromFile(
  file: ParsedFile,
  prefixContext: Map<string, string[]>,
  zodRegistry: ReturnType<typeof extractZodSchemas>,
  tsRegistry: ReturnType<typeof extractTypeScriptTypes>
): ExtractedEndpoint[] {
  const endpoints: ExtractedEndpoint[] = [];
  let isInsideConditional = false;

  // Collect router variable names declared in this file
  const routerVars = new Set<string>();
  walk(file.ast, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const decl = node as TSESTree.VariableDeclarator;
    if (decl.id.type !== "Identifier") return;
    const init = decl.init;
    if (!init) return;
    // express.Router() or Router()
    if (
      init.type === "CallExpression" &&
      ((init.callee as TSESTree.Node).type === "MemberExpression" ||
        ((init.callee as TSESTree.Node).type === "Identifier" &&
          ROUTER_CREATOR_RE.test(((init.callee as TSESTree.Identifier).name))))
    ) {
      routerVars.add(decl.id.name);
    }
  });

  // Track global auth flag for this file (app.use(auth) before routes)
  let globalAuthRequired = false;

  walk(file.ast, (node) => {
    // Track conditional context
    if (node.type === "IfStatement") {
      isInsideConditional = true;
    }

    if (node.type !== "ExpressionStatement") return;
    const expr = (node as TSESTree.ExpressionStatement).expression;
    if (expr.type !== "CallExpression") return;
    const call = expr as TSESTree.CallExpression;
    const callee = call.callee;
    if (callee.type !== "MemberExpression") return;
    const prop = callee.property;
    if (prop.type !== "Identifier") return;

    const methodName = prop.name.toLowerCase();
    const objNode = callee.object;
    const objName =
      objNode.type === "Identifier" ? (objNode as TSESTree.Identifier).name : null;

    const args = call.arguments as TSESTree.Node[];

    // Handle app.use(middleware) — global auth signal
    if (methodName === "use" && args.length === 1) {
      const singleArg = args[0];
      const argName =
        singleArg.type === "Identifier"
          ? (singleArg as TSESTree.Identifier).name
          : "";
      if (AUTH_MIDDLEWARE_RE.test(argName)) {
        globalAuthRequired = true;
      }
      return;
    }

    // Handle router.route('/path').get().post()
    if (methodName === "route" && args.length >= 1) {
      const routePath = extractStringValue(args[0] as TSESTree.Node);
      if (routePath === null) return;
      // The chained calls on the result (.get(), .post()) are CallExpressions
      // We handle them by inspecting the parent call chain
      return;
    }

    if (!HTTP_METHODS.has(methodName)) return;

    // Determine if this is on a known router/app variable
    if (objName && !routerVars.has(objName) && objName !== "app" && objName !== "router") {
      // Could be chained from router.route('/path').get(...)
      // Check if the object is a CallExpression ending in .route()
      if (
        objNode.type === "CallExpression" ||
        objNode.type === "MemberExpression"
      ) {
        // Allow chained calls
      } else {
        return;
      }
    }

    // Extract path — first string argument
    if (args.length < 1) return;
    const rawPath = extractStringValue(args[0] as TSESTree.Node);

    // Determine flags
    const flags: ExtractorFlag[] = [];
    let isDynamic = false;
    let extractedPath = rawPath;
    // Track whether path came from a chained .route() call (so args[0] is NOT the path)
    let pathFromChain = false;

    if (rawPath === null) {
      // Could be a template literal
      if (args[0].type === "TemplateLiteral") {
        isDynamic = true;
        flags.push("DYNAMIC_PATH");
        extractedPath = "/dynamic-path";
      } else if (objNode.type === "CallExpression") {
        // Could be chained: router.route('/path').get(h) or .route('/path').get(h1).post(h2)
        const chainPath = findRoutePathInChain(objNode as TSESTree.CallExpression);
        if (chainPath !== null) {
          extractedPath = chainPath;
          pathFromChain = true;
        } else {
          return;
        }
      } else {
        return;
      }
    }

    if (isInsideConditional) flags.push("CONDITIONAL_ROUTE");

    // Phase D: Middleware analysis (args[1..n-1] are middleware, last arg is handler)
    // When path came from a chained .route() call, args[0] is already middleware/handler (no path arg)
    const pathOffset = pathFromChain ? 0 : 1;
    const middlewareArgs = args.slice(pathOffset, Math.max(pathOffset, args.length - 1));
    const middlewareNames = identifierNamesFromArgs(middlewareArgs);

    // Collect role args from requireRole(['admin']) style
    const roleMiddlewareNames: string[] = [];
    for (const arg of middlewareArgs) {
      if (arg.type === "CallExpression") {
        const mcallee = (arg as TSESTree.CallExpression).callee;
        const mname =
          mcallee.type === "Identifier"
            ? mcallee.name
            : mcallee.type === "MemberExpression" && mcallee.property.type === "Identifier"
            ? mcallee.property.name
            : "";
        if (ROLE_MIDDLEWARE_RE.test(mname)) {
          // Extract role string args
          for (const rarg of (arg as TSESTree.CallExpression).arguments as TSESTree.Node[]) {
            if (rarg.type === "ArrayExpression") {
              for (const el of (rarg as TSESTree.ArrayExpression).elements) {
                if (!el) continue;
                const v = extractStringValue(el as TSESTree.Node);
                if (v) roleMiddlewareNames.push(`__role__:${v}`);
              }
            } else {
              const v = extractStringValue(rarg as TSESTree.Node);
              if (v) roleMiddlewareNames.push(`__role__:${v}`);
            }
          }
        }
      }
    }

    const allMiddlewareNames = [...middlewareNames, ...roleMiddlewareNames];
    const authRequired =
      globalAuthRequired ||
      allMiddlewareNames.some(
        (n) => AUTH_MIDDLEWARE_RE.test(n) && !n.startsWith("__role__:")
      );

    if (allMiddlewareNames.some((n) => UPLOAD_MIDDLEWARE_RE.test(n))) {
      flags.push("FILE_UPLOAD");
    }

    const roles = extractRolesFromMiddleware(allMiddlewareNames);

    // Phase C: Resolve full path using prefix context
    let filePrefix = "";
    // Check same-file prefix key
    const varPrefix = objName
      ? prefixContext.get(`${file.filePath}::${objName}`)
      : null;
    if (varPrefix && varPrefix.length > 0) {
      filePrefix = varPrefix.join("");
    }
    // Check file-level prefix (for cross-file mounted routers)
    const fileLevel = prefixContext.get(file.filePath);
    if (fileLevel && fileLevel.length > 0 && !filePrefix) {
      filePrefix = fileLevel.join("");
    }

    const fullPath = normalizePath(filePrefix, extractedPath ?? "");

    // Phase E: Extract path params
    const pathParams = extractParamsFromPath(fullPath);

    // Look up Zod or TS schema for params
    for (const p of pathParams) {
      // Check if any middleware has validateParams(z.object({[p.name]: z.string().uuid()}))
      // We use a simple heuristic: if uuid is in the param name, set type to uuid
      if (/id$/i.test(p.name)) {
        p.type = "uuid";
        p.example = "11111111-2222-3333-4444-555555555555";
      } else if (/num|count|page|limit|index/i.test(p.name)) {
        p.type = "number";
        p.example = "1";
      }
    }

    // Resolve requestBody from middleware schema references
    let requestBody = null;
    for (const marg of middlewareArgs) {
      if (marg.type === "CallExpression") {
        const mcallArgs = (marg as TSESTree.CallExpression).arguments as TSESTree.Node[];
        for (const carg of mcallArgs) {
          if (carg.type === "Identifier") {
            const schemaName = (carg as TSESTree.Identifier).name;
            const zodSchema = zodRegistry.get(schemaName);
            if (zodSchema) {
              requestBody = zodSchema;
              break;
            }
            const tsSchema = tsRegistry.get(schemaName);
            if (tsSchema) {
              requestBody = tsSchema;
              break;
            }
          }
        }
      }
    }

    const method = methodFromString(methodName);

    // GET/DELETE/HEAD/OPTIONS never have a request body — clear any body
    // picked up from Zod middleware validate() wrappers that are also used
    // for query-param validation in some codebases.
    const NO_BODY_METHODS = new Set(["GET", "DELETE", "HEAD", "OPTIONS"]);
    if (NO_BODY_METHODS.has(method)) {
      requestBody = null;
    }

    const sourceLine =
      (node as { loc?: { start: { line: number } } }).loc?.start.line ?? 0;

    // Extract query params from the route handler body (last argument)
    const handlerArg = args.length > 0 ? args[args.length - 1] : null;
    const queryParams = handlerArg ? extractQueryParamsFromHandler(handlerArg as TSESTree.Node) : [];

    endpoints.push({
      id: nextId(),
      method,
      path: fullPath,
      pathParams,
      queryParams,
      requestBody,
      responseSchema: null,
      authRequired,
      authType: authRequired ? "bearer_jwt" : null,
      roles,
      sourceFile: file.filePath,
      sourceLine,
      framework: "express",
      confidence: isDynamic ? 0.6 : 0.8,
      flags,
    });

    // For chained routes (.route('/path').get(h1).post(h2)), the walk only sees the
    // outermost call as an ExpressionStatement. Traverse objNode to emit inner methods.
    if (pathFromChain) {
      const emitChained = (chainNode: TSESTree.CallExpression): void => {
        const cc = chainNode.callee;
        if (cc.type !== "MemberExpression" || cc.property.type !== "Identifier") return;
        const cmn = cc.property.name.toLowerCase();
        if (cmn === "route") return; // reached the base .route() call
        if (HTTP_METHODS.has(cmn)) {
          endpoints.push({
            id: nextId(),
            method: methodFromString(cmn),
            path: fullPath,
            pathParams: [...pathParams],
            queryParams: [],
            requestBody: null,
            responseSchema: null,
            authRequired,
            authType: authRequired ? "bearer_jwt" : null,
            roles: [...roles],
            sourceFile: file.filePath,
            sourceLine,
            framework: "express",
            confidence: 0.75,
            flags: [...flags],
          });
        }
        if (cc.object.type === "CallExpression") {
          emitChained(cc.object as TSESTree.CallExpression);
        }
      };
      emitChained(objNode as TSESTree.CallExpression);
    }
  });

  return endpoints;
}

// ─── Extractor class ──────────────────────────────────────────────────────────

export class ExpressExtractor implements IFrameworkExtractor {
  readonly framework = "express" as const;

  canHandle(detection: PackageDetection): boolean {
    return detection.backendFrameworks.includes("express");
  }

  async extract(
    files: ParsedFile[],
    _detection: PackageDetection
  ): Promise<ExtractedEndpoint[]> {
    const allParsed = new Map<string, ParsedFile>(
      files.map((f) => [f.filePath, f])
    );
    const prefixContext = new Map<string, string[]>();
    const visited = new Set<string>();

    // Phase A: Build router graph for all files
    for (const file of files) {
      buildRouterGraph(file, allParsed, prefixContext, visited, 0);
    }

    // Build schema registries across all files
    const zodRegistry = extractZodSchemas(files);
    const tsRegistry = extractTypeScriptTypes(files);

    // Phase B-E: Extract routes from each file
    const all: ExtractedEndpoint[] = [];
    for (const file of allParsed.values()) {
      const routes = extractRoutesFromFile(
        file,
        prefixContext,
        zodRegistry,
        tsRegistry
      );
      all.push(...routes);
    }

    // Deduplicate by method + path, keep highest confidence
    const seen = new Map<string, ExtractedEndpoint>();
    for (const ep of all) {
      const key = `${ep.method}:${ep.path}`;
      const existing = seen.get(key);
      if (!existing || ep.confidence > existing.confidence) {
        seen.set(key, ep);
      }
    }

    return Array.from(seen.values());
  }
}

export const expressExtractor = new ExpressExtractor();
