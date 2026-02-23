import * as fs from "fs";
import * as path from "path";
import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import { isTestFile } from "../parser";
import { walk, extractStringValue } from "../../utils/ast-utils";
import type { DetectionResult } from "../../ingestion/detector";
import type { ExtractedPage } from "../../blueprint/types";

// ─── ID counter ───────────────────────────────────────────────────────────────

let _counter = 0;
const nextId = (): string => `page_${String(++_counter).padStart(3, "0")}`;

// ─── Shared filesystem helpers ────────────────────────────────────────────────

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".vue"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  ".svelte-kit", "out", ".turbo", ".cache", "coverage",
  // Test directories — never walk into these
  "__tests__", "e2e", "cypress", "smoke", "smoketest", "integration", "spec",
]);

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = walkDir(fullPath);
        results.push(...nested);
      } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name)) && !isTestFile(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore permission errors
  }
  return results;
}

// ─── Route normalization helpers ──────────────────────────────────────────────

function normalizeRoute(raw: string): string {
  return raw.replace(/:([a-zA-Z0-9_]+)/g, "11111111-2222-3333-4444-555555555555");
}

function routeParams(route: string): Array<{ name: string; example: string }> {
  return [...route.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => ({
    name: m[1],
    example: "11111111-2222-3333-4444-555555555555",
  }));
}

function isDynamicRoute(route: string): boolean {
  return /:/.test(route) || /\*/.test(route);
}

function titleFromPath(p: string): string {
  const normalizedP = p.replace(/\\/g, "/");
  const base = path.basename(p, path.extname(p));
  // For App Router / Pages Router: filename is "page" or "index" — use parent dir for title
  if (/^(index|page)$/.test(base)) {
    const segments = normalizedP.split("/");
    // Walk up segments to find a meaningful, non-route-group, non-root dir
    for (let i = segments.length - 2; i >= 0; i--) {
      const seg = segments[i];
      if (!seg || /^\(.*\)$/.test(seg)) continue; // skip route groups like (dashboard)
      if (seg === "app" || seg === "pages" || seg === "src") break; // stop at known roots
      if (/^\[/.test(seg)) continue;               // skip dynamic segments [id], [...slug]
      return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/[-_]/g, " ");
    }
    return "Home";
  }
  // Remix flat-file routing: strip $param segments and _index — use first meaningful segment
  // e.g. "appointments.$appointmentId" → "appointments" → "Appointments"
  const firstSeg = base.split(".").find((s) => s && !s.startsWith("$") && s !== "_index") ?? base;
  return firstSeg.replace(/[-_]/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase());
}

function makePage(
  route: string,
  filePath: string,
  opts: {
    authRequired?: boolean;
    roles?: string[];
    confidence?: number;
    title?: string;
  } = {}
): ExtractedPage {
  const r = routeParams(route);
  return {
    id: nextId(),
    route,
    normalizedRoute: normalizeRoute(route),
    title: opts.title ?? titleFromPath(filePath),
    filePath,
    authRequired: opts.authRequired ?? false,
    roles: opts.roles ?? [],
    isDynamic: isDynamicRoute(route),
    routeParams: r,
    locators: [],
    formFlows: [],
    navigationLinks: [],
    linkedEndpoints: [],
    confidence: opts.confidence ?? 0.85,
  };
}

// ─── Next.js Pages Router ─────────────────────────────────────────────────────

function pagesRouteFromPath(filePath: string, pagesRoot: string): string | null {
  const rel = path.relative(pagesRoot, filePath).replace(/\\/g, "/");

  // Skip special Next.js files and API routes
  if (rel.startsWith("_")) return null;
  if (rel.startsWith("api/") || rel === "api") return null;

  const noExt = rel.replace(/\.(tsx?|jsx?)$/, "");

  const route =
    "/" +
    noExt
      .replace(/\/index$/, "")
      .replace(/^index$/, "")
      .replace(/\[\.\.\.([^\]]+)\]/g, "*")
      .replace(/\[([^\]]+)\]/g, ":$1");

  return route || "/";
}

