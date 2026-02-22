# SmokeForge — Complete Technical Implementation Plan
## GenAI-Powered Smoke Test Generator for Any JavaScript/TypeScript Application
**Version:** 1.0 | **Output Formats:** Playwright (E2E + API) · Postman Collection v2.1 | **Trigger:** CLI | **Input:** GitHub Repo (Static Source Only)

---

> **Instructions for Claude 4.6 in Copilot:**
> This document is your complete implementation specification. Every section is actionable. Do not skip sections. Do not improvise architecture not described here. When a section says "exact AST pattern", implement it exactly as shown. TypeScript throughout. Run `tsc --noEmit` after every major file. The test for success is: point the CLI at any real-world JS/TS GitHub repo and get working Playwright + Postman outputs.

---

## TABLE OF CONTENTS

1. Project Scaffold & Toolchain
2. Framework Detection System (Complete Taxonomy)
3. AST Parsing Infrastructure
4. Backend Route Extractors — Per Framework (Complete)
5. Request Schema Extractors — Per Validator Library (Complete)
6. Authentication Pattern Detector
7. Frontend UI & Locator Extractors — Per Framework (Complete)
8. Test Blueprint Builder (Intermediate JSON Contract)
9. GenAI Generation Layer (Prompts, Chunking, Retry)
10. Output Writers (Playwright + Postman)
11. CLI Implementation
12. Validation & Confidence Scoring
13. Error Handling & Edge Cases
14. End-to-End Data Flow Summary

---

## SECTION 1 — PROJECT SCAFFOLD & TOOLCHAIN

### 1.1 Repository Structure

Create this exact structure:

```
smokeforge/
├── src/
│   ├── cli/
│   │   ├── index.ts                  ← Entry point (commander.js)
│   │   └── commands/
│   │       ├── generate.ts
│   │       └── analyze.ts
│   ├── ingestion/
│   │   ├── cloner.ts                 ← Git clone + file inventory
│   │   ├── detector.ts               ← Framework detection
│   │   └── config-harvester.ts       ← Collect config files
│   ├── analysis/
│   │   ├── parser.ts                 ← Central AST parser (typescript-estree)
│   │   ├── backend/
│   │   │   ├── express.extractor.ts
│   │   │   ├── fastify.extractor.ts
│   │   │   ├── nestjs.extractor.ts
│   │   │   ├── nextjs-pages.extractor.ts
│   │   │   ├── nextjs-app.extractor.ts
│   │   │   ├── remix.extractor.ts
│   │   │   ├── koa.extractor.ts
│   │   │   ├── hapi.extractor.ts
│   │   │   ├── hono.extractor.ts
│   │   │   ├── trpc.extractor.ts
│   │   │   ├── sveltekit.extractor.ts
│   │   │   ├── elysia.extractor.ts
│   │   │   └── index.ts              ← IFrameworkExtractor interface + registry
│   │   ├── schemas/
│   │   │   ├── zod.extractor.ts
│   │   │   ├── joi.extractor.ts
│   │   │   ├── yup.extractor.ts
│   │   │   ├── class-validator.extractor.ts
│   │   │   ├── valibot.extractor.ts
│   │   │   └── typescript-types.extractor.ts
│   │   ├── auth/
│   │   │   └── auth-detector.ts
│   │   └── ui/
│   │       ├── react.extractor.ts
│   │       ├── vue.extractor.ts
│   │       ├── angular.extractor.ts
│   │       ├── svelte.extractor.ts
│   │       └── router-extractor.ts   ← Extract page/route inventory
│   ├── blueprint/
│   │   ├── builder.ts                ← Assembles TestBlueprint JSON
│   │   ├── chunker.ts                ← Splits large blueprints
│   │   └── types.ts                  ← All TypeScript interfaces
│   ├── generation/
│   │   ├── client.ts                 ← Anthropic API client wrapper
│   │   ├── playwright.generator.ts
│   │   ├── postman.generator.ts
│   │   └── prompts/
│   │       ├── playwright.system.ts
│   │       ├── postman.system.ts
│   │       └── retry.ts
│   ├── output/
│   │   ├── playwright-writer.ts
│   │   ├── postman-writer.ts
│   │   ├── validator.ts
│   │   └── reporter.ts
│   └── utils/
│       ├── file-utils.ts
│       ├── ast-utils.ts
│       └── logger.ts
├── package.json
├── tsconfig.json
└── .smokeforgerc.json                ← Default config
```

### 1.2 package.json

```json
{
  "name": "smokeforge",
  "version": "1.0.0",
  "bin": { "smokeforge": "./dist/cli/index.js" },
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/cli/index.ts",
    "test": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.24.0",
    "@typescript-eslint/typescript-estree": "^7.0.0",
    "commander": "^12.0.0",
    "simple-git": "^3.24.0",
    "zod": "^3.23.0",
    "zod-to-json-schema": "^3.23.0",
    "cosmiconfig": "^9.0.0",
    "glob": "^10.0.0",
    "chalk": "^5.3.0",
    "ora": "^8.0.0",
    "ajv": "^8.16.0",
    "typescript": "^5.4.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "ts-node": "^10.9.0",
    "vitest": "^1.6.0"
  }
}
```

### 1.3 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

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

## SECTION 3 — AST PARSING INFRASTRUCTURE

### 3.1 Central Parser

```typescript
// src/analysis/parser.ts

import { parse, TSESTree } from "@typescript-eslint/typescript-estree";
import { readFileSync } from "fs";

export interface ParsedFile {
  filePath: string;
  ast: TSESTree.Program;
  code: string;
}

export function parseFile(filePath: string): ParsedFile | null {
  try {
    const code = readFileSync(filePath, "utf-8");
    const ast = parse(code, {
      jsx: filePath.endsWith(".jsx") || filePath.endsWith(".tsx"),
      loc: true,
      range: true,
      tokens: false,
      comment: false,
      // CRITICAL: set this to allow TS syntax in .js files (common in config files)
      errorOnUnknownASTType: false,
    });
    return { filePath, ast, code };
  } catch (err) {
    // Log warning but never throw — bad files should not abort extraction
    console.warn(`[parser] Failed to parse ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

// File extensions to include in analysis
export const ANALYZABLE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"
];

// File extensions for Vue/Svelte — require special handling (extract <script> block first)
export const SCRIPT_BLOCK_EXTENSIONS = [".vue", ".svelte"];

// Directories to always skip
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  ".svelte-kit", "out", "coverage", ".turbo", ".cache", "storybook-static",
  "public", "static", "assets", ".vercel", ".netlify"
]);
```

### 3.2 AST Traversal Utilities

```typescript
// src/utils/ast-utils.ts
// These helpers are used by EVERY extractor. Implement them once here.

import { TSESTree } from "@typescript-eslint/typescript-estree";

/** Walk every node in the AST, calling visitor for each. */
export function walk(
  node: TSESTree.Node,
  visitor: (node: TSESTree.Node, parent: TSESTree.Node | null) => void,
  parent: TSESTree.Node | null = null
): void {
  visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = (node as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      child.forEach((c) => { if (c && typeof c === "object" && "type" in c) walk(c as TSESTree.Node, visitor, node); });
    } else if (child && typeof child === "object" && "type" in child) {
      walk(child as TSESTree.Node, visitor, node);
    }
  }
}

/** Extract string literal value from a node (handles Literal + TemplateLiteral). */
export function extractStringValue(node: TSESTree.Node): string | null {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  // Handle simple string concatenation: "/users" + "/" + id → "/users/"
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = extractStringValue(node.left);
    const right = extractStringValue(node.right);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}

/** Get all decorators on a class member or class declaration. */
export function getDecorators(node: TSESTree.Node): TSESTree.Decorator[] {
  // In typescript-estree v6+, decorators are on the node directly
  return (node as { decorators?: TSESTree.Decorator[] }).decorators ?? [];
}

/** Check if identifier resolves to a specific import. */
export function isImportedFrom(
  identifierName: string,
  moduleName: string,
  importDeclarations: TSESTree.ImportDeclaration[]
): boolean {
  return importDeclarations.some(
    (decl) =>
      decl.source.value === moduleName &&
      decl.specifiers.some(
        (s) => s.local.name === identifierName
      )
  );
}

/** Collect all import declarations from a file's AST. */
export function collectImports(program: TSESTree.Program): TSESTree.ImportDeclaration[] {
  return program.body.filter(
    (node): node is TSESTree.ImportDeclaration => node.type === "ImportDeclaration"
  );
}

/** Resolve require() calls to module paths. */
export function extractRequirePath(node: TSESTree.CallExpression): string | null {
  if (
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments.length === 1
  ) {
    return extractStringValue(node.arguments[0]);
  }
  return null;
}
```

---

## SECTION 4 — BACKEND ROUTE EXTRACTORS

### 4.1 IFrameworkExtractor Interface

```typescript
// src/analysis/backend/index.ts

export interface ExtractedEndpoint {
  id: string;                          // generated: "ep_001", "ep_002"...
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ALL";
  path: string;                        // normalized: "/api/v1/users/:userId"
  pathParams: PathParam[];
  queryParams: QueryParam[];
  requestBody: RequestBodySchema | null;
  responseSchema: ResponseSchema | null;
  authRequired: boolean;
  authType: AuthType | null;
  roles: string[];                     // ["admin", "manager"]
  sourceFile: string;
  sourceLine: number;
  framework: BackendFramework;
  confidence: number;                  // 0.0 - 1.0
  flags: ExtractorFlag[];              // ["CONDITIONAL_ROUTE", "DYNAMIC_PATH", "UNRESOLVED_PREFIX"]
}

export interface PathParam {
  name: string;
  type: "string" | "number" | "uuid" | "unknown";
  example: string;
}

export interface QueryParam {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  enum?: string[];
}

export interface RequestBodySchema {
  source: "zod" | "joi" | "yup" | "class-validator" | "typescript" | "inferred";
  fields: BodyField[];
  rawSchemaRef: string | null;        // e.g. "CreateUserSchema"
}

export interface BodyField {
  name: string;
  type: string;
  required: boolean;
  validators: string[];               // e.g. ["email", "min(8)", "max(128)"]
  example: string | null;
}

export type ExtractorFlag =
  | "CONDITIONAL_ROUTE"        // Inside if/switch — may not always be registered
  | "DYNAMIC_PATH"             // Path contains unresolved variable
  | "UNRESOLVED_PREFIX"        // Router prefix could not be traced
  | "WILDCARD_HANDLER"         // Uses app.use() without specific path
  | "PROXY_ROUTE"              // Detected as a proxy to another service
  | "FILE_UPLOAD"              // Detected multipart/form-data
  | "WEBSOCKET"                // ws:// upgrade handler
  | "STREAM_RESPONSE";         // Returns a stream

export interface IFrameworkExtractor {
  readonly framework: BackendFramework;
  canHandle(detection: PackageDetection): boolean;
  extract(files: ParsedFile[], detection: PackageDetection): Promise<ExtractedEndpoint[]>;
}
```

---

### 4.2 EXPRESS EXTRACTOR — Complete Implementation Spec

**Target patterns to handle:**

```typescript
// src/analysis/backend/express.extractor.ts

/*
PATTERNS TO DETECT (all of these must work):

1. Direct app methods:
   app.get('/path', handler)
   app.post('/path', validate(schema), handler)
   app.put('/path', auth, roleCheck, handler)
   app.delete('/path', handler)
   app.patch('/path', handler)
   app.all('/path', handler)   → method: "ALL"

2. Router instances:
   const router = express.Router()
   const router = Router()
   router.get('/path', handler)

3. Router.route() chaining:
   router.route('/users')
     .get(listUsers)
     .post(createUser)

4. Router prefix mounting (CRITICAL — cross-file):
   app.use('/api/v1', v1Router)              → ALL routes in v1Router get /api/v1 prefix
   app.use('/api/v1', require('./routes'))   → follow the require
   app.use('/api/v1', import('./routes'))    → follow the import

5. Conditional routes (flag as CONDITIONAL_ROUTE):
   if (process.env.FEATURE_X) { app.get('/experimental', handler) }

6. Dynamic path variables:
   const resource = 'products'
   app.get(`/${resource}/:id`, handler)   → flag as DYNAMIC_PATH, value "products"

7. Middleware chain — detect auth:
   app.use(authenticate)                   → all following routes: authRequired = true
   router.use(requireAuth)
   app.get('/path', authenticate, handler) → this route: authRequired = true

8. Role detection:
   app.get('/admin', requireRole(['admin']), handler)
   app.post('/path', authorize('admin', 'manager'), handler)
*/

