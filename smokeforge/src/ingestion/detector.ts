// src/ingestion/detector.ts

import * as fs from "fs";
import * as path from "path";
import { readJson } from "../utils/file-utils";

export type BackendFramework =
  | "express"
  | "fastify"
  | "nestjs"
  | "koa"
  | "hapi"
  | "hono"
  | "trpc"
  | "nextjs"
  | "nuxt"
  | "remix"
  | "sveltekit"
  | "astro"
  | "elysia"
  | "nitro"
  | "unknown-backend";

export type FrontendFramework =
  | "react-spa"
  | "nextjs"
  | "remix"
  | "vue-spa"
  | "nuxt"
  | "angular"
  | "sveltekit"
  | "solid"
  | "qwik"
  | "astro"
  | "unknown-frontend";

export type RouterLibrary =
  | "react-router"
  | "react-router-dom"
  | "tanstack-router"
  | "wouter"
  | "vue-router"
  | "angular-router"
  | "svelte-routing"
  | "none";

export type SchemaLibrary =
  | "zod"
  | "joi"
  | "yup"
  | "valibot"
  | "class-validator"
  | "arktype"
  | "superstruct"
  | "typebox"
  | "none";

export type AuthLibrary =
  | "jsonwebtoken"
  | "passport"
  | "next-auth"
  | "lucia"
  | "better-auth"
  | "clerk"
  | "supabase-auth"
  | "firebase-auth"
  | "express-jwt"
  | "koa-jwt"
  | "none";

export interface DetectionResult {
  monorepo: boolean;
  monorepoTool: "turbo" | "nx" | "lerna" | "pnpm-workspaces" | "none";
  packages: PackageDetection[];
}

export interface PackageDetection {
  rootPath: string;
  name: string;
  backendFrameworks: BackendFramework[];
  frontendFrameworks: FrontendFramework[];
  routerLibraries: RouterLibrary[];
  schemaLibraries: SchemaLibrary[];
  authLibraries: AuthLibrary[];
  isFullStack: boolean;
  nodeVersion: string | null;
  hasTypeScript: boolean;
  packageJson: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Detection signal maps
// ---------------------------------------------------------------------------

const BACKEND_SIGNALS: Record<BackendFramework, string[]> = {
  express:           ["express"],
  fastify:           ["fastify"],
  nestjs:            ["@nestjs/core", "@nestjs/common"],
  koa:               ["koa"],
  hapi:              ["@hapi/hapi"],
  hono:              ["hono"],
  trpc:              ["@trpc/server"],
  nextjs:            ["next"],
  nuxt:              ["nuxt", "nuxt3"],
  remix:             ["@remix-run/node", "@remix-run/server-runtime"],
  sveltekit:         ["@sveltejs/kit"],
  astro:             ["astro"],
  elysia:            ["elysia"],
  nitro:             ["nitropack"],
  "unknown-backend": [],
};

const FRONTEND_SIGNALS: Record<FrontendFramework, string[]> = {
  "react-spa":       ["react", "react-dom"],
  nextjs:            ["next"],
  remix:             ["@remix-run/react"],
  "vue-spa":         ["vue"],
  nuxt:              ["nuxt", "nuxt3"],
  angular:           ["@angular/core"],
  sveltekit:         ["@sveltejs/kit"],
  solid:             ["solid-js"],
  qwik:              ["@builder.io/qwik"],
  astro:             ["astro"],
  "unknown-frontend": [],
};

const SCHEMA_SIGNALS: Record<SchemaLibrary, string[]> = {
  zod:               ["zod"],
  joi:               ["joi", "@hapi/joi"],
  yup:               ["yup"],
  valibot:           ["valibot"],
  "class-validator": ["class-validator"],
  arktype:           ["arktype"],
  superstruct:       ["superstruct"],
  typebox:           ["@sinclair/typebox"],
  none:              [],
};

const AUTH_SIGNALS: Record<AuthLibrary, string[]> = {
  jsonwebtoken:      ["jsonwebtoken", "jose"],
  passport:          ["passport"],
  "next-auth":       ["next-auth", "@auth/core"],
  lucia:             ["lucia"],
  "better-auth":     ["better-auth"],
  clerk:             ["@clerk/nextjs", "@clerk/clerk-sdk-node"],
  "supabase-auth":   ["@supabase/supabase-js"],
  "firebase-auth":   ["firebase-admin", "firebase"],
  "express-jwt":     ["express-jwt"],
  "koa-jwt":         ["koa-jwt"],
  none:              [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAllDeps(pkg: Record<string, unknown>): Set<string> {
  const deps = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const section = pkg[field];
    if (section && typeof section === "object") {
      for (const key of Object.keys(section as Record<string, unknown>)) {
        deps.add(key);
      }
    }
  }
  return deps;
}

function detectFromSignals<T extends string>(
  signals: Record<T, string[]>,
  deps: Set<string>,
  skipValues: T[] = []
): T[] {
  const results: T[] = [];
  for (const [framework, packages] of Object.entries(signals) as [T, string[]][]) {
    if (skipValues.includes(framework)) continue;
    if (packages.length === 0) continue;
    if (packages.some((p) => deps.has(p))) {
      results.push(framework);
    }
  }
  return results;
}

const SKIP_PACKAGE_DIRS = new Set([
  "node_modules", "dist", ".next", ".svelte-kit", "out", "build", ".turbo",
]);

function findPackageJsonPaths(rootPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_PACKAGE_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile() && entry.name === "package.json") {
        results.push(path.join(dir, "package.json"));
      }
    }
  }

  walk(rootPath);
  return results;
}