function extractNextJsPages(repoPath: string): ExtractedPage[] {
  const pages: ExtractedPage[] = [];

  // Check both /pages and /src/pages
  const candidates = [
    path.join(repoPath, "pages"),
    path.join(repoPath, "src", "pages"),
  ];

  for (const pagesRoot of candidates) {
    if (!fs.existsSync(pagesRoot)) continue;

    const files = walkDir(pagesRoot);
    for (const f of files) {
      const route = pagesRouteFromPath(f, pagesRoot);
      if (!route) continue;
      pages.push(makePage(route, f, { confidence: 0.90 }));
    }
  }

  return pages;
}

// ─── Next.js App Router ───────────────────────────────────────────────────────

function appRouteFromPath(filePath: string, appRoot: string): string | null {
  const base = path.basename(filePath);
  // Only page.tsx|page.ts|page.js|page.jsx files
  if (!base.match(/^page\.(tsx?|jsx?)$/)) return null;

  const rel = path.relative(appRoot, path.dirname(filePath)).replace(/\\/g, "/");
  if (rel === ".") return "/";

  const route =
    "/" +
    rel
      .split("/")
      .filter((seg) => !seg.match(/^\(.+\)$/)) // strip (group) segments
      .join("/")
      .replace(/\[\.\.\.([^\]]+)\]/g, "*")
      .replace(/\[([^\]]+)\]/g, ":$1");

  return route || "/";
}

function extractNextJsApp(repoPath: string): ExtractedPage[] {
  const pages: ExtractedPage[] = [];

  const candidates = [
    path.join(repoPath, "app"),
    path.join(repoPath, "src", "app"),
  ];

  for (const appRoot of candidates) {
    if (!fs.existsSync(appRoot)) continue;

    const files = walkDir(appRoot);
    for (const f of files) {
      const route = appRouteFromPath(f, appRoot);
      if (!route) continue;
      pages.push(makePage(route, f, { confidence: 0.90 }));
    }
  }

  return pages;
}

// ─── JSX attribute helper (for React Router) ──────────────────────────────────

function jsxAttrStr(
  attrs: (TSESTree.JSXAttribute | TSESTree.JSXSpreadAttribute)[],
  name: string
): string | null {
  for (const a of attrs) {
    if (a.type !== "JSXAttribute") continue;
    const ja = a as TSESTree.JSXAttribute;
    if (ja.name.type !== "JSXIdentifier") continue;
    if ((ja.name as TSESTree.JSXIdentifier).name !== name) continue;
    const v = ja.value;
    if (!v) return null;
    if (v.type === "Literal") {
      const l = (v as TSESTree.Literal).value;
      return typeof l === "string" ? l : null;
    }
    if (v.type === "JSXExpressionContainer") {
      const e = (v as TSESTree.JSXExpressionContainer).expression;
      if (e.type === "Literal") {
        const l = (e as TSESTree.Literal).value;
        return typeof l === "string" ? l : null;
      }
      return extractStringValue(e as TSESTree.Expression);
    }
    return null;
  }
  return null;
}

function jsxTagName(name: TSESTree.JSXTagNameExpression): string | null {
  if (name.type === "JSXIdentifier") return (name as TSESTree.JSXIdentifier).name;
  if (name.type === "JSXMemberExpression")
    return (
      (name as TSESTree.JSXMemberExpression).property as TSESTree.JSXIdentifier
    ).name;
  return null;
}

// ─── React Router ─────────────────────────────────────────────────────────────

const PRIVATE_ROUTE_NAMES = new Set([
  "PrivateRoute",
  "AuthRoute",
  "ProtectedRoute",
  "GuardedRoute",
  "RequireAuth",
]);