/*
IMPLEMENTATION ALGORITHM:

Phase A: Build a "Router Graph"
  - For each file, find all variable declarations that create Router instances
  - Track: variableName → routerInstance
  - For each app.use(prefix, routerVar) call, record: routerVar → prefix
  - Recursively resolve require()/import() to follow cross-file mounts
  - Result: Map<routerVarName, string[]> of accumulated prefixes per router

Phase B: Extract Leaf Routes
  - Walk AST for CallExpressions where:
    callee is MemberExpression AND
    callee.property.name in ['get','post','put','patch','delete','head','options','all'] AND
    callee.object is either 'app', 'router', or any identifier known to be a Router
  - Extract: method, path (1st string arg), middleware chain (all args before last)

Phase C: Resolve Full Paths
  - For each extracted route, look up its router variable in the Router Graph
  - Concatenate: prefix + route path → normalize double slashes

Phase D: Extract Middleware Signals
  - Scan middleware chain (args between path and final handler):
    - Any arg name matching /auth|authenticate|requireAuth|passport|protect|verify/i → authRequired: true
    - Any call like requireRole([...]) → extract roles array
    - Any arg name matching /upload|multer|multipart/i → flag FILE_UPLOAD

Phase E: Resolve Params
  - After getting full path "/api/v1/users/:userId/orders/:orderId"
  - Extract all :param segments → pathParams array
  - For each pathParam, check if a validateParams(z.object({...})) is in middleware chain
  - If found, extract type from Zod schema
*/
```

**Critical cross-file resolution logic:**

```typescript
/*
REQUIRE RESOLUTION:

When you encounter:
  app.use('/api/v1', require('./routes/users'))

Steps:
1. Resolve './routes/users' relative to current file path
2. Try extensions: .ts → .js → /index.ts → /index.js
3. Parse the resolved file
4. Find its default export or named export matching the require variable
5. That export is now treated as the mounted router with prefix '/api/v1'
6. Extract routes from it as if they were local, with prefix prepended

IMPORT RESOLUTION (same logic, different syntax):

  import { userRouter } from './routes/users'
  app.use('/api/v1', userRouter)

Steps:
1. Find the ImportDeclaration for './routes/users'
2. The imported name is 'userRouter'
3. Find app.use('/api/v1', userRouter)
4. Map: 'userRouter' → prefix '/api/v1'
5. Parse the source file './routes/users'
6. Find where userRouter is defined and what routes are registered on it

MAX DEPTH: Follow require/import chains max 5 levels deep. Beyond that, flag as UNRESOLVED_PREFIX.
CIRCULAR: Track visited file paths, skip if already visited.
*/
```

---

### 4.3 FASTIFY EXTRACTOR — Complete Implementation Spec

```typescript
// src/analysis/backend/fastify.extractor.ts

/*
PATTERNS TO DETECT:

1. Direct instance methods:
   fastify.get('/path', handler)
   fastify.get('/path', { schema: { body: ... } }, handler)
   fastify.post('/path', opts, handler)
   fastify.route({ method: 'GET', url: '/path', handler })

2. Plugin system (CRITICAL — Fastify's primary pattern):
   fastify.register(plugin, { prefix: '/api/v1' })

   In the plugin file:
   async function plugin(fastify, opts) {
     fastify.get('/users', handler)     → full path: /api/v1/users
   }
   export default plugin

3. Inline schema (Fastify's built-in type provider):
   fastify.post('/users', {
     schema: {
       body: {
         type: 'object',
         properties: {
           email: { type: 'string', format: 'email' },
           name: { type: 'string' }
         },
         required: ['email', 'name']
       },
       querystring: { ... },
       params: { ... },
       response: { 200: { ... } }
     }
   }, handler)

4. TypeBox integration (@fastify/type-provider-typebox):
   const schema = {
     body: Type.Object({ email: Type.String({ format: 'email' }) })
   }
   fastify.post('/users', { schema }, handler)

5. Zod Fastify plugin (@fastify/zod):
   fastify.post('/users', { schema: { body: CreateUserSchema } }, handler)

6. Auth via hooks:
   fastify.addHook('preHandler', authenticate)           → all routes after: authRequired: true
   fastify.get('/protected', { preHandler: [auth] }, h)  → this route: authRequired: true
   fastify.register(plugin, { prefix: '/admin' })
   // in plugin: fastify.addHook('preHandler', requireAdmin)

IMPLEMENTATION ALGORITHM:

Phase A: Build Plugin Tree
  - Find all fastify.register(fn, opts) calls
  - Extract prefix from opts.prefix
  - Resolve fn to its definition (same file or imported)
  - Build tree: plugin path → prefix stack

Phase B: Extract Inline Schema
  - For each route with schema option:
    - If schema.body is JSON Schema object: convert to BodyField[]
    - If schema.body is TypeBox Type: extract via TypeBox shape recognition
    - If schema.body is Zod schema ref: hand off to Zod extractor
  - For schema.querystring: extract as QueryParam[]
  - For schema.params: extract as PathParam[]

Phase C: Hook-Based Auth Detection
  - Global hooks (fastify.addHook at root level): mark all routes as authRequired
  - Scoped hooks (inside register plugin): mark only routes in that plugin scope
  - Route-level preHandler: mark only that route
  - Look for hook names matching /auth|authenticate|verify|protect/i
*/
```

---

### 4.4 NESTJS EXTRACTOR — Complete Implementation Spec

```typescript
// src/analysis/backend/nestjs.extractor.ts

/*
NestJS is decorator-driven. ALL extraction is from decorators.

CONTROLLER-LEVEL DECORATORS:
  @Controller()                    → base path: "/"
  @Controller('users')             → base path: "/users"
  @Controller({ path: 'users', version: '1' })  → base path: "/users", version: "1"

METHOD-LEVEL HTTP DECORATORS:
  @Get()           → GET    /
  @Get(':id')      → GET    /:id
  @Post()          → POST   /
  @Put(':id')      → PUT    /:id
  @Patch(':id')    → PATCH  /:id
  @Delete(':id')   → DELETE /:id
  @Head()          → HEAD   /
  @Options()       → OPTIONS /
  @All()           → ALL    /

PARAMETER DECORATORS (extract from handler signature):
  @Param('id') id: string          → pathParam: id (type: string)
  @Param('id') id: number          → pathParam: id (type: number)  [convert with +id]
  @Query('page') page: number      → queryParam: page (type: number)
  @Query('filter') filter: FilterDto → queryParam schema from FilterDto
  @Body() body: CreateUserDto      → requestBody from CreateUserDto
  @Body('email') email: string     → partial body field: email (string)
  @Headers('x-api-key') key: string → header param

AUTH DECORATORS:
  @UseGuards(AuthGuard)            → authRequired: true
  @UseGuards(JwtAuthGuard)         → authRequired: true, authType: bearer_jwt
  @UseGuards(RolesGuard)           → authRequired: true
  @Public()                        → authRequired: false (override)
  @Roles('admin', 'manager')       → roles: ['admin', 'manager']
  
  CLASS-LEVEL guards apply to ALL methods in the controller.
  METHOD-LEVEL guards override class level.

DTO EXTRACTION (CRITICAL):
  @Body() createUserDto: CreateUserDto

  → Find the class CreateUserDto in the codebase
  → It has properties decorated with class-validator decorators:
    @IsEmail() email: string;           → field: email, type: string, validator: email
    @IsString() @MinLength(8) password  → field: password, type: string, validators: [min(8)]
    @IsOptional() @IsUUID() id?: string → field: id, optional: true, type: uuid
    @IsEnum(UserRole) role: UserRole    → field: role, type: enum[admin,user,...]

  → Also handles nested DTOs:
    @ValidateNested() @Type(() => AddressDto) address: AddressDto
    → recursively extract AddressDto fields

VERSION SUPPORT:
  app.enableVersioning({ type: VersioningType.URI })
  @Controller({ version: '1', path: 'users' }) → /v1/users
  @Version('2') @Get() getAll() → /v2/users (method override)

GLOBAL PREFIX:
  app.setGlobalPrefix('api')  → all routes prefixed /api
  (scan main.ts / bootstrap() function for this call)

MODULE RESOLUTION:
  @Module({ controllers: [UsersController, AuthController] })
  UsersModule
  → UsersModule is imported in AppModule → all controllers registered

  Build a module graph:
  1. Find AppModule (typically app.module.ts)
  2. Find all @Module decorators
  3. Extract controllers from each module
  4. Extract imported modules (recursively)
  5. All controllers across all imported modules = registered controllers

IMPLEMENTATION ALGORITHM:

Phase A: Find All Controllers
  - Scan for ClassDeclaration with @Controller() decorator
  - Extract base path from decorator argument

Phase B: For Each Controller Method
  - Find methods with @Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All
  - Extract route path from decorator arg
  - Full path = global prefix + version + controller base + method path
  - Normalize: remove double slashes, ensure leading slash

Phase C: Resolve Guards
  - Collect class-level @UseGuards
  - Collect method-level @UseGuards (overrides class-level for that method)
  - Check for @Public() decorator — if present, authRequired = false regardless

Phase D: Extract Parameters
  - For @Body() with DTO class:
    - Find DTO class declaration
    - Extract class-validator decorated properties
    - OR if DTO extends a Zod/mapped type, hand to schema extractor
  - For @Query() with DTO: same process
  - For @Param(): extract name and TypeScript type

Phase E: Version Resolution
  - Check main.ts for app.enableVersioning() call
  - If found, extract versioning type (URI = /v1/, HEADER, MEDIA_TYPE)
  - Apply version to all routes from versioned controllers
*/
```

---

### 4.5 NEXT.JS EXTRACTOR — Complete Implementation Spec

#### Next.js Pages Router (`/pages/api/`)

```typescript
// src/analysis/backend/nextjs-pages.extractor.ts

/*
FILE STRUCTURE RULES:
  /pages/api/users.ts               → /api/users
  /pages/api/users/index.ts         → /api/users
  /pages/api/users/[id].ts          → /api/users/:id
  /pages/api/users/[id]/orders.ts   → /api/users/:id/orders
  /pages/api/[...slug].ts           → /api/* (catch-all)

METHOD DETECTION:
  Each file exports a default handler function.
  Detect methods from req.method conditionals:

  Pattern 1 — switch/case:
    switch (req.method) {
      case 'GET': ...
      case 'POST': ...
    }

  Pattern 2 — if/else:
    if (req.method === 'GET') { ... }
    else if (req.method === 'POST') { ... }
    else if (req.method !== 'GET') { ... }   // negation

  Pattern 3 — object dispatch:
    const handlers = { GET: getUsers, POST: createUser }
    handlers[req.method]?.(req, res)
    → extract method names from object keys

  Pattern 4 — no method check:
    export default async function handler(req, res) { res.json(...) }
    → assume ALL methods (flag as "ALL")

  Pattern 5 — next-connect (npm package):
    const handler = nc()
    handler.get('/...', fn)   → extract like Express
    handler.post('/...', fn)

QUERY/BODY DETECTION:
  req.query.userId → query param: userId
  req.query.page, req.query.limit → query params
  req.body.email → body field: email
  const { email, password } = req.body → destructuring → body fields
  const { id } = req.query → query param: id

  If Zod validation present:
    const schema = z.object({...})
    const parsed = schema.parse(req.body)  → use Zod extractor

  If joi/yup:
    const validated = schema.validate(req.body) → use respective extractor

AUTH DETECTION:
  Higher-order wrapper:
    export default withAuth(handler)         → authRequired: true
    export default withSession(handler)      → authRequired: true
    export default authenticate(handler)     → authRequired: true

  Inside handler:
    const session = await getServerSession(req, res, authOptions)
    if (!session) return res.status(401).json(...)  → authRequired: true

  NextAuth pattern:
    import { getServerSession } from 'next-auth'
    const session = await getServerSession(...)   → next-auth detected
*/
```

#### Next.js App Router (`/app/api/` or `/app/**/route.ts`)

```typescript
// src/analysis/backend/nextjs-app.extractor.ts

