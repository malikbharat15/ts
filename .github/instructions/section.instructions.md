## SECTION 2 — FRAMEWORK DETECTION SYSTEM

### 2.1 Complete Framework Taxonomy

This is every JS/TS framework the system must handle. Detection is always from `package.json` `dependencies` + `devDependencies`. Never assume — always verify.

```typescript
// src/ingestion/detector.ts

export type BackendFramework =
  | "express"
  | "fastify"
  | "nestjs"
  | "koa"
  | "hapi"
  | "hono"
  | "trpc"
  | "nextjs"        // can be backend + frontend
  | "nuxt"          // can be backend + frontend
  | "remix"         // can be backend + frontend
  | "sveltekit"     // can be backend + frontend
  | "astro"         // can have API endpoints
  | "elysia"        // Bun-native
  | "nitro"         // Nuxt's server engine, also standalone
  | "unknown-backend";

export type FrontendFramework =
  | "react-spa"     // React + react-dom, no meta-framework
  | "nextjs"
  | "remix"
  | "vue-spa"       // Vue + vue-router, no meta-framework
  | "nuxt"
  | "angular"
  | "sveltekit"
  | "solid"
  | "qwik"
  | "astro"
  | "unknown-frontend";

export type RouterLibrary =
  | "react-router"      // v5 or v6 — detect by version
  | "react-router-dom"
  | "tanstack-router"
  | "wouter"
  | "vue-router"
  | "angular-router"    // built into @angular/router
  | "svelte-routing"
  | "none";

export type SchemaLibrary =
  | "zod"
  | "joi"
  | "yup"
  | "valibot"
  | "class-validator"   // NestJS DTOs
  | "arktype"
  | "superstruct"
  | "typebox"           // @sinclair/typebox
  | "none";

export type AuthLibrary =
  | "jsonwebtoken"
  | "passport"
  | "next-auth"         // Auth.js
  | "lucia"
  | "better-auth"
  | "clerk"             // SDK-based, not extractable from source
  | "supabase-auth"
  | "firebase-auth"
  | "express-jwt"
  | "koa-jwt"
  | "none";

export interface DetectionResult {
  monorepo: boolean;
  monorepoTool: "turbo" | "nx" | "lerna" | "pnpm-workspaces" | "none";
  packages: PackageDetection[];   // one per workspace package, or one for single-package repos
}

export interface PackageDetection {
  rootPath: string;
  name: string;
  backendFrameworks: BackendFramework[];
  frontendFrameworks: FrontendFramework[];
  routerLibraries: RouterLibrary[];
  schemaLibraries: SchemaLibrary[];
  authLibraries: AuthLibrary[];
  isFullStack: boolean;         // true when same package has both BE + FE (Next.js, Remix, etc.)
  nodeVersion: string | null;
  hasTypeScript: boolean;
  packageJson: Record<string, unknown>;
}
```

### 2.2 Detection Logic — Exact Dependency Mappings

```typescript
// BACKEND DETECTION — check both dependencies and devDependencies
const BACKEND_SIGNALS: Record<BackendFramework, string[]> = {
  express:    ["express"],
  fastify:    ["fastify"],
  nestjs:     ["@nestjs/core", "@nestjs/common"],
  koa:        ["koa"],
  hapi:       ["@hapi/hapi"],
  hono:       ["hono"],
  trpc:       ["@trpc/server"],
  nextjs:     ["next"],
  nuxt:       ["nuxt", "nuxt3"],
  remix:      ["@remix-run/node", "@remix-run/server-runtime"],
  sveltekit:  ["@sveltejs/kit"],
  astro:      ["astro"],
  elysia:     ["elysia"],
  nitro:      ["nitropack"],
  "unknown-backend": [],
};

// FRONTEND DETECTION
const FRONTEND_SIGNALS: Record<FrontendFramework, string[]> = {
  "react-spa": ["react", "react-dom"],    // only if no next/remix/etc
  nextjs:      ["next"],
  remix:       ["@remix-run/react"],
  "vue-spa":   ["vue"],                   // only if no nuxt
  nuxt:        ["nuxt", "nuxt3"],
  angular:     ["@angular/core"],
  sveltekit:   ["@sveltejs/kit"],
  solid:       ["solid-js"],
  qwik:        ["@builder.io/qwik"],
  astro:       ["astro"],
  "unknown-frontend": [],
};

// SCHEMA DETECTION
const SCHEMA_SIGNALS: Record<SchemaLibrary, string[]> = {
  zod:             ["zod"],
  joi:             ["joi", "@hapi/joi"],
  yup:             ["yup"],
  valibot:         ["valibot"],
  "class-validator": ["class-validator"],
  arktype:         ["arktype"],
  superstruct:     ["superstruct"],
  typebox:         ["@sinclair/typebox"],
  none:            [],
};

// AUTH DETECTION
const AUTH_SIGNALS: Record<AuthLibrary, string[]> = {
  jsonwebtoken:  ["jsonwebtoken", "jose"],
  passport:      ["passport"],
  "next-auth":   ["next-auth", "@auth/core"],
  lucia:         ["lucia"],
  "better-auth": ["better-auth"],
  clerk:         ["@clerk/nextjs", "@clerk/clerk-sdk-node"],
  "supabase-auth": ["@supabase/supabase-js"],
  "firebase-auth": ["firebase-admin", "firebase"],
  "express-jwt": ["express-jwt"],
  "koa-jwt":     ["koa-jwt"],
  none:          [],
};
```

### 2.3 Monorepo Detection

```typescript
// Check in this order:
// 1. pnpm-workspace.yaml exists → monorepo: true, tool: "pnpm-workspaces"
// 2. turbo.json exists          → monorepo: true, tool: "turbo"
// 3. nx.json exists             → monorepo: true, tool: "nx"
// 4. lerna.json exists          → monorepo: true, tool: "lerna"
// 5. package.json has "workspaces" field → monorepo: true, tool: infer from above or "pnpm-workspaces"

// For monorepos: recursively find all package.json files
// Exclude: node_modules, dist, .next, .svelte-kit, out, build, .turbo
// Run full detection on each package independently
// The top-level package is often just a workspace root — skip if no "main" or "scripts.dev"
```

---