function extractReactRouterPages(files: ParsedFile[]): ExtractedPage[] {
  const pages: ExtractedPage[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file.ast) continue;
    const fp = file.filePath.replace(/\\/g, "/");
    if (fp.includes("node_modules")) continue;

    walk(file.ast, (node) => {
      // ── JSX <Route path="..." /> ──────────────────────────────────────────
      if (node.type === "JSXElement") {
        const el = node as TSESTree.JSXElement;
        const tag = jsxTagName(el.openingElement.name);
        if (!tag) return;

        if (tag === "Route" || tag === "IndexRoute") {
          const routePath = jsxAttrStr(el.openingElement.attributes, "path");
          if (!routePath || seen.has(routePath)) return;
          seen.add(routePath);

          // Detect auth from parent PrivateRoute wrapper (check parent in DOM)
          // Simplified: check component attribute for auth hints
          const compAttr = jsxAttrStr(el.openingElement.attributes, "component");
          const authRequired = PRIVATE_ROUTE_NAMES.has(tag) ||
            (compAttr !== null && /auth|admin|protected/i.test(compAttr));

          const route = routePath.startsWith("/") ? routePath : "/" + routePath;
          pages.push(makePage(route, fp, { authRequired, confidence: 0.85 }));
        }

        // Check for PrivateRoute wrapping Route children
        if (PRIVATE_ROUTE_NAMES.has(tag)) {
          // Walk children to find nested Route
          for (const child of el.children) {
            if (child.type !== "JSXElement") continue;
            const childEl = child as TSESTree.JSXElement;
            const childTag = jsxTagName(childEl.openingElement.name);
            if (childTag !== "Route") continue;
            const routePath = jsxAttrStr(childEl.openingElement.attributes, "path");
            if (!routePath || seen.has(routePath)) continue;
            seen.add(routePath);
            const route = routePath.startsWith("/") ? routePath : "/" + routePath;
            pages.push(makePage(route, fp, { authRequired: true, confidence: 0.85 }));
          }
        }
        return;
      }

      // ── useRoutes([...]) / createBrowserRouter([...]) ─────────────────────
      if (node.type === "CallExpression") {
        const call = node as TSESTree.CallExpression;
        const callee = call.callee;
        let fnName = "";
        if (callee.type === "Identifier")
          fnName = (callee as TSESTree.Identifier).name;
        if (callee.type === "MemberExpression" && callee.property.type === "Identifier")
          fnName = (callee.property as TSESTree.Identifier).name;

        if (
          fnName === "useRoutes" ||
          fnName === "createBrowserRouter" ||
          fnName === "createHashRouter"
        ) {
          const arg = call.arguments[0];
          if (arg && arg.type === "ArrayExpression") {
            parseReactRouterArray(
              arg as TSESTree.ArrayExpression,
              "",
              fp,
              seen,
              pages
            );
          }
        }
        return;
      }

      // ── const routes = [...] ──────────────────────────────────────────────
      if (node.type === "VariableDeclarator") {
        const vd = node as TSESTree.VariableDeclarator;
        if (vd.id.type === "Identifier") {
          const name = (vd.id as TSESTree.Identifier).name;
          if (
            (name === "routes" || name === "routeConfig" || name === "routeTree") &&
            vd.init?.type === "ArrayExpression"
          ) {
            parseReactRouterArray(
              vd.init as TSESTree.ArrayExpression,
              "",
              fp,
              seen,
              pages
            );
          }
        }
      }
    });
  }

  return pages;
}