/*
FILE STRUCTURE RULES:
  /app/api/users/route.ts              → /api/users
  /app/api/users/[userId]/route.ts     → /api/users/:userId
  /app/api/users/[userId]/orders/route.ts → /api/users/:userId/orders
  /app/api/[...slug]/route.ts          → /api/* (catch-all)

  NOTE: route.ts files can appear ANYWHERE in the /app directory, not just under /api/
  They coexist with page.tsx — the same directory can have both.
  /app/(dashboard)/users/route.ts → route groups strip the (group) from URL path
  Route group: (group) in path → REMOVE from URL

METHOD DETECTION:
  App Router uses NAMED EXPORTS for each HTTP method:

  export async function GET(request: NextRequest) { ... }
  export async function POST(request: NextRequest) { ... }
  export async function PUT(request: NextRequest, { params }: ...) { ... }
  export async function PATCH(request: NextRequest) { ... }
  export async function DELETE(request: NextRequest) { ... }
  export async function HEAD(request: NextRequest) { ... }
  export async function OPTIONS(request: NextRequest) { ... }

  → Scan file exports for these exact names (case-sensitive, must be uppercase)
  → Each exported function name = one registered method

PARAMETER EXTRACTION:
  Path params come via:
    { params }: { params: { userId: string } }
    → Extract from TypeScript type annotation on params

  Query params:
    const { page, limit } = Object.fromEntries(request.nextUrl.searchParams)
    request.nextUrl.searchParams.get('page')
    const url = new URL(request.url); url.searchParams.get('filter')
    → Scan function body for searchParams usage

  Request body:
    const body = await request.json()
    const { email } = await request.json()
    const formData = await request.formData()
    → If followed by Zod: const parsed = schema.parse(body) → use Zod extractor
    → Otherwise infer from destructuring

AUTH DETECTION:
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  → authRequired: true, authType: next-auth

  const token = await getToken({ req: request })
  → authRequired: true, authType: next-auth

  cookies().get('session-token')
  → authRequired: true, authType: session-cookie

  Middleware (middleware.ts at project root):
    export function middleware(request: NextRequest) {
      if (!request.cookies.get('token')) return NextResponse.redirect(...)
    }
    export const config = { matcher: ['/api/users/:path*'] }
    → ALL routes matching the matcher pattern: authRequired: true
    → CRITICAL: parse the matcher and apply to affected routes

ROUTE GROUPS AND LAYOUTS:
  /app/(auth)/login/page.tsx    → route: /login (group stripped)
  /app/(dashboard)/settings/page.tsx → route: /settings
  Strip all (group) segments when building URL paths.
*/
```

---

### 4.6 REMIX EXTRACTOR — Complete Implementation Spec

```typescript
// src/analysis/backend/remix.extractor.ts

/*
Remix uses file-based routing for BOTH pages AND API-like endpoints.
The same file handles both server (loader/action) and client (component).

FILE STRUCTURE:
  /app/routes/users._index.tsx        → GET /users   (loader) + POST /users (action)
  /app/routes/users.$userId.tsx       → GET /users/:userId
  /app/routes/users.$userId.edit.tsx  → GET /users/:userId/edit
  /app/routes/api.products.tsx        → /api/products (no UI component = API route)
  /app/routes/resource.tsx            → /resource (resource route if no default export component)

  Remix v2 "flat file" routing convention:
  /app/routes/users.$userId.orders.tsx → /users/:userId/orders
  Segments separated by "." become "/" in URL
  "$" prefix = dynamic param
  "_" prefix = layout route (not part of URL)
  "+" suffix = path param that can have slashes
  
LOADER EXTRACTION (GET behavior):
  export async function loader({ request, params }: LoaderFunctionArgs) {
    const userId = params.userId;   → pathParam: userId
    const url = new URL(request.url)
    const page = url.searchParams.get('page')   → queryParam: page
    ...
    return json(data)    → response: json
    return json(data, { status: 401 })  → check status for auth errors
  }
  → Register as GET /path with extracted params

ACTION EXTRACTION (POST/PUT/PATCH/DELETE behavior):
  export async function action({ request, params }: ActionFunctionArgs) {
    const method = request.method   → detect which HTTP methods handled
    if (request.method === 'POST') { ... }
    if (request.method === 'DELETE') { ... }
    
    const formData = await request.formData()
    const email = formData.get('email')   → bodyField: email (form-data)
    
    const body = await request.json()    → JSON body
    const parsed = schema.parse(body)    → use schema extractor
    
    return json({ success: true })
    return redirect('/users')
  }
  → Register separate endpoint per detected request.method
  → If no method check: register as POST (Remix default for actions)

AUTH DETECTION:
  const session = await getSession(request.headers.get('Cookie'))
  if (!session.get('userId')) throw redirect('/login')
  → authRequired: true, authType: session-cookie

  import { requireUser } from '~/utils/auth.server'
  const user = await requireUser(request)   → authRequired: true

  throw redirect('/login', { status: 302 })   → auth gate pattern
*/
```

---

### 4.7 TRPC EXTRACTOR — Complete Implementation Spec

```typescript
// src/analysis/backend/trpc.extractor.ts

/*
tRPC uses router/procedure definitions, not HTTP routes. The extractor must
map tRPC procedures to their equivalent HTTP endpoints via the tRPC HTTP adapter.

tRPC HTTP ADAPTER CONVENTIONS:
  Given a tRPC router mounted at /api/trpc:

  appRouter.query('users.getAll')   → GET  /api/trpc/users.getAll
  appRouter.mutation('users.create') → POST /api/trpc/users.create
  appRouter.query('users.getById')   → GET  /api/trpc/users.getById?input=...

  In tRPC v10+ (procedure builder pattern):
  export const appRouter = router({
    users: router({
      getAll: publicProcedure.query(({ ctx }) => { ... }),
      getById: publicProcedure.input(z.string()).query(({ input, ctx }) => { ... }),
      create: protectedProcedure.input(CreateUserSchema).mutation(({ input, ctx }) => { ... }),
      delete: adminProcedure.input(z.string()).mutation(({ input, ctx }) => { ... }),
    })
  })

  → users.getAll  : GET  /api/trpc/users.getAll (no input)
  → users.getById : GET  /api/trpc/users.getById?input="<string>" (query string input)
  → users.create  : POST /api/trpc/users.create (JSON body: { "0": { json: <input> } })
  → users.delete  : POST /api/trpc/users.delete

PROCEDURE TYPE MAPPING:
  .query()    → GET
  .mutation() → POST

INPUT EXTRACTION:
  .input(z.string())                  → extract Zod type
  .input(z.object({ id: z.string() })) → extract schema
  No .input()                          → no request body / no query params

AUTH DETECTION:
  Procedure middleware chain:
  const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
    return next()
  })

  → Any procedure using protectedProcedure: authRequired = true
  → Any procedure using adminProcedure: authRequired = true, roles: ['admin']

  Detection: Find procedure variable declarations, trace their middleware chain.
  If middleware throws TRPCError with code 'UNAUTHORIZED'/'FORBIDDEN' → authRequired = true

ADAPTER DETECTION:
  Find where appRouter is served:
  fetchRequestHandler({ router: appRouter, endpoint: '/api/trpc' })
  → base path: /api/trpc

  In Next.js pages:
  /pages/api/trpc/[trpc].ts → adapter file → base path: /api/trpc

  In Next.js app:
  /app/api/trpc/[trpc]/route.ts → base path: /api/trpc

  In Express:
  app.use('/trpc', createExpressMiddleware({ router: appRouter })) → base path: /trpc

  Scan for these patterns to determine the base path.
*/
```

---

### 4.8 KOA EXTRACTOR

```typescript
// src/analysis/backend/koa.extractor.ts

/*
Koa is middleware-based. Routes are registered via koa-router.

PATTERNS:
  import Router from '@koa/router'
  import Router from 'koa-router'
  const router = new Router({ prefix: '/api/v1' })
  
  router.get('/users', authenticate, async (ctx, next) => {
    const { page } = ctx.query          → queryParam: page
    ctx.body = { users: [] }
  })
  
  router.post('/users', validateBody(schema), async (ctx, next) => {
    const body = ctx.request.body       → body from middleware
    ctx.status = 201
  })

  router.param('userId', async (userId, ctx, next) => { ... })
  → pathParam: userId registered for all routes with :userId

  app.use(router.routes())
  app.use(router.allowedMethods())

PREFIX:
  new Router({ prefix: '/api/v1' }) → all routes prefixed /api/v1
  
  Nested routers:
  const parentRouter = new Router({ prefix: '/api' })
  parentRouter.use('/v1', childRouter.routes()) → child gets /api/v1

AUTH:
  router.use(jwtMiddleware)              → all subsequent routes: authRequired: true
  koa-jwt: app.use(jwt({ secret: ... })) → global auth
  Custom: middleware name matching /auth|protect|require/i
*/
```

---

### 4.9 HAPI EXTRACTOR

```typescript
// src/analysis/backend/hapi.extractor.ts

/*
Hapi uses server.route() with a config object. Very structured — high extraction accuracy.

PATTERNS:
  server.route({
    method: 'GET',              → method (can be array: ['GET', 'HEAD'])
    path: '/api/users/{userId}', → path (Hapi uses {param} not :param)
    options: {
      auth: 'jwt',              → authRequired: true, authType from strategy name
      auth: false,              → authRequired: false (public)
      validate: {
        params: Joi.object({ userId: Joi.string().uuid() }),
        query: Joi.object({ page: Joi.number().integer() }),
        payload: CreateUserSchema,   → requestBody
        headers: Joi.object({ 'x-api-key': Joi.string().required() })
      },
      tags: ['api', 'users'],
      description: 'Get user by ID'
    },
    handler: async (request, h) => { ... }
  })

  Hapi plugin:
  const plugin = {
    name: 'users',
    register: async (server, options) => {
      server.route([...routes])
    }
  }
  await server.register(plugin, { routes: { prefix: '/api/v1' } })
  → Apply prefix to all routes in plugin

PATH PARAM SYNTAX:
  {userId} → :userId (normalize to colon syntax for blueprint)
  {userId?} → optional param
  {rest*} → wildcard (flag as DYNAMIC_PATH)

AUTH SCHEMES:
  server.auth.scheme('jwt', jwtScheme)
  server.auth.strategy('jwt', 'jwt', { ... })
  server.auth.default('jwt') → all routes use jwt unless auth: false

  Detect strategy names and map to authType:
  'jwt' → bearer_jwt
  'session' / 'cookie' → session_cookie
  'basic' → basic_auth
  'bearer' → bearer_jwt
*/
```

---

### 4.10 HONO EXTRACTOR

```typescript
// src/analysis/backend/hono.extractor.ts