function detectPackage(pkgPath: string): PackageDetection | null {
  const pkg = readJson<Record<string, unknown>>(pkgPath);
  if (!pkg) return null;

  const rootPath = path.dirname(pkgPath);
  const deps = getAllDeps(pkg);

  const backendFrameworks = detectFromSignals<BackendFramework>(BACKEND_SIGNALS, deps, ["unknown-backend"]);
  const frontendFrameworks = detectFromSignals<FrontendFramework>(FRONTEND_SIGNALS, deps, ["unknown-frontend"]);

  // react-spa: only if no meta-framework present
  const metaFrameworks = new Set(["nextjs", "remix", "nuxt", "sveltekit", "astro"]);
  const filteredFrontend = frontendFrameworks.filter((f) => {
    if (f === "react-spa" && frontendFrameworks.some((ff) => metaFrameworks.has(ff))) return false;
    if (f === "vue-spa" && frontendFrameworks.some((ff) => metaFrameworks.has(ff))) return false;
    return true;
  });

  const routerLibraries: RouterLibrary[] = [];
  if (deps.has("@tanstack/react-router") || deps.has("@tanstack/router")) routerLibraries.push("tanstack-router");
  if (deps.has("react-router-dom")) routerLibraries.push("react-router-dom");
  else if (deps.has("react-router")) routerLibraries.push("react-router");
  if (deps.has("wouter")) routerLibraries.push("wouter");
  if (deps.has("vue-router")) routerLibraries.push("vue-router");
  if (deps.has("@angular/router")) routerLibraries.push("angular-router");
  if (deps.has("svelte-routing")) routerLibraries.push("svelte-routing");
  if (routerLibraries.length === 0) routerLibraries.push("none");

  const schemaLibraries = detectFromSignals(SCHEMA_SIGNALS, deps, ["none"]);
  if (schemaLibraries.length === 0) schemaLibraries.push("none");

  const authLibraries = detectFromSignals(AUTH_SIGNALS, deps, ["none"]);
  if (authLibraries.length === 0) authLibraries.push("none");

  const fullStackFrameworks = new Set(["nextjs", "remix", "nuxt", "sveltekit", "astro"]);
  const isFullStack =
    backendFrameworks.some((f) => fullStackFrameworks.has(f)) ||
    (backendFrameworks.length > 0 && filteredFrontend.length > 0);

  const hasTypeScript = deps.has("typescript") ||
    fs.existsSync(path.join(rootPath, "tsconfig.json"));

  const engines = pkg["engines"] as Record<string, string> | undefined;
  const nodeVersion = engines?.["node"] ?? null;

  const name =
    typeof pkg["name"] === "string"
      ? pkg["name"]
      : path.basename(rootPath);

  return {
    rootPath,
    name,
    backendFrameworks,
    frontendFrameworks: filteredFrontend,
    routerLibraries,
    schemaLibraries,
    authLibraries,
    isFullStack,
    nodeVersion,
    hasTypeScript,
    packageJson: pkg,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function detect(repoPath: string): Promise<DetectionResult> {
  const abs = path.resolve(repoPath);

  // Monorepo detection — order matters
  let monorepo = false;
  let monorepoTool: DetectionResult["monorepoTool"] = "none";

  if (fs.existsSync(path.join(abs, "pnpm-workspace.yaml"))) {
    monorepo = true;
    monorepoTool = "pnpm-workspaces";
  } else if (fs.existsSync(path.join(abs, "turbo.json"))) {
    monorepo = true;
    monorepoTool = "turbo";
  } else if (fs.existsSync(path.join(abs, "nx.json"))) {
    monorepo = true;
    monorepoTool = "nx";
  } else if (fs.existsSync(path.join(abs, "lerna.json"))) {
    monorepo = true;
    monorepoTool = "lerna";
  } else {
    const rootPkg = readJson<Record<string, unknown>>(path.join(abs, "package.json"));
    if (rootPkg && rootPkg["workspaces"]) {
      monorepo = true;
      monorepoTool = "pnpm-workspaces";
    }
  }

  // Collect package.json paths
  const pkgPaths: string[] = monorepo
    ? findPackageJsonPaths(abs)
    : [path.join(abs, "package.json")];

  const packages: PackageDetection[] = [];
  for (const pkgPath of pkgPaths) {
    const detection = detectPackage(pkgPath);
    if (!detection) continue;

    // For monorepos: skip workspace root if it has no "main" or "scripts.dev"
    // (it's likely just a workspace orchestration root, not a real package)
    const isRoot = path.resolve(path.dirname(pkgPath)) === abs;
    if (monorepo && isRoot) {
      const pkg = detection.packageJson;
      const scripts = pkg["scripts"] as Record<string, unknown> | undefined;
      const hasMain = Boolean(pkg["main"]);
      const hasDev = Boolean(scripts?.["dev"]);
      if (!hasMain && !hasDev) continue;
    }

    packages.push(detection);
  }

  // If nothing found at root, still return one empty entry
  if (packages.length === 0) {
    packages.push({
      rootPath: abs,
      name: path.basename(abs),
      backendFrameworks: [],
      frontendFrameworks: [],
      routerLibraries: ["none"],
      schemaLibraries: ["none"],
      authLibraries: ["none"],
      isFullStack: false,
      nodeVersion: null,
      hasTypeScript: fs.existsSync(path.join(abs, "tsconfig.json")),
      packageJson: {},
    });
  }

  return { monorepo, monorepoTool, packages };
}