function parseReactRouterArray(
  arr: TSESTree.ArrayExpression,
  prefix: string,
  filePath: string,
  seen: Set<string>,
  pages: ExtractedPage[]
): void {
  for (const elem of arr.elements) {
    if (!elem || elem.type !== "ObjectExpression") continue;
    const obj = elem as TSESTree.ObjectExpression;

    let routePath: string | null = null;
    let authRequired = false;
    let childrenArr: TSESTree.ArrayExpression | null = null;

    for (const prop of obj.properties) {
      if (prop.type !== "Property") continue;
      const p = prop as TSESTree.Property;
      const keyName =
        p.key.type === "Identifier"
          ? (p.key as TSESTree.Identifier).name
          : null;
      if (!keyName) continue;

      if (keyName === "path") {
        routePath = extractStringValue(p.value as TSESTree.Expression);
      }
      if (keyName === "children" && p.value.type === "ArrayExpression") {
        childrenArr = p.value as TSESTree.ArrayExpression;
      }
      // Detect loader/component hints for auth
      if (keyName === "loader" || keyName === "element") {
        const sv = extractStringValue(p.value as TSESTree.Expression);
        if (sv && /auth|protected|private/i.test(sv)) authRequired = true;
      }
    }

    if (routePath !== null) {
      const fullRoute = prefix
        ? `${prefix.replace(/\/$/, "")}/${routePath.replace(/^\//, "")}`
        : routePath.startsWith("/")
          ? routePath
          : "/" + routePath;

      if (!seen.has(fullRoute)) {
        seen.add(fullRoute);
        pages.push(makePage(fullRoute, filePath, { authRequired, confidence: 0.85 }));
      }

      if (childrenArr) {
        parseReactRouterArray(childrenArr, fullRoute, filePath, seen, pages);
      }
    }
  }
}

// ─── TanStack Router ──────────────────────────────────────────────────────────

function extractTanStackPages(files: ParsedFile[]): ExtractedPage[] {
  const pages: ExtractedPage[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file.ast) continue;
    if (file.filePath.includes("node_modules")) continue;

    walk(file.ast, (node) => {
      if (node.type !== "CallExpression") return;
      const call = node as TSESTree.CallExpression;
      const callee = call.callee;

      let fnName = "";
      if (callee.type === "Identifier")
        fnName = (callee as TSESTree.Identifier).name;
      if (callee.type === "MemberExpression" && callee.property.type === "Identifier")
        fnName = (callee.property as TSESTree.Identifier).name;

      if (fnName !== "createRoute" && fnName !== "createFileRoute") return;

      // createFileRoute('/path') — first arg is the path string
      if (fnName === "createFileRoute") {
        const arg = call.arguments[0];
        if (!arg) return;
        const routePath = extractStringValue(arg as TSESTree.Expression);
        if (!routePath || seen.has(routePath)) return;
        seen.add(routePath);
        const route = routePath.startsWith("/") ? routePath : "/" + routePath;
        // TanStack uses $param not :param
        const normalRt = route.replace(/\$([a-zA-Z0-9_]+)/g, ":$1");
        pages.push(makePage(normalRt, file.filePath, { confidence: 0.80 }));
        return;
      }

      // createRoute({ getParentRoute: ..., path: '/users', ... })
      const arg = call.arguments[0];
      if (!arg || arg.type !== "ObjectExpression") return;
      const obj = arg as TSESTree.ObjectExpression;

      let routePath: string | null = null;
      for (const prop of obj.properties) {
        if (prop.type !== "Property") continue;
        const p = prop as TSESTree.Property;
        if (
          p.key.type === "Identifier" &&
          (p.key as TSESTree.Identifier).name === "path"
        ) {
          routePath = extractStringValue(p.value as TSESTree.Expression);
        }
      }

      if (!routePath || seen.has(routePath)) return;
      seen.add(routePath);
      const route = routePath.startsWith("/") ? routePath : "/" + routePath;
      const normalRt = route.replace(/\$([a-zA-Z0-9_]+)/g, ":$1");
      pages.push(makePage(normalRt, file.filePath, { confidence: 0.80 }));
    });
  }

  return pages;
}

// ─── Vue Router ───────────────────────────────────────────────────────────────