/*
Hono is very similar to Express but modern. Used heavily with Cloudflare Workers, Bun, Deno.

PATTERNS:
  const app = new Hono()
  const app = new Hono().basePath('/api')  → all routes prefixed /api

  app.get('/users', (c) => c.json({ users: [] }))
  app.post('/users', async (c) => {
    const body = await c.req.json()       → body: any
    const { email } = await c.req.json()  → bodyField: email
    return c.json({ id: 'new-id' }, 201)
  })
  app.put('/users/:userId', (c) => { const id = c.req.param('userId') })
  app.delete('/users/:userId', (c) => { ... })

  Routing groups:
  const usersRoute = new Hono()
  usersRoute.get('/', listUsers)
  usersRoute.post('/', createUser)
  app.route('/users', usersRoute)   → all usersRoute routes get /users prefix

  Middleware:
  app.use('*', bearerAuth({ token: process.env.API_TOKEN }))
  app.use('/admin/*', adminAuth)
  app.get('/protected', authMiddleware, handler)

  Hono RPC (typed client — extract like tRPC):
  const routes = app
    .get('/users', ...)
    .post('/users', ...)
  export type AppType = typeof routes  → this is the RPC type

VALIDATORS (Hono Zod Validator):
  import { zValidator } from '@hono/zod-validator'
  app.post('/users', zValidator('json', CreateUserSchema), (c) => { ... })
  → requestBody: extract from CreateUserSchema
  
  zValidator('query', QuerySchema) → queryParams from QuerySchema
  zValidator('param', ParamSchema) → pathParams from ParamSchema

BASEPATH:
  const app = new Hono().basePath('/api/v1')
  → prefix all routes with /api/v1
  Look for .basePath() call on the Hono instance.
*/
```

---

### 4.11 SVELTEKIT SERVER ROUTES EXTRACTOR

```typescript
// src/analysis/backend/sveltekit.extractor.ts

/*
SvelteKit uses file-based routing. API endpoints are server-only files.

FILE NAMING:
  /src/routes/api/users/+server.ts        → /api/users
  /src/routes/api/users/[userId]/+server.ts → /api/users/:userId
  /src/routes/api/[...path]/+server.ts    → /api/* (catch-all)

  Non-api routes can also have server functions:
  /src/routes/users/+page.server.ts  → server-side page load (GET behavior)
  /src/routes/users/+page.server.ts  → actions (POST behavior)

+server.ts — API endpoints:
  export async function GET({ url, params, request, cookies }) { ... }
  export async function POST({ request, params }) { ... }
  export async function PUT({ request, params }) { ... }
  export async function PATCH({ request, params }) { ... }
  export async function DELETE({ params }) { ... }

  → Named exports (uppercase) = registered methods (same as Next.js App Router)
  
  Parameter extraction:
  params.userId → pathParam from [userId] folder name
  url.searchParams.get('page') → queryParam: page
  const body = await request.json() → JSON body
  const data = await request.formData() → form body

+page.server.ts — load functions:
  export async function load({ params, url, cookies, locals }) { ... }
  → GET /<route> (page load, browser navigation)
  
  export const actions = {
    default: async ({ request }) => { ... },      → POST (unnamed action)
    create: async ({ request }) => { ... },        → POST ?/create
    delete: async ({ request, params }) => { ... } → POST ?/delete
  }
  → POST /<route> (form actions)

AUTH DETECTION:
  In hooks.server.ts:
    export const handle = sequence(authenticate, authorize)
  In +server.ts:
    const session = await locals.getSession()
    if (!session) throw error(401, 'Unauthorized')
  In +page.server.ts:
    if (!locals.user) redirect(302, '/login')
  → authRequired: true for affected routes
*/
```

---

### 4.12 ELYSIA EXTRACTOR (Bun)

```typescript
// src/analysis/backend/elysia.extractor.ts

/*
Elysia is Bun-native, Express-like but with built-in type safety.

PATTERNS:
  const app = new Elysia()
  app.get('/users', () => 'hello')
  app.post('/users', ({ body }) => body, {
    body: t.Object({ email: t.String() })    → TypeBox schema for body
  })
  app.get('/users/:id', ({ params: { id } }) => id)  → pathParam: id

  Group routing:
  app.group('/api', (app) =>
    app
      .get('/users', listUsers)
      .post('/users', createUser, { body: CreateUserSchema })
  )
  → All routes in group: prefix /api

  Plugin:
  app.use(usersPlugin)  → follow plugin definition

  Type safety schemas (TypeBox via @sinclair/typebox):
  t.Object({ email: t.String({ format: 'email' }), age: t.Number() })
  → extract as BodyField[]

  Elysia-specific guards:
  app.guard({ beforeHandle: [authenticate] }, (app) =>
    app.get('/protected', handler)
  )
  → authRequired: true for routes inside the guard

  onBeforeHandle hook:
  app.onBeforeHandle(({ request, set }) => {
    if (!request.headers.get('Authorization')) set.status = 401
  })
  → global auth detection
*/
```

---

## SECTION 5 — REQUEST SCHEMA EXTRACTORS

### 5.1 ZOD SCHEMA EXTRACTOR (Most Common — Highest Priority)

```typescript
// src/analysis/schemas/zod.extractor.ts

/*
Zod schemas appear in multiple forms. Handle ALL of them.

FORM 1 — Direct object schema:
  const CreateUserSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(128),
    role: z.enum(['admin', 'user']).default('user'),
    age: z.number().int().min(18).optional(),
    profile: z.object({ bio: z.string().optional() }),    // nested
  })

FORM 2 — Chained from another schema:
  const UpdateUserSchema = CreateUserSchema.partial()
  const AdminUserSchema = CreateUserSchema.extend({ permissions: z.array(z.string()) })
  const LoginSchema = CreateUserSchema.pick({ email: true, password: true })
  const PublicSchema = CreateUserSchema.omit({ password: true })

FORM 3 — Discriminated union:
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('email'), email: z.string().email() }),
    z.object({ type: z.literal('phone'), phone: z.string() }),
  ])

FORM 4 — Inline schema (defined directly in route handler):
  router.post('/users', async (req, res) => {
    const parsed = z.object({ email: z.string() }).parse(req.body)
  })

FORM 5 — Schema passed to validator middleware:
  validateBody(z.object({ email: z.string() }))
  zValidator('json', z.object({ email: z.string() }))

EXTRACTION ALGORITHM:
1. Find all variable declarations where init is a ZodType CallExpression
   (callee is MemberExpression where object.name === 'z' OR any alias of z)
   
2. Build a schema registry: Map<variableName, ZodSchemaAST>

3. When a route references a schema by name (e.g., validateBody(CreateUserSchema)):
   Look up in registry → extract fields

4. For each z.object({...}):
   Extract each property:
   - Property key = field name
   - Chain analysis:
     z.string()           → type: string
     z.number()           → type: number
     z.boolean()          → type: boolean
     z.date()             → type: string, format: date-time
     z.array(z.string())  → type: array, items: string
     z.enum(['a','b'])    → type: enum, values: ['a','b']
     z.literal('admin')   → type: literal, value: 'admin'
     z.object({...})      → type: object, nested
     z.union([...])       → type: union
     z.record(z.string()) → type: object, additionalProperties: string
     .optional()          → required: false
     .default(x)          → required: false, default: x
     .email()             → validator: email
     .url()               → validator: url
     .uuid()              → validator: uuid, type hint: uuid
     .min(n)              → validator: min(n)
     .max(n)              → validator: max(n)
     .regex(r)            → validator: regex(pattern)
     .int()               → validator: integer
     .positive()          → validator: positive
     .nonempty()          → validator: nonempty
     
5. For chained schemas (.partial(), .pick(), .omit(), .extend()):
   - .partial() → mark all fields as optional: true
   - .pick({a,b}) → keep only keys a and b
   - .omit({a,b}) → exclude keys a and b
   - .extend({c: z.string()}) → add field c
   Apply these transformations on top of the base schema

USE zod-to-json-schema LIBRARY AS FALLBACK:
  For complex schemas that can't be parsed from AST alone,
  use the library at runtime if available in the target repo.
  Import it dynamically and run it against the schema module.
  This gives JSON Schema output which is highly accurate.
  
  How: After cloning the repo, attempt:
  1. npm install (or pnpm/yarn install) in the cloned repo
  2. Run a small Node.js script that imports the schemas and passes them through zod-to-json-schema
  3. If this succeeds: use the JSON Schema output (confidence: 0.95)
  4. If it fails: fall back to AST analysis (confidence: 0.75)
*/
```

### 5.2 JOI SCHEMA EXTRACTOR

```typescript
// src/analysis/schemas/joi.extractor.ts

/*
PATTERNS:
  const schema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(128).required(),
    role: Joi.string().valid('admin', 'user').default('user'),
    age: Joi.number().integer().min(18).optional(),
    tags: Joi.array().items(Joi.string()),
  })

TYPE MAPPINGS:
  Joi.string()          → type: string
  Joi.number()          → type: number
  Joi.boolean()         → type: boolean
  Joi.date()            → type: string, format: date
  Joi.array().items(x)  → type: array, items: x
  Joi.object({})        → type: object, nested
  Joi.any()             → type: any
  Joi.binary()          → type: binary (flag FILE_UPLOAD if used in body)
  
  .required()    → required: true
  .optional()    → required: false
  .allow(null)   → nullable: true
  .valid('a','b') → enum: ['a','b']
  .default(x)    → default: x
  .email()       → validator: email
  .uri()         → validator: url
  .guid()        → validator: uuid
  .min(n)        → validator: min(n)
  .max(n)        → validator: max(n)
  .integer()     → validator: integer
  .pattern(re)   → validator: regex

HAPI-SPECIFIC:
  Joi is Hapi's native validator — it appears in route config directly.
  validate.params, validate.query, validate.payload, validate.headers
*/
```

### 5.3 CLASS-VALIDATOR EXTRACTOR (NestJS DTOs)

```typescript
// src/analysis/schemas/class-validator.extractor.ts

/*
class-validator uses TypeScript class decorators. Used almost exclusively with NestJS.

PATTERN:
  export class CreateUserDto {
    @ApiProperty({ example: 'user@example.com' })    // Swagger — extract example
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @IsString()
    @MinLength(8)
    @MaxLength(128)
    password: string;

    @IsOptional()
    @IsEnum(UserRole)
    role?: UserRole = UserRole.USER;

    @IsOptional()
    @IsUUID('4')
    departmentId?: string;

    @ValidateNested()
    @Type(() => AddressDto)
    address?: AddressDto;

    @IsArray()
    @IsString({ each: true })
    tags: string[] = [];
  }

DECORATOR MAPPINGS:
  @IsString()       → type: string
  @IsNumber()       → type: number
  @IsBoolean()      → type: boolean
  @IsDate()         → type: string, format: date
  @IsEmail()        → type: string, validator: email
  @IsUrl()          → type: string, validator: url
  @IsUUID('4')      → type: string, validator: uuid
  @IsEnum(EnumType) → type: enum, extract EnumType values
  @IsArray()        → type: array
  @IsObject()       → type: object
  @IsInt()          → type: number, validator: integer
  @IsPositive()     → validator: positive
  @Min(n)           → validator: min(n)
  @Max(n)           → validator: max(n)
  @MinLength(n)     → validator: minLength(n)
  @MaxLength(n)     → validator: maxLength(n)
  @Matches(regex)   → validator: regex
  @IsOptional()     → required: false
  @IsNotEmpty()     → validator: notEmpty

  @ValidateNested() + @Type(() => ChildDto) → nested DTO, recursively extract

TYPESCRIPT PROPERTY TYPES:
  If no type decorator, fall back to TypeScript type annotation:
  email: string  → type: string
  count: number  → type: number
  flag?: boolean → type: boolean, required: false (? = optional)
  tags: string[] → type: array, items: string

ENUM RESOLUTION:
  @IsEnum(UserRole) where:
  enum UserRole { ADMIN = 'admin', USER = 'user' }
  → Extract enum values: ['admin', 'user']

@ApiProperty() EXTRACTION:
  @ApiProperty({ example: 'user@example.com', description: 'User email' })
  → example value available for test data generation
  @ApiProperty({ required: false }) → required: false override
*/
```

### 5.4 TYPESCRIPT TYPES EXTRACTOR (Fallback)

```typescript
// src/analysis/schemas/typescript-types.extractor.ts