function extractVueRouterPages(files: ParsedFile[]): ExtractedPage[] {
  const pages: ExtractedPage[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file.ast) continue;
    const fp = file.filePath.replace(/\\/g, "/");
    if (fp.includes("node_modules")) continue;

    // Only look in router files
    const base = path.basename(fp);
    const inRouterDir = fp.includes("/router/") || base === "router.ts" || base === "router.js";
    if (!inRouterDir) continue;

    walk(file.ast, (node) => {
      if (node.type !== "VariableDeclarator") return;
      const vd = node as TSESTree.VariableDeclarator;
      const idName =
        vd.id.type === "Identifier"
          ? (vd.id as TSESTree.Identifier).name
          : null;
      if (!idName || !idName.match(/^routes/i)) return;
      if (!vd.init || vd.init.type !== "ArrayExpression") return;

      parseVueRoutes(vd.init as TSESTree.ArrayExpression, "", fp, seen, pages);
    });

    // Also handle createRouter({ routes: [...] })
    walk(file.ast, (node) => {
      if (node.type !== "CallExpression") return;
      const call = node as TSESTree.CallExpression;
      const callee = call.callee;
      const fnName =
        callee.type === "Identifier"
          ? (callee as TSESTree.Identifier).name
          : callee.type === "MemberExpression" && callee.property.type === "Identifier"
            ? (callee.property as TSESTree.Identifier).name
            : "";
      if (fnName !== "createRouter") return;

      const arg = call.arguments[0];
      if (!arg || arg.type !== "ObjectExpression") return;

      for (const prop of (arg as TSESTree.ObjectExpression).properties) {
        if (prop.type !== "Property") continue;
        const p = prop as TSESTree.Property;
        const keyName =
          p.key.type === "Identifier"
            ? (p.key as TSESTree.Identifier).name
            : null;
        if (keyName !== "routes") continue;
        if (p.value.type === "ArrayExpression") {
          parseVueRoutes(p.value as TSESTree.ArrayExpression, "", fp, seen, pages);
        }
      }
    });
  }

  return pages;
}

function getObjStrProp(
  obj: TSESTree.ObjectExpression,
  key: string
): string | null {
  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    const p = prop as TSESTree.Property;
    const k = p.key.type === "Identifier" ? (p.key as TSESTree.Identifier).name : null;
    if (k !== key) continue;
    return extractStringValue(p.value as TSESTree.Expression);
  }
  return null;
}

function getObjBoolProp(obj: TSESTree.ObjectExpression, key: string): boolean | null {
  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    const p = prop as TSESTree.Property;
    const k = p.key.type === "Identifier" ? (p.key as TSESTree.Identifier).name : null;
    if (k !== key) continue;
    if (p.value.type === "Literal" && typeof (p.value as TSESTree.Literal).value === "boolean") {
      return (p.value as TSESTree.Literal).value as boolean;
    }
  }
  return null;
}

function getMetaObject(obj: TSESTree.ObjectExpression): TSESTree.ObjectExpression | null {
  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    const p = prop as TSESTree.Property;
    const k = p.key.type === "Identifier" ? (p.key as TSESTree.Identifier).name : null;
    if (k !== "meta") continue;
    if (p.value.type === "ObjectExpression") return p.value as TSESTree.ObjectExpression;
  }
  return null;
}

function getObjArrayProp(obj: TSESTree.ObjectExpression, key: string): string[] {
  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    const p = prop as TSESTree.Property;
    const k = p.key.type === "Identifier" ? (p.key as TSESTree.Identifier).name : null;
    if (k !== key) continue;
    if (p.value.type !== "ArrayExpression") continue;
    const arr = p.value as TSESTree.ArrayExpression;
    const results: string[] = [];
    for (const el of arr.elements) {
      if (!el) continue;
      const sv = extractStringValue(el as TSESTree.Expression);
      if (sv) results.push(sv);
    }
    return results;
  }
  return [];
}