/*
When no schema library is used, extract from TypeScript interfaces/types.
This is the lowest-confidence extractor.

PATTERNS:
  interface CreateUserRequest {
    email: string;
    password: string;
    role?: 'admin' | 'user';       // optional + string literal union
    age: number;
    profile?: {                     // nested optional object
      bio?: string;
      avatarUrl?: string;
    };
    tags: string[];
  }

  type LoginRequest = {
    email: string;
    password: string;
  }

TYPE MAPPING:
  string    → type: string
  number    → type: number
  boolean   → type: boolean
  Date      → type: string, format: date-time
  string[]  → type: array, items: string
  Record<string, string> → type: object, additionalProperties: string
  string | number → type: union
  'admin' | 'user' → type: enum, values: ['admin', 'user']
  undefined       → ignore field
  null            → nullable: true
  any             → type: any (low confidence flag)
  T | undefined   → required: false (same as optional)

  Property with ? suffix: required: false

INFERENCE FROM USAGE:
  If no explicit type annotation on body params:
  const { email, password } = req.body
  → fields: email (type: unknown), password (type: unknown)
  → low confidence, flag for review

CONFIDENCE LEVELS:
  Interface/type found: 0.70
  Inline destructuring only: 0.40
  No schema found at all: 0.20 (generate minimal test with TODO comment)
*/
```

---

## SECTION 6 — AUTHENTICATION PATTERN DETECTOR

```typescript
// src/analysis/auth/auth-detector.ts

/*
Auth detection is cross-cutting across all frameworks.
Run this AFTER all route extraction to enrich each endpoint.

AUTH TYPES TO DETECT:
  "bearer_jwt"       → Authorization: Bearer <token>
  "api_key_header"   → x-api-key: <key> or similar custom header
  "api_key_query"    → ?api_key=<key> or ?apiKey=<key>
  "basic_auth"       → Authorization: Basic <base64>
  "session_cookie"   → Cookie: session=<value>
  "next_auth"        → next-auth session management
  "firebase"         → Firebase ID token
  "supabase"         → Supabase JWT
  "clerk"            → Clerk session token
  "oauth_bearer"     → OAuth2 access token (Bearer)

DETECTION STRATEGY PER AUTH LIBRARY:

1. jsonwebtoken / jose:
   - Find jwt.verify(token, secret) calls
   - The token comes from: request headers authorization, cookies, query params
   - Detect which: req.headers.authorization → bearer_jwt
   - Detect split: authHeader.split(' ')[1] → extracting Bearer token

2. passport.js:
   - passport.use(new JwtStrategy(...)) → bearer_jwt
   - passport.use(new LocalStrategy(...)) → username/password (basic)
   - passport.authenticate('jwt', ...) → bearer_jwt
   - passport.authenticate('local', ...) → session
   - Find strategy registrations to determine auth type

3. next-auth / Auth.js:
   - getServerSession(authOptions) → next_auth
   - getToken({ req }) → next_auth (JWT mode)
   - Session stored in cookie: next-auth.session-token → session_cookie

4. express-jwt / koa-jwt:
   - jwt({ secret, algorithms: ['RS256'] }) → bearer_jwt
   - Detect credentialsRequired: false → optional auth
   
5. Manual header extraction patterns:
   req.headers.authorization → bearer_jwt
   req.headers['x-api-key'] → api_key_header
   req.query.api_key → api_key_query
   req.cookies.sessionId → session_cookie

LOGIN ENDPOINT DETECTION:
  The login endpoint is critical for test generation (all auth'd tests need a token first).
  
  Heuristics to find the login endpoint:
  1. Path matching: /auth/login, /login, /api/auth/login, /api/v1/auth/login, /auth/signin
  2. Body fields: email + password (or username + password)
  3. Response: returns accessToken, token, jwt, or sets auth cookie
  4. Method: POST
  
  Once found, record as:
  {
    loginEndpoint: "POST /api/v1/auth/login",
    credentialsFields: { email: "email", password: "password" },
    tokenResponseField: "accessToken",      // or "token", "jwt", "data.accessToken"
    tokenType: "bearer_jwt"
  }

  If login endpoint not found: flag warning, generate tests with placeholder token.

REFRESH TOKEN DETECTION:
  Path matching: /auth/refresh, /api/auth/refresh-token
  Body: { refreshToken: string }
  Response: { accessToken: string }
  Record as refreshEndpoint for use in test fixtures.
*/
```

---

## SECTION 7 — FRONTEND UI & LOCATOR EXTRACTORS

### 7.1 REACT EXTRACTOR

```typescript
// src/analysis/ui/react.extractor.ts

/*
SCAN ALL .tsx, .jsx FILES in component directories.

LOCATOR EXTRACTION PRIORITY (implement in this exact order):

PRIORITY 1 — data-testid (highest confidence: 0.95):
  <button data-testid="submit-button">     → getByTestId('submit-button')
  <input data-testid="email-input" />      → getByTestId('email-input')
  <div data-testid="user-card-{id}">       → getByTestId(`user-card-${id}`) — flag as DYNAMIC_TESTID
  <form data-testid="login-form">          → getByTestId('login-form')

  Also detect:
  data-cy="..."      → Cypress convention, same value, use getByTestId()
  data-e2e="..."     → custom convention, same value
  data-pw="..."      → Playwright convention, use getByTestId()
  data-automation="..." → automation convention

PRIORITY 2 — ARIA labels (confidence: 0.85):
  <button aria-label="Close modal">        → getByRole('button', { name: 'Close modal' })
  <input aria-label="Email address" />     → getByLabel('Email address')
  <nav aria-label="Main navigation">       → getByRole('navigation', { name: 'Main navigation' })
  aria-labelledby="heading-id"            → getByRole('region', { name: /heading text/i })

PRIORITY 3 — HTML roles and semantic elements (confidence: 0.75):
  <button type="submit">Login</button>     → getByRole('button', { name: 'Login' })
  <button>Cancel</button>                 → getByRole('button', { name: 'Cancel' })
  <a href="/dashboard">Dashboard</a>      → getByRole('link', { name: 'Dashboard' })
  <input type="email" />                  → getByRole('textbox') [generic fallback]
  <input type="password" />               → locator('input[type="password"]')
  <input type="checkbox" />               → getByRole('checkbox')
  <select name="country">                 → getByRole('combobox')
  <textarea />                            → getByRole('textbox')
  <h1>Page Title</h1>                     → getByRole('heading', { name: 'Page Title', level: 1 })
  <img alt="Product photo" />             → getByAltText('Product photo')
  <table>                                 → getByRole('table')
  <dialog>                                → getByRole('dialog')
  <form>                                  → use form locator (getByRole('form'))

  ELEMENT → ROLE MAPPING:
  button    → 'button'
  a[href]   → 'link'
  input[type=text] → 'textbox'
  input[type=email] → 'textbox'
  input[type=search] → 'searchbox'
  input[type=checkbox] → 'checkbox'
  input[type=radio] → 'radio'
  input[type=number] → 'spinbutton'
  input[type=range] → 'slider'
  select   → 'combobox' (single) or 'listbox' (multiple)
  textarea → 'textbox'
  h1-h6    → 'heading' (with level)
  nav      → 'navigation'
  main     → 'main'
  header   → 'banner'
  footer   → 'contentinfo'
  aside    → 'complementary'
  section  → 'region' (only if has aria-label/aria-labelledby)
  dialog   → 'dialog'
  alert    → 'alert'
  img      → 'img' (use getByAltText instead)
  table    → 'table'
  li       → 'listitem'
  ul/ol    → 'list'

PRIORITY 4 — Labels (confidence: 0.80):
  <label htmlFor="email">Email</label>
  <input id="email" />
  → getByLabel('Email')

  <label>
    Password
    <input type="password" />
  </label>
  → getByLabel('Password')

  Placeholder text (last resort before CSS):
  <input placeholder="Enter your email" />  → getByPlaceholder('Enter your email')

PRIORITY 5 — CSS selectors (confidence: 0.50 — flag as BRITTLE):
  className="login-btn"     → locator('.login-btn')
  id="submit-btn"           → locator('#submit-btn')
  className="btn btn-primary" → locator('.btn.btn-primary') [multi-class]

FORM FLOW DETECTION:
  Find <form> elements and extract complete interaction sequences:

  <form data-testid="login-form" onSubmit={handleLogin}>
    <input type="email" id="email" />       → step 1: fill email
    <input type="password" id="password" /> → step 2: fill password
    <button type="submit">Login</button>    → step 3: click submit
  </form>

  Output:
  {
    name: "loginFlow",
    formTestId: "login-form",
    steps: [
      { action: "fill", locator: "getByLabel('Email')", value: "{TEST_EMAIL}" },
      { action: "fill", locator: "locator('input[type=password]')", value: "{TEST_PASSWORD}" },
      { action: "click", locator: "getByRole('button', { name: 'Login' })" }
    ],
    submitLinkedEndpoint: "POST /api/v1/auth/login"   // match via URL analysis
  }

DYNAMIC/CONDITIONAL RENDERING:
  {isLoggedIn && <button data-testid="logout-btn">Logout</button>}
  → Include locator but flag as CONDITIONAL_ELEMENT
  → Generate test step with await expect(locator).toBeVisible() before interaction

  {items.map((item) => (
    <div data-testid={`product-${item.id}`}>   → flag as DYNAMIC_TESTID
  ))}
  → Generate locator: page.getByTestId(/^product-/) [regex match]

TEXT EXTRACTION FROM JSX:
  <button>Submit Order</button>  → text: "Submit Order"
  <span>Loading...</span>        → text: "Loading..."
  Exclude: JSX expressions {variable}, {t('key')}, {children}
  Include: raw string literals only (with confidence flag for i18n keys)

COMPONENT PROP DETECTION:
  For reusable components:
  <Button testId="save-btn" onClick={save}>Save</Button>
  → If Button component renders: <button data-testid={testId}>
  → Resolve to: getByTestId('save-btn')
  
  This requires following the component definition. Implement max 1 level deep.
*/
```

### 7.2 ROUTER EXTRACTOR (Page Inventory)

```typescript
// src/analysis/ui/router-extractor.ts

/*
Extract the complete route/page inventory across all routing solutions.
This determines what pages to generate E2E tests for.

REACT ROUTER v5:
  <Route exact path="/users" component={UsersPage} />
  <Route path="/users/:userId" component={UserDetailPage} />
  <PrivateRoute path="/admin" component={AdminPage} />   → authRequired: true
  
  Switch:
  <Switch>
    <Route path="/login" component={Login} />
    <Route path="/dashboard" component={Dashboard} />
    <Redirect from="/" to="/dashboard" />
  </Switch>

REACT ROUTER v6:
  <Routes>
    <Route path="/" element={<Layout />}>
      <Route index element={<Home />} />
      <Route path="users" element={<Users />} />
      <Route path="users/:userId" element={<UserDetail />} />
      <Route path="*" element={<NotFound />} />
    </Route>
  </Routes>
  
  useRoutes([
    { path: '/', element: <Home /> },
    { path: '/users', element: <Users /> },
    { path: '/users/:userId', element: <UserDetail /> },
  ])

TANSTACK ROUTER (v1):
  createRoute({ getParentRoute: () => rootRoute, path: '/users', component: Users })
  createRoute({ getParentRoute: () => usersRoute, path: '$userId', component: UserDetail })

NEXT.JS (Pages Router):
  Derive from /pages directory:
  /pages/index.tsx           → /
  /pages/users/index.tsx     → /users
  /pages/users/[userId].tsx  → /users/:userId
  /pages/auth/login.tsx      → /auth/login
  Skip: /pages/_app.tsx, /pages/_document.tsx, /pages/api/**

NEXT.JS (App Router):
  Derive from /app directory (files named page.tsx):
  /app/page.tsx                        → /
  /app/dashboard/page.tsx              → /dashboard
  /app/users/page.tsx                  → /users
  /app/users/[userId]/page.tsx         → /users/:userId
  /app/(auth)/login/page.tsx           → /login (group stripped)
  Skip: layout.tsx, loading.tsx, error.tsx, not-found.tsx, route.ts

VUE ROUTER:
  Parse router definition file (router/index.ts or router.ts):
  const routes: RouteRecordRaw[] = [
    { path: '/', component: Home },
    { path: '/users', component: Users, meta: { requiresAuth: true } },
    { path: '/users/:userId', component: UserDetail },
    {
      path: '/admin',
      component: AdminLayout,
      meta: { requiresAuth: true, roles: ['admin'] },
      children: [
        { path: 'users', component: AdminUsers },
        { path: 'settings', component: AdminSettings },
      ]
    }
  ]
  
  meta.requiresAuth → authRequired: true
  meta.roles → roles array

NUXT (auto-routing from /pages dir — same as Next.js Pages Router but .vue files):
  /pages/index.vue → /
  /pages/users/[id].vue → /users/:id

ANGULAR:
  Parse app-routing.module.ts:
  const routes: Routes = [
    { path: '', component: HomeComponent },
    { path: 'users', component: UsersComponent, canActivate: [AuthGuard] },
    { path: 'users/:userId', component: UserDetailComponent },
    { path: 'admin', loadChildren: () => import('./admin/admin.module').then(m => m.AdminModule),
      canActivate: [AdminGuard] }
  ]
  canActivate: [AuthGuard] → authRequired: true
  loadChildren: follow lazy-loaded module, extract its routes too

PAGE METADATA OUTPUT:
  For each detected page, produce:
  {
    id: "page_001",
    route: "/users/:userId",
    title: "User Detail",           // from component name, page title, or H1
    filePath: "src/pages/users/[userId].tsx",
    authRequired: boolean,
    roles: string[],
    isDynamic: boolean,             // contains route params
    params: [{ name: "userId", type: "string" }],
    linkedBackendEndpoints: string[] // matched by convention: /users/:userId → GET /api/users/:userId
  }
*/
```

### 7.3 VUE EXTRACTOR

```typescript
// src/analysis/ui/vue.extractor.ts

/*
Vue SFCs (.vue files) require <script> block extraction first.

PREPROCESSING:
  Read .vue file
  Extract content between <script> or <script setup> tags
  Also extract template from <template> tag
  Parse script block as TypeScript/JavaScript
  Parse template as HTML-like (use a simple regex-based HTML parser for attributes)

SCRIPT SETUP (Vue 3 Composition API with <script setup>):
  <script setup lang="ts">
  const email = ref('')
  const handleSubmit = async () => { ... }
  </script>
  
  <template>
    <form @submit.prevent="handleSubmit" data-testid="login-form">
      <input v-model="email" type="email" aria-label="Email address" />
      <button type="submit" data-testid="login-btn">Login</button>
    </form>
  </template>

TEMPLATE LOCATOR EXTRACTION (from HTML template):
  data-testid="..."    → getByTestId(...)
  :data-testid="..."   → dynamic binding — flag as DYNAMIC_TESTID
  aria-label="..."     → getByLabel(...)
  
  Element + text content:
  <button>Submit</button>          → getByRole('button', { name: 'Submit' })
  <a href="/users">Users</a>       → getByRole('link', { name: 'Users' })
  
  v-if="condition"                 → flag locator as CONDITIONAL_ELEMENT
  v-for="item in items"           → flag locator as DYNAMIC_LIST

OPTIONS API (Vue 2/3 Options API):
  export default {
    name: 'LoginForm',
    methods: {
      handleSubmit() { ... }
    }
  }
  → component name for labeling
*/
```

### 7.4 ANGULAR EXTRACTOR

```typescript
// src/analysis/ui/angular.extractor.ts

/*
Angular uses TypeScript classes + HTML templates in separate files.

COMPONENT FILE PAIRS:
  user.component.ts + user.component.html
  Find component decorator:
  @Component({
    selector: 'app-user',
    templateUrl: './user.component.html',  → load and parse this file
    template: `<div>...</div>`             → inline template
  })

TEMPLATE LOCATOR EXTRACTION (from .html files):
  data-testid="..."        → getByTestId(...)
  [attr.data-testid]="..." → dynamic — flag DYNAMIC_TESTID
  aria-label="..."         → getByLabel(...)
  
  Angular-specific:
  *ngIf="condition"        → flag CONDITIONAL_ELEMENT
  *ngFor="let x of xs"    → flag DYNAMIC_LIST
  (click)="handler()"     → interactive element
  [(ngModel)]="field"     → form field binding
  [formControlName]="'email'" → reactive form field
  
REACTIVE FORMS (most common in Angular):
  In component TypeScript:
  this.loginForm = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]]
  })
  
  In template:
  <form [formGroup]="loginForm" (ngSubmit)="onSubmit()">
    <input formControlName="email" />
    <input formControlName="password" type="password" />
    <button type="submit">Login</button>
  </form>
  
  → Extract form fields from fb.group() definition
  → Each key = form field name
  → Validators array = validators for schema hints
  → Generate locator: locator('[formControlName="email"]')
  
TEMPLATE-DRIVEN FORMS:
  <input [(ngModel)]="user.email" name="email" required />
  → locator('[name="email"]')

ROUTING GUARDS:
  canActivate: [AuthGuard] in routing config → authRequired: true
  Examine AuthGuard.canActivate() method:
  if (!this.authService.isLoggedIn()) return this.router.createUrlTree(['/login'])
  → Confirms auth requirement
*/
```

---

## SECTION 8 — TEST BLUEPRINT BUILDER

### 8.1 Blueprint TypeScript Interfaces (Source of Truth)

```typescript
// src/blueprint/types.ts
// THIS IS THE COMPLETE TYPE CONTRACT. EVERY FIELD MATTERS.

export interface TestBlueprint {
  // Metadata
  repoUrl: string;
  repoName: string;
  analysisTimestamp: string;
  smokeforgeVersion: string;
  
  // Detection results
  frameworks: {
    backend: BackendFramework[];
    frontend: FrontendFramework[];
    schemas: SchemaLibrary[];
    auth: AuthLibrary[];
    router: RouterLibrary[];
  };
  
  // Auth configuration (CRITICAL for test generation)
  auth: AuthConfig | null;
  
  // The goods
  endpoints: ExtractedEndpoint[];
  pages: ExtractedPage[];
  
  // Generation hints
  baseUrlEnvVar: string;        // "BASE_URL" (always use env var)
  testDataHints: TestDataHints;
}

export interface AuthConfig {
  loginEndpoint: string;           // "POST /api/v1/auth/login"
  credentialsFields: {
    emailField: string;            // "email"
    passwordField: string;         // "password"
    emailEnvVar: string;           // "SMOKE_TEST_EMAIL"
    passwordEnvVar: string;        // "SMOKE_TEST_PASSWORD"
  };
  tokenResponsePath: string;       // "accessToken" or "data.token" (dot notation)
  tokenType: AuthType;             // "bearer_jwt"
  tokenHeaderName: string;         // "Authorization"
  tokenHeaderFormat: string;       // "Bearer {token}"
  refreshEndpoint: string | null;  // "POST /api/v1/auth/refresh" or null
  authCookieName: string | null;   // "session" or null (if cookie-based)
}

export interface ExtractedPage {
  id: string;
  route: string;                   // "/users/:userId"
  normalizedRoute: string;         // "/users/test-user-id" (with example values)
  title: string;
  filePath: string;
  authRequired: boolean;
  roles: string[];
  isDynamic: boolean;
  routeParams: Array<{ name: string; example: string }>;
  
  locators: ExtractedLocator[];
  formFlows: FormFlow[];
  navigationLinks: NavigationLink[];
  
  linkedEndpoints: string[];       // endpoint IDs that this page calls
  confidence: number;
}

export interface ExtractedLocator {
  id: string;
  name: string;                    // camelCase identifier: "submitButton"
  playwrightCode: string;          // exact code: "page.getByRole('button', { name: 'Login' })"
  strategy: "testId" | "role" | "label" | "placeholder" | "altText" | "css" | "text";
  elementType: "button" | "input" | "link" | "select" | "textarea" | "form" | "heading" | "other";
  isInteractive: boolean;
  isConditional: boolean;          // true if behind v-if, *ngIf, conditional rendering
  isDynamic: boolean;              // true if value is runtime-computed
  confidence: number;
  flags: ExtractorFlag[];
}

export interface FormFlow {
  id: string;
  name: string;                    // "loginFlow", "createUserFlow"
  testId: string | null;           // form's data-testid if present
  steps: FormStep[];
  linkedEndpointId: string | null; // which API endpoint this form submits to
  successRedirectHint: string | null;  // "/dashboard" if detectable
}

export interface FormStep {
  order: number;
  action: "fill" | "click" | "check" | "uncheck" | "select" | "upload" | "clear";
  locatorCode: string;             // "page.getByLabel('Email')"
  testValue: string | null;        // "{SMOKE_TEST_EMAIL}" for email fields
  fieldType: string;               // "email", "password", "text", "submit", "checkbox"
}

export interface TestDataHints {
  emailFormat: string;             // "smoketest+{random}@example.com"
  passwordFormat: string;          // "SmokeTest123!"
  uuidExample: string;             // "11111111-2222-3333-4444-555555555555"
  numberExample: number;           // 1
  stringExample: string;           // "smoke-test-value"
}
```

### 8.2 Blueprint Builder Logic

```typescript
// src/blueprint/builder.ts

/*
ASSEMBLY ALGORITHM:

1. Run ALL framework extractors concurrently (Promise.all)
2. Merge and deduplicate endpoints:
   - Deduplicate by: method + normalized path
   - Merge auth info: if any extractor flags authRequired, it's true
   - Keep highest-confidence extraction

3. Link endpoints to pages:
   For each page, find endpoints that:
   a. Are called in the page's component file (scan fetch('/api/users'), axios.get('/api/users'))
   b. Match by convention: /users → GET /api/users, /users/:id → GET /api/users/:id
   c. Are found in a linked form flow (form action URL)

4. Generate normalizedRoute:
   Replace :param segments with example values from PathParam.example
   "/users/:userId" → "/users/11111111-2222-3333-4444-555555555555"
   "/products/:productId/variants/:variantId" → "/products/..." 

5. Generate test data values per field type:
   type: string + validator: email → "{SMOKE_TEST_EMAIL}"
   type: string + validator: uuid → "11111111-2222-3333-4444-555555555555"
   type: string + validator: url → "https://example.com/test"
   type: number → 1
   type: boolean → true
   type: string (generic) → "smoke-test"
   type: enum → first value in enum array
   required: false → omit from smoke test (keep it minimal)

CHUNKING STRATEGY (src/blueprint/chunker.ts):
  A "chunk" is a slice of the blueprint sent to GenAI in one API call.
  
  Rules:
  - Max 15 endpoints per chunk
  - Max 10 pages per chunk
  - Group by domain: /api/v1/auth/* → auth chunk, /api/v1/users/* → users chunk
  - Domain detection: split path at 3rd segment: /api/v1/{domain}/...
  - If a domain has >15 endpoints, split alphabetically
  - Each chunk includes the full AuthConfig (needed in every generated test)
  - Each chunk includes TestDataHints
  
  Output: BlueprintChunk[]
  Each chunk has a domain label used to name the output file.
*/
```

---

## SECTION 9 — GENAI GENERATION LAYER

### 9.1 Anthropic Client Setup

```typescript
// src/generation/client.ts

import Anthropic from "@anthropic-ai/sdk";

// REQUIRED ENV VAR: ANTHROPIC_API_KEY
// MODEL: always claude-sonnet-4-6 (claude-sonnet-4-6)
// DO NOT make this configurable — fixes the model for reproducibility

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function generateWithRetry(
  systemPrompt: string,
  userMessage: string,
  maxRetries: number = 2
): Promise<string> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const message = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        temperature: 0.1,          // CRITICAL: low temp for deterministic code
        system: systemPrompt,
        messages: [
          { role: "user", content: userMessage }
        ],
      });
      
      const content = message.content[0];
      if (content.type !== "text") throw new Error("Non-text response from API");
      return content.text;
      
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        await sleep(1000 * (attempt + 1)); // exponential backoff
      }
    }
  }
  throw lastError;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
```

### 9.2 Playwright System Prompt

```typescript
// src/generation/prompts/playwright.system.ts