function parseVueRoutes(
  arr: TSESTree.ArrayExpression,
  prefix: string,
  filePath: string,
  seen: Set<string>,
  pages: ExtractedPage[]
): void {
  for (const elem of arr.elements) {
    if (!elem || elem.type !== "ObjectExpression") continue;
    const obj = elem as TSESTree.ObjectExpression;

    const routePath = getObjStrProp(obj, "path");
    if (!routePath) continue;

    const fullRoute = prefix
      ? `${prefix.replace(/\/$/, "")}/${routePath.replace(/^\//, "")}`
      : routePath.startsWith("/")
        ? routePath
        : "/" + routePath;

    // Check meta for auth
    let authRequired = false;
    let roles: string[] = [];
    const meta = getMetaObject(obj);
    if (meta) {
      const req = getObjBoolProp(meta, "requiresAuth") ?? getObjBoolProp(meta, "auth");
      if (req) authRequired = true;
      roles = getObjArrayProp(meta, "roles");
    }

    if (!seen.has(fullRoute)) {
      seen.add(fullRoute);
      pages.push(makePage(fullRoute, filePath, { authRequired, roles, confidence: 0.85 }));
    }

    // Handle children
    for (const prop of obj.properties) {
      if (prop.type !== "Property") continue;
      const p = prop as TSESTree.Property;
      const k = p.key.type === "Identifier" ? (p.key as TSESTree.Identifier).name : null;
      if (k !== "children") continue;
      if (p.value.type !== "ArrayExpression") continue;
      parseVueRoutes(p.value as TSESTree.ArrayExpression, fullRoute, filePath, seen, pages);
    }
  }
}

// ─── Angular Router ───────────────────────────────────────────────────────────

function extractAngularPages(files: ParsedFile[]): ExtractedPage[] {
  const pages: ExtractedPage[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file.ast) continue;
    const fp = file.filePath.replace(/\\/g, "/");
    if (fp.includes("node_modules")) continue;

    // Only look in routing module files
    if (!fp.match(/routing\.module\.(ts|js)$/) && !fp.includes("app-routes")) continue;

    // Find `const routes: Routes = [...]`
    walk(file.ast, (node) => {
      if (node.type !== "VariableDeclarator") return;
      const vd = node as TSESTree.VariableDeclarator;
      const idName =
        vd.id.type === "Identifier"
          ? (vd.id as TSESTree.Identifier).name
          : null;
      if (!idName || !idName.match(/^routes/i)) return;
      if (!vd.init || vd.init.type !== "ArrayExpression") return;

      parseAngularRoutes(vd.init as TSESTree.ArrayExpression, "", fp, seen, pages);
    });

    // Also find RouterModule.forRoot([...]) or RouterModule.forChild([...])
    walk(file.ast, (node) => {
      if (node.type !== "CallExpression") return;
      const call = node as TSESTree.CallExpression;
      const callee = call.callee;
      if (callee.type !== "MemberExpression") return;
      if (callee.property.type !== "Identifier") return;
      const method = (callee.property as TSESTree.Identifier).name;
      if (method !== "forRoot" && method !== "forChild") return;

      const arg = call.arguments[0];
      if (!arg || arg.type !== "ArrayExpression") return;
      parseAngularRoutes(arg as TSESTree.ArrayExpression, "", fp, seen, pages);
    });
  }

  return pages;
}