export const PLAYWRIGHT_SYSTEM_PROMPT = `
You are a Senior QA Engineer expert in Playwright. Your ONLY job is to generate smoke test files.

## ABSOLUTE RULES — NEVER VIOLATE:
1. Output ONLY valid TypeScript. Zero markdown. Zero explanation. Zero comments except inline // notes.
2. Every test file starts with: import { test, expect } from '@playwright/test';
3. Use process.env.BASE_URL for all base URLs — never hardcode.
4. Use @smoke tag on every test: test('description @smoke', async ({ page }) => {
5. Every single test MUST have at least one expect() assertion. No assertion = invalid test.
6. Smoke tests test the HAPPY PATH ONLY. Never test error cases, edge cases, or negative scenarios.
7. For auth-required endpoints: ALWAYS get a token first via the login flow.
8. Use these locator strategies IN THIS PRIORITY ORDER (never skip to a lower priority if higher works):
   a. page.getByTestId('value')
   b. page.getByRole('role', { name: 'text' })
   c. page.getByLabel('label text')
   d. page.getByPlaceholder('placeholder')
   e. page.locator('css-selector')   ← LAST RESORT only, add // ⚠️ BRITTLE comment
9. Use realistic but obviously fake test data:
   Email: process.env.SMOKE_TEST_EMAIL || 'smoketest@example.com'
   Password: process.env.SMOKE_TEST_PASSWORD || 'SmokeTest123!'
   UUID: '11111111-2222-3333-4444-555555555555'
   Numbers: 1 or small integers
   Strings: 'smoke-test-value'
10. Group tests by domain using test.describe('Domain Name', () => { ... })
11. Shared auth setup goes in beforeAll with storageState — not repeated in every test.
12. Use APIRequestContext for API calls inside E2E tests (page.request.get/post/etc).
13. Always await every Playwright action. No floating promises.
14. Add timeout to long operations: { timeout: 10000 }
15. For page navigation: await page.goto(url); await page.waitForLoadState('networkidle');

## FILE STRUCTURE TO GENERATE:
For UI pages: one .page.spec.ts file per page group
For API endpoints: one .api.spec.ts file per domain

## EXAMPLE OUTPUT FORMAT (follow exactly):
\`\`\`typescript
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Auth', () => {
  test('POST /api/v1/auth/login returns 200 with valid credentials @smoke', async ({ request }) => {
    const response = await request.post(\`\${BASE_URL}/api/v1/auth/login\`, {
      data: {
        email: process.env.SMOKE_TEST_EMAIL || 'smoketest@example.com',
        password: process.env.SMOKE_TEST_PASSWORD || 'SmokeTest123!',
      },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('accessToken');
  });
});
\`\`\`

Now generate the test file for the blueprint provided. Output ONLY the TypeScript code.
`;
```

### 9.3 Postman System Prompt

```typescript
// src/generation/prompts/postman.system.ts

export const POSTMAN_SYSTEM_PROMPT = `
You are a Senior API Engineer expert in Postman. Your ONLY job is to generate Postman Collection v2.1 JSON.

## ABSOLUTE RULES — NEVER VIOLATE:
1. Output ONLY valid JSON. Zero markdown. Zero explanation.
2. Collection schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
3. Use {{BASE_URL}} for all base URLs.
4. Use {{AUTH_TOKEN}} for all Bearer auth headers.
5. Group requests in folders by domain.
6. EVERY request must have TWO test scripts:
   a. pm.test("Status is 2xx", () => { pm.expect(pm.response.code).to.be.oneOf([200,201,202,204]); });
   b. pm.test("Response time under 3000ms", () => { pm.expect(pm.response.responseTime).to.be.below(3000); });
7. The login request MUST have a post-response script:
   pm.test("Login successful", () => { pm.expect(pm.response.code).to.equal(200); });
   const token = pm.response.json().accessToken; // adjust field name per schema
   pm.collectionVariables.set("AUTH_TOKEN", token);
8. All request bodies must use realistic fake data (not placeholder {{variables}} for body fields).
9. Include all required query parameters with example values.
10. Path parameters use Postman :variable syntax: /users/:userId with variable value set.
11. Collection must have these variables defined: BASE_URL, AUTH_TOKEN, SMOKE_TEST_EMAIL, SMOKE_TEST_PASSWORD.

## COLLECTION STRUCTURE:
{
  "info": { "name": "...", "schema": "..." },
  "variable": [ BASE_URL, AUTH_TOKEN, SMOKE_TEST_EMAIL, SMOKE_TEST_PASSWORD ],
  "item": [
    { "name": "Auth", "item": [ ...auth requests ] },
    { "name": "Users", "item": [ ...user requests ] },
    ...
  ]
}

Output ONLY the JSON. Start with { and end with }.
`;
```

### 9.4 User Message Builder

```typescript
// src/generation/playwright.generator.ts

export function buildPlaywrightUserMessage(chunk: BlueprintChunk): string {
  return `
Generate Playwright smoke tests for the following application chunk.

## AUTH CONFIGURATION:
${JSON.stringify(chunk.auth, null, 2)}

## API ENDPOINTS TO TEST:
${JSON.stringify(chunk.endpoints, null, 2)}

## UI PAGES TO TEST:
${JSON.stringify(chunk.pages, null, 2)}

## TEST DATA HINTS:
${JSON.stringify(chunk.testDataHints, null, 2)}

## DOMAIN: ${chunk.domain}
## OUTPUT FILE NAME: ${chunk.domain}.${chunk.hasPages ? 'page' : 'api'}.spec.ts

Generate the complete TypeScript test file now.
`;
}
```

### 9.5 Self-Healing Retry Logic

```typescript
// src/generation/prompts/retry.ts

export function buildRetryMessage(
  originalOutput: string,
  validationErrors: string[]
): string {
  return `
The previous generation had errors. Fix ONLY the issues listed below and regenerate the COMPLETE file.

## ERRORS TO FIX:
${validationErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

## PREVIOUS (BROKEN) OUTPUT:
${originalOutput}

Regenerate the complete corrected file now. Output ONLY valid TypeScript/JSON.
`;
}

// VALIDATION ERRORS TO CATCH AND RETRY:
// TypeScript:
// - Missing import statements
// - Calling methods that don't exist on page/request objects
// - Missing await on async calls
// - Syntax errors (catch from tsc output)
// - Tests with no assertions (grep for test blocks without expect)

// Postman:
// - Invalid JSON (JSON.parse throws)
// - Missing required fields (info.name, info.schema)
// - Missing test scripts on requests
// - AUTH_TOKEN variable not set in login pre-request
```

---

## SECTION 10 — OUTPUT WRITERS

### 10.1 Playwright Writer

```typescript
// src/output/playwright-writer.ts

/*
OUTPUT DIRECTORY STRUCTURE:
smokeforge-output/
├── playwright/
│   ├── smoke/
│   │   ├── auth.api.spec.ts          ← API tests for auth domain
│   │   ├── users.api.spec.ts         ← API tests for users domain
│   │   ├── products.api.spec.ts
│   │   ├── orders.api.spec.ts
│   │   ├── login.page.spec.ts        ← E2E tests for login page
│   │   ├── dashboard.page.spec.ts
│   │   └── users.page.spec.ts
│   ├── fixtures/
│   │   ├── auth.fixture.ts           ← Shared auth setup
│   │   └── test-data.ts              ← Shared test data constants
│   └── playwright.config.ts          ← Pre-configured for smoke tag

PLAYWRIGHT CONFIG TO GENERATE:
  import { defineConfig, devices } from '@playwright/test';
  export default defineConfig({
    testDir: './smoke',
    grep: /@smoke/,
    timeout: 30000,
    retries: 1,
    use: {
      baseURL: process.env.BASE_URL || 'http://localhost:3000',
      extraHTTPHeaders: { 'x-smokeforge-test': 'true' },
    },
    projects: [
      { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
      { name: 'api', testMatch: /\.api\.spec\.ts$/, use: {} },
    ],
  });

AUTH FIXTURE TO GENERATE:
  // fixtures/auth.fixture.ts
  import { test as base, request } from '@playwright/test';
  
  type AuthFixtures = { authToken: string };
  
  export const test = base.extend<AuthFixtures>({
    authToken: async ({}, use) => {
      const ctx = await request.newContext();
      const response = await ctx.post(`${process.env.BASE_URL}/api/v1/auth/login`, {
        data: {
          email: process.env.SMOKE_TEST_EMAIL || 'smoketest@example.com',
          password: process.env.SMOKE_TEST_PASSWORD || 'SmokeTest123!',
        },
      });
      const body = await response.json();
      await use(body.accessToken);
      await ctx.dispose();
    },
  });

.ENV.EXAMPLE TO GENERATE:
  BASE_URL=http://localhost:3000
  SMOKE_TEST_EMAIL=smoketest@example.com
  SMOKE_TEST_PASSWORD=SmokeTest123!
*/
```

### 10.2 Postman Writer

```typescript
// src/output/postman-writer.ts

/*
OUTPUT: smokeforge-output/postman/smoke-tests.postman_collection.json

POST-PROCESSING STEPS:
1. Merge all domain chunks into one collection
2. Ensure login request is FIRST in the Auth folder
3. Ensure AUTH_TOKEN variable is set in collection variables (empty default)
4. Validate JSON is parseable
5. Validate against Postman Collection v2.1 JSON Schema (use ajv)

POSTMAN ENVIRONMENT FILE TO GENERATE:
  smokeforge-output/postman/smoke-env.postman_environment.json
  {
    "name": "Smoke Test Environment",
    "values": [
      { "key": "BASE_URL", "value": "http://localhost:3000", "enabled": true },
      { "key": "AUTH_TOKEN", "value": "", "enabled": true },
      { "key": "SMOKE_TEST_EMAIL", "value": "smoketest@example.com", "enabled": true },
      { "key": "SMOKE_TEST_PASSWORD", "value": "SmokeTest123!", "enabled": true }
    ]
  }
*/
```

---

## SECTION 11 — CLI IMPLEMENTATION

```typescript
// src/cli/index.ts

#!/usr/bin/env node
import { Command } from 'commander';
import { generateCommand } from './commands/generate';
import { analyzeCommand } from './commands/analyze';

const program = new Command();

program
  .name('smokeforge')
  .description('GenAI-powered smoke test generator for JS/TS applications')
  .version('1.0.0');

// GENERATE COMMAND
program
  .command('generate <repo-url>')
  .description('Generate smoke tests from a GitHub repository')
  .option('-o, --output <dir>', 'Output directory', './smokeforge-output')
  .option('-f, --format <formats>', 'Output formats (playwright,postman)', 'playwright,postman')
  .option('-b, --base-url <url>', 'Target application base URL', 'http://localhost:3000')
  .option('--framework <name>', 'Override framework detection')
  .option('--only-api', 'Generate API tests only (skip UI)')
  .option('--only-ui', 'Generate UI tests only (skip API)')
  .option('--domain <name>', 'Generate tests for specific domain only')
  .option('-v, --verbose', 'Verbose output')
  .option('--no-install', 'Skip npm install in cloned repo (faster but lower schema accuracy)')
  .action(generateCommand);

// ANALYZE COMMAND (extraction only — no generation)
program
  .command('analyze <repo-url>')
  .description('Analyze a repository and output the test blueprint JSON (no test generation)')
  .option('-o, --output <file>', 'Output file for blueprint JSON', './blueprint.json')
  .action(analyzeCommand);

program.parse();

// GENERATE COMMAND FLOW (src/cli/commands/generate.ts):
// 1. Validate ANTHROPIC_API_KEY env var exists → error if missing
// 2. Clone repo with progress spinner
// 3. Detect frameworks → log detected frameworks
// 4. Run all extractors concurrently → log counts
// 5. Build blueprint → log endpoint/page counts
// 6. Chunk blueprint → log chunk count
// 7. For each chunk:
//    a. Generate Playwright (if not --only-ui)
//    b. Generate Postman (if not --only-api)
//    c. Show progress bar
// 8. Validate outputs → fix/retry if needed
// 9. Write files
// 10. Print summary report
// 11. Clean up cloned repo (delete temp dir)