function parseAngularRoutes(
  arr: TSESTree.ArrayExpression,
  prefix: string,
  filePath: string,
  seen: Set<string>,
  pages: ExtractedPage[]
): void {
  for (const elem of arr.elements) {
    if (!elem || elem.type !== "ObjectExpression") continue;
    const obj = elem as TSESTree.ObjectExpression;

    const routePath = getObjStrProp(obj, "path");
    if (routePath === null) continue;

    const fullRoute = routePath === ""
      ? prefix || "/"
      : prefix
        ? `${prefix.replace(/\/$/, "")}/${routePath}`
        : `/${routePath}`;

    // Check canActivate
    let authRequired = false;
    for (const prop of obj.properties) {
      if (prop.type !== "Property") continue;
      const p = prop as TSESTree.Property;
      const k = p.key.type === "Identifier" ? (p.key as TSESTree.Identifier).name : null;
      if (k !== "canActivate") continue;
      // any canActivate guard → authRequired: true
      authRequired = true;
    }

    if (!seen.has(fullRoute) && routePath !== "**") {
      seen.add(fullRoute);
      pages.push(makePage(fullRoute, filePath, { authRequired, confidence: 0.85 }));
    }

    // Handle children
    for (const prop of obj.properties) {
      if (prop.type !== "Property") continue;
      const p = prop as TSESTree.Property;
      const k = p.key.type === "Identifier" ? (p.key as TSESTree.Identifier).name : null;
      if (k !== "children") continue;
      if (p.value.type !== "ArrayExpression") continue;
      parseAngularRoutes(
        p.value as TSESTree.ArrayExpression,
        fullRoute,
        filePath,
        seen,
        pages
      );
    }
  }
}

// ─── Nuxt / Next.js Pages-style (Vue .vue files) ─────────────────────────────

function extractNuxtPages(repoPath: string): ExtractedPage[] {
  const pages: ExtractedPage[] = [];
  const pagesRoot = path.join(repoPath, "pages");
  if (!fs.existsSync(pagesRoot)) return pages;

  const files = walkDir(pagesRoot);
  for (const f of files) {
    if (!f.endsWith(".vue")) continue;
    const route = pagesRouteFromPath(f, pagesRoot);
    if (!route) continue;
    pages.push(makePage(route, f, { confidence: 0.88 }));
  }

  return pages;
}

// ─── Remix (v1 folder-based + v2 dot-notation) ─────────────────────────────

/**
 * Converts a Remix route file path (relative to the routes root) to a URL route.
 *
 * Handles both Remix route conventions:
 *
 * Remix v1 — folder-based (path contains directory separators):
 *   appointments/index.tsx         → /appointments
 *   appointments/$id.tsx           → /appointments/:id
 *
 * Remix v2 — flat dot-notation (no subdirectories, dots = path separators):
 *   _index.tsx                     → /
 *   login.tsx                      → /login
 *   appointments._index.tsx        → /appointments
 *   appointments.$id.tsx           → /appointments/:id
 *   api.mainframe.branches.ts      → /api/mainframe/branches
 *   jenkins.deploy-summary.$id.request.tsx  → /jenkins/deploy-summary/:id/request
 *   workflow-summaries.$appCode.$repo.tsx   → /workflow-summaries/:appCode/:repo
 *
 * Special segments:
 *   _index          → index route (segment dropped, parent path kept)
 *   index           → same as _index
 *   $param          → :param  (dynamic URL segment)
 *   _prefix         → pathless layout name (segment stripped from URL)
 *   (group)         → route group (segment stripped from URL)
 */
export function remixFileToRoute(relPath: string): string | null {
  const rel = relPath.replace(/\\/g, '/');

  // Strip file extension (.tsx, .ts, .jsx, .js)
  const noExt = rel.replace(/\.(tsx?|jsx?)$/, '');

  // ── V1: folder-based routing (relative path contains directory separators) ──
  if (noExt.includes('/')) {
    const parts = noExt.split('/');
    const urlSegments: string[] = [];
    for (const seg of parts) {
      if (seg === 'index' || seg === '_index') continue;   // index routes
      if (/^\(.+\)$/.test(seg)) continue;                  // (routeGroup)
      if (/^_[^_]/.test(seg)) continue;                    // _pathlessLayout
      if (seg.startsWith('$')) {
        urlSegments.push(':' + seg.slice(1));               // $param → :param
      } else if (/^\[.+\]$/.test(seg)) {
        urlSegments.push(':' + seg.slice(1, -1));           // [param] → :param
      } else {
        urlSegments.push(seg);
      }
    }
    return '/' + urlSegments.join('/');
  }

  // ── V2: flat dot-notation routing ─────────────────────────────────────────
  // Bare root indices
  if (noExt === '_index' || noExt === 'index') return '/';

  const segments = noExt.split('.');
  const urlSegments: string[] = [];
  for (const seg of segments) {
    if (seg === '_index') break;             // _index = index of accumulated path: stop here
    if (/^\(.+\)$/.test(seg)) continue;     // (routeGroup) → skip
    if (seg.startsWith('_')) continue;      // _pathlessLayout prefix → skip
    if (seg.startsWith('$')) {
      urlSegments.push(':' + seg.slice(1)); // $param → :param
    } else {
      urlSegments.push(seg);
    }
  }

  if (urlSegments.length === 0) return '/';
  return '/' + urlSegments.join('/');
}

function extractRemixPages(repoPath: string): ExtractedPage[] {
  const pages: ExtractedPage[] = [];
  const seen = new Set<string>();

  // Standard Remix routes directory locations
  const routesCandidates = [
    path.join(repoPath, 'app', 'routes'),
    path.join(repoPath, 'routes'),
  ];

  for (const routesRoot of routesCandidates) {
    if (!fs.existsSync(routesRoot)) continue;

    const files = walkDir(routesRoot);
    for (const f of files) {
      // Only JS/TS route files
      const ext = path.extname(f);
      if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;

      const relPath = path.relative(routesRoot, f).replace(/\\/g, '/');
      const route = remixFileToRoute(relPath);
      if (!route) continue;
      if (seen.has(route)) continue;
      seen.add(route);

      pages.push(makePage(route, f, { confidence: 0.88 }));
    }
  }

  return pages;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Detect and extract all pages from the repository using all applicable
 * routing strategies based on the detected frameworks.
 */
export function extractPages(
  files: ParsedFile[],
  detection: DetectionResult,
  repoPath: string
): ExtractedPage[] {
  const allPages: ExtractedPage[] = [];
  const seen = new Set<string>();

  // Flatten frameworks from all packages
  const frontends = detection.packages.flatMap((p) => p.frontendFrameworks);
  const backends = detection.packages.flatMap((p) => p.backendFrameworks);
  const routers = detection.packages.flatMap((p) => p.routerLibraries);

  const hasRemix = backends.includes("remix") || frontends.includes("remix" as never);
  const hasNextJs =
    frontends.includes("nextjs") || backends.includes("nextjs");
  const hasNuxt = frontends.includes("nuxt") || backends.includes("nuxt");
  const hasAngular = frontends.includes("angular");
  const hasReactSpa = frontends.includes("react-spa");
  const hasReactRouter =
    routers.includes("react-router") ||
    routers.includes("react-router-dom");
  const hasTanstack = routers.includes("tanstack-router");
  const hasVueRouter = routers.includes("vue-router");

  const addPages = (newPages: ExtractedPage[]): void => {
    for (const p of newPages) {
      if (!seen.has(p.route)) {
        seen.add(p.route);
        allPages.push(p);
      }
    }
  };

  if (hasRemix) {
    addPages(extractRemixPages(repoPath));
  }

  if (hasNextJs) {
    addPages(extractNextJsPages(repoPath));
    addPages(extractNextJsApp(repoPath));
  }

  if (hasNuxt) {
    addPages(extractNuxtPages(repoPath));
  }

  if (hasAngular) {
    addPages(extractAngularPages(files));
  }

  if (hasTanstack) {
    addPages(extractTanStackPages(files));
  }

  if (hasReactRouter || hasReactSpa) {
    addPages(extractReactRouterPages(files));
  }

  if (hasVueRouter) {
    addPages(extractVueRouterPages(files));
  }

  // Fallback: if no pages found, run AST-based React Router detection anyway
  if (allPages.length === 0) {
    addPages(extractReactRouterPages(files));
  }

  return allPages;
}