// SUMMARY REPORT FORMAT:
// ✅ SmokeForge Complete
// ─────────────────────────────────────
// 📁 Repository: github.com/acme/myapp
// 🔍 Frameworks: Next.js, Express, React
// 🔗 Endpoints extracted: 34
// 🖥️  Pages extracted: 12
// ─────────────────────────────────────
// 📄 Playwright tests: 46 tests in 8 files
// 📬 Postman requests: 34 in 5 folders
// ─────────────────────────────────────
// ⚠️  Low confidence items: 3 (see report)
// 📊 Full report: ./smokeforge-output/smokeforge-report.json
// ─────────────────────────────────────
// 🚀 Run: cd smokeforge-output && npx playwright test --grep @smoke
```

---

## SECTION 12 — VALIDATION & CONFIDENCE SCORING

### 12.1 Output Validation

```typescript
// src/output/validator.ts

/*
PLAYWRIGHT VALIDATION:
1. TypeScript compilation:
   Run: tsc --noEmit --target ES2022 --module commonjs <generated-file>
   If errors → extract error messages → send to retry prompt

2. Test discovery:
   Run: npx playwright test --list <generated-file>
   If exits non-zero → compilation issue → retry

3. Static checks (do these before TypeScript compile):
   a. Every test() block must contain at least one expect() — regex check
   b. No test() blocks that are empty
   c. All imports must be from '@playwright/test' or relative paths
   d. No hardcoded URLs (grep for https?:// not in template literals with BASE_URL)
   e. No hardcoded real credentials (grep for @gmail.com, @yahoo.com etc.)

POSTMAN VALIDATION:
1. JSON parse: JSON.parse(output) — throw on invalid JSON
2. Schema: validate against official Postman v2.1 schema using ajv
3. Required checks:
   a. info.name exists
   b. info.schema === "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
   c. At least one item
   d. Login request exists if auth detected
   e. Collection variables include BASE_URL and AUTH_TOKEN
*/
```

### 12.2 Confidence Scoring System

```typescript
// src/output/reporter.ts

/*
ENDPOINT CONFIDENCE CALCULATION:
  Start: 1.0
  Deductions:
  - UNRESOLVED_PREFIX flag:    -0.20
  - DYNAMIC_PATH flag:         -0.15
  - CONDITIONAL_ROUTE flag:    -0.10
  - Schema source "inferred":  -0.15
  - Schema source "typescript":-0.10
  - No schema found:           -0.25
  - Auth ambiguous:            -0.10

LOCATOR CONFIDENCE:
  testId strategy:             1.00
  aria/role strategy:          0.85
  label strategy:              0.80
  placeholder strategy:        0.70
  css strategy:                0.50
  CONDITIONAL_ELEMENT flag:    -0.15
  DYNAMIC_TESTID flag:         -0.20

CONFIDENCE THRESHOLDS:
  >= 0.80: Generate test normally
  0.60-0.79: Generate test with // ⚠️ MEDIUM CONFIDENCE comment
  0.40-0.59: Generate test with // ⚠️ LOW CONFIDENCE — manual review recommended
  < 0.40: Generate TODO comment block instead of test:
    // TODO: Could not extract sufficient info for this endpoint
    // Endpoint: GET /api/some/path
    // Manual test needed
    test.todo('GET /api/some/path @smoke');

REPORT OUTPUT (smokeforge-report.json):
  {
    "summary": {
      "totalEndpoints": 34,
      "totalPages": 12,
      "highConfidence": 28,
      "mediumConfidence": 4,
      "lowConfidence": 2,
      "todos": 0
    },
    "items": [
      {
        "id": "ep_001",
        "type": "endpoint",
        "method": "POST",
        "path": "/api/v1/auth/login",
        "confidence": 0.95,
        "schemaSource": "zod",
        "authDetected": false,
        "generatedTestFile": "auth.api.spec.ts",
        "flags": [],
        "warnings": []
      }
    ],
    "locatorRecommendations": [
      {
        "file": "src/components/UserForm.tsx",
        "element": "<button type='submit'>Save</button> at line 45",
        "issue": "No data-testid attribute — using brittle CSS selector",
        "recommendation": "Add data-testid='user-form-submit' to this element"
      }
    ]
  }
*/
```

---

## SECTION 13 — EDGE CASES & SPECIAL HANDLING

### 13.1 Route Deduplication

```typescript
/*
DEDUP RULES:
  Same method + same normalized path = duplicate
  
  Normalization:
  /api/v1/users/:id === /api/v1/users/:userId  (param names differ, ignore names)
  /api/v1/users/:id === /api/v1/users/{id}     (different param syntax, same route)
  
  When deduplicating:
  - Keep the extraction with higher confidence
  - Merge any unique schema info from both
  - Keep both sourceFile references for debugging
*/
```

### 13.2 Middleware-Defined Routes

```typescript
/*
Some routes are registered entirely through middleware chains.
Example:
  import swaggerUi from 'swagger-ui-express'
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec))
  → Register: GET /api-docs (flag: DOCUMENTATION_ROUTE, skip in smoke tests)

  import { createExpressMiddleware } from '@trpc/server/adapters/express'
  app.use('/trpc', createExpressMiddleware({ router }))
  → Hand off to tRPC extractor

  import { graphqlHTTP } from 'express-graphql'
  app.use('/graphql', graphqlHTTP({ schema, graphiql: true }))
  → Register: POST /graphql (flag: GRAPHQL_ENDPOINT — Phase 2)

SKIP THESE ROUTES (never generate tests for them):
  /api-docs, /swagger, /swagger-ui → documentation
  /health, /healthz, /ping, /ready, /live → health checks (generate one simple test)
  /metrics, /actuator → monitoring endpoints
  /favicon.ico, /robots.txt → static assets
  /__nextjs*, /_next/* → Next.js internals
*/
```

### 13.3 TypeScript Path Aliases

```typescript
/*
Many repos use TypeScript path aliases:
  "@/components/Button" → "./src/components/Button"
  "~/utils/auth" → "./src/utils/auth"
  "@acme/shared/schemas" → "../../packages/shared/schemas"

RESOLUTION:
1. Read tsconfig.json (all tsconfig.*.json files)
2. Parse compilerOptions.paths
3. Build an alias resolver map:
   "@/*" → ["src/*"]
   "~/*" → ["src/*"]
4. When following imports/requires, resolve aliases before file path resolution
5. For monorepos: also check root tsconfig.json for workspace paths
*/
```

### 13.4 Dynamic Import Patterns

```typescript
/*
Dynamic imports can register routes lazily:
  
Express:
  const module = await import('./routes/users')
  app.use('/users', module.default)
  → Treat same as static import (resolve file, extract routes)

Next.js dynamic:
  const Component = dynamic(() => import('./HeavyComponent'))
  → This is a UI component, not a route — skip for route extraction

React.lazy:
  const Users = React.lazy(() => import('./pages/Users'))
  <Route path="/users" element={<Suspense><Users /></Suspense>} />
  → Route path is static, extract it. Component is lazy but path is known.
*/
```

---

## SECTION 14 — END-TO-END DATA FLOW SUMMARY

```
INPUT: github repo URL (e.g. "https://github.com/acme/myapp")

STEP 1 — CLONE (cloner.ts)
  simple-git.clone(url, tempDir, ['--depth', '1'])
  Build file manifest (all .ts/.tsx/.js/.jsx/.vue/.svelte files)
  Estimated time: 5-30 seconds depending on repo size

STEP 2 — DETECT (detector.ts)
  Read package.json(s)
  Classify backend/frontend/schema/auth frameworks
  Detect monorepo structure
  Output: DetectionResult

STEP 3 — PARSE (parser.ts)
  Parse ALL analyzable files with typescript-estree
  Cache parsed ASTs (file → ParsedFile)
  Skip unparseable files with warning
  Estimated time: 10-60 seconds for large repos

STEP 4 — EXTRACT (parallel)
  Run selected backend extractor(s) → ExtractedEndpoint[]
  Run selected UI extractor(s) → ExtractedPage[]
  Run schema extractor(s) → enrich endpoints with schemas
  Run auth detector → AuthConfig
  Estimated time: 5-20 seconds

STEP 5 — BUILD BLUEPRINT (builder.ts)
  Assemble TestBlueprint
  Link endpoints ↔ pages
  Generate test data hints
  Score confidence per item
  Output: TestBlueprint JSON

STEP 6 — CHUNK (chunker.ts)
  Split by domain
  Output: BlueprintChunk[] (typically 3-8 chunks)

STEP 7 — GENERATE (per chunk, sequential to respect API rate limits)
  For each chunk:
    Call Anthropic API → Playwright spec string
    Call Anthropic API → Postman collection string
    Validate both outputs
    Retry up to 2x if validation fails
  Estimated time: 30-120 seconds (API calls)

STEP 8 — WRITE (writers)
  Write Playwright spec files
  Write auth fixture
  Write playwright.config.ts
  Write .env.example
  Merge and write Postman collection JSON
  Write Postman environment JSON

STEP 9 — REPORT (reporter.ts)
  Write smokeforge-report.json
  Print summary to stdout
  Clean up temp clone directory

TOTAL ESTIMATED TIME: 2-5 minutes for a typical mid-size repo
```

---

## APPENDIX A — FRAMEWORK SUPPORT MATRIX

| Framework | API Extraction | UI Extraction | Schema | Confidence |
|---|---|---|---|---|
| Express.js | ✅ Full | — | Zod/Joi/TS | High |
| Fastify | ✅ Full | — | TypeBox/Zod | High |
| NestJS | ✅ Full | — | class-validator/Zod | Very High |
| Next.js Pages Router | ✅ Full | ✅ Full | Zod/TS | High |
| Next.js App Router | ✅ Full | ✅ Full | Zod/TS | High |
| Remix | ✅ Full | ✅ Partial | Zod/TS | Medium-High |
| Koa | ✅ Full | — | Joi/Zod | High |
| Hapi | ✅ Full | — | Joi | Very High |
| Hono | ✅ Full | — | Zod/TypeBox | High |
| tRPC | ✅ Full | — | Zod | High |
| SvelteKit | ✅ Full | ✅ Partial | Zod/TS | Medium-High |
| Elysia | ✅ Full | — | TypeBox | High |
| React SPA | — | ✅ Full | — | Medium |
| Vue SPA | — | ✅ Full | — | Medium |
| Angular | — | ✅ Full | — | Medium |
| Nuxt | ✅ Partial | ✅ Partial | Zod/TS | Medium |
| Astro | ✅ Partial | ✅ Partial | Zod/TS | Medium |
| GraphQL/Apollo | 🔜 Phase 2 | — | GraphQL Schema | — |

---

## APPENDIX B — ENV VARS REFERENCE

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Generated .env.example (for the output test suite)
BASE_URL=http://localhost:3000
SMOKE_TEST_EMAIL=smoketest@example.com
SMOKE_TEST_PASSWORD=SmokeTest123!

# Optional smokeforge config
SMOKEFORGE_MAX_RETRIES=2
SMOKEFORGE_CHUNK_SIZE=15
SMOKEFORGE_TEMP_DIR=/tmp/smokeforge
```

---

## APPENDIX C — CRITICAL IMPLEMENTATION ORDER

Build in this exact sequence to enable incremental testing:

1. `src/utils/ast-utils.ts` — needed by all extractors
2. `src/analysis/parser.ts` — needed by all extractors
3. `src/ingestion/detector.ts` — framework detection
4. `src/analysis/backend/express.extractor.ts` — first extractor (most common)
5. `src/blueprint/types.ts` — type contracts
6. `src/blueprint/builder.ts` — blueprint assembly
7. `src/generation/client.ts` — API client
8. `src/generation/prompts/*.ts` — prompts
9. `src/generation/playwright.generator.ts`
10. `src/output/playwright-writer.ts`
11. `src/output/validator.ts`
12. `src/cli/index.ts` — wire it all together
13. Remaining extractors in order: nestjs → nextjs-app → nextjs-pages → fastify → trpc
14. Schema extractors: zod → class-validator → joi
15. UI extractors: react → router → vue → angular
16. Auth detector
17. Postman generator + writer
18. Confidence scoring + reporter

**Test after each step using a simple Express+Zod repo before adding the next extractor.**
