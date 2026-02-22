# SmokeForge — Complete Testing Strategy
## Ensuring Accuracy Across Every Supported Framework

---

> **Philosophy:** SmokeForge has three failure layers. Each needs a different testing approach.
> - **Layer 1 — Extraction:** Did we find the right routes, schemas, and locators?
> - **Layer 2 — Generation:** Did the AI produce syntactically and semantically correct tests?
> - **Layer 3 — Execution:** Do the generated tests actually run and pass against a real app?
>
> Most testing strategies stop at Layer 1. This strategy covers all three.

---

## TABLE OF CONTENTS

1. Test Architecture Overview
2. Layer 1 — Unit Tests (Extractor Accuracy)
3. Layer 2 — Integration Tests (Pipeline Accuracy)
4. Layer 3 — Execution Tests (End-to-End Validation)
5. Fixture Repo Strategy (Per Framework)
6. Snapshot Testing Strategy
7. AI Output Quality Evaluation
8. CI/CD Pipeline
9. Coverage Targets Per Framework
10. Test Data & Fixture Management
11. Regression Testing Strategy
12. Implementation Order

---

## SECTION 1 — TEST ARCHITECTURE OVERVIEW

### 1.1 Directory Structure

```
smokeforge/
├── src/                          ← Source code
├── test/
│   ├── unit/                     ← Layer 1: Pure extractor unit tests
│   │   ├── analysis/
│   │   │   ├── backend/
│   │   │   │   ├── express.extractor.test.ts
│   │   │   │   ├── nestjs.extractor.test.ts
│   │   │   │   ├── nextjs-pages.extractor.test.ts
│   │   │   │   ├── nextjs-app.extractor.test.ts
│   │   │   │   ├── fastify.extractor.test.ts
│   │   │   │   ├── trpc.extractor.test.ts
│   │   │   │   ├── remix.extractor.test.ts
│   │   │   │   ├── koa.extractor.test.ts
│   │   │   │   ├── hapi.extractor.test.ts
│   │   │   │   ├── hono.extractor.test.ts
│   │   │   │   ├── sveltekit.extractor.test.ts
│   │   │   │   └── elysia.extractor.test.ts
│   │   │   ├── schemas/
│   │   │   │   ├── zod.extractor.test.ts
│   │   │   │   ├── joi.extractor.test.ts
│   │   │   │   ├── class-validator.extractor.test.ts
│   │   │   │   └── typescript-types.extractor.test.ts
│   │   │   ├── auth/
│   │   │   │   └── auth-detector.test.ts
│   │   │   └── ui/
│   │   │       ├── react.extractor.test.ts
│   │   │       ├── vue.extractor.test.ts
│   │   │       ├── angular.extractor.test.ts
│   │   │       └── router-extractor.test.ts
│   │   ├── blueprint/
│   │   │   ├── builder.test.ts
│   │   │   └── chunker.test.ts
│   │   ├── ingestion/
│   │   │   └── detector.test.ts
│   │   └── output/
│   │       ├── validator.test.ts
│   │       └── reporter.test.ts
│   ├── integration/              ← Layer 2: Full pipeline tests (no AI calls)
│   │   ├── express-zod.test.ts
│   │   ├── nestjs.test.ts
│   │   ├── nextjs-app-router.test.ts
│   │   ├── nextjs-pages-router.test.ts
│   │   ├── fastify.test.ts
│   │   ├── trpc.test.ts
│   │   ├── remix.test.ts
│   │   ├── fullstack-monorepo.test.ts
│   │   └── mixed-js-ts.test.ts
│   ├── e2e/                      ← Layer 3: Full execution tests (real AI calls)
│   │   ├── express-app.e2e.test.ts
│   │   ├── nextjs-app.e2e.test.ts
│   │   └── nestjs-app.e2e.test.ts
│   ├── fixtures/                 ← Static code fixtures (not real apps)
│   │   ├── express/
│   │   ├── fastify/
│   │   ├── nestjs/
│   │   ├── nextjs-pages/
│   │   ├── nextjs-app/
│   │   ├── remix/
│   │   ├── trpc/
│   │   ├── koa/
│   │   ├── hapi/
│   │   ├── hono/
│   │   ├── sveltekit/
│   │   ├── elysia/
│   │   ├── react-spa/
│   │   ├── vue-spa/
│   │   └── angular/
│   ├── repos/                    ← Real mini apps for Layer 3 (git submodules)
│   │   ├── express-todo/
│   │   ├── nextjs-ecommerce/
│   │   └── nestjs-api/
│   └── snapshots/                ← Snapshot files for generated output
│       ├── playwright/
│       └── postman/
├── vitest.config.ts
└── vitest.e2e.config.ts          ← Separate config for e2e (slower, needs API key)
```

### 1.2 Test Runner Configuration

```typescript
// vitest.config.ts — Unit + Integration tests (fast, no AI calls)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    globals: true,
    testTimeout: 10000,       // 10s max per unit test
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/generation/prompts/**'],
      thresholds: {
        lines: 80,
        functions: 85,
        branches: 75,
        statements: 80,
      },
    },
  },
});

// vitest.e2e.config.ts — E2E tests (slow, requires ANTHROPIC_API_KEY)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    globals: true,
    testTimeout: 300000,      // 5 min per e2e test (AI calls are slow)
    retry: 1,
    reporters: ['verbose'],
  },
});
```

---

## SECTION 2 — LAYER 1: UNIT TESTS (EXTRACTOR ACCURACY)

### 2.1 The Core Testing Pattern

Every extractor unit test follows the same pattern:

```typescript
// test/unit/analysis/backend/express.extractor.test.ts

import { describe, it, expect } from 'vitest';
import { parseFile } from '../../../src/analysis/parser';
import { ExpressExtractor } from '../../../src/analysis/backend/express.extractor';
import { createFixtureFile, createFixtureFiles } from '../../helpers/fixture-helpers';

// DO NOT mock the AST parser — test real parsing on real code strings
// DO mock: file system reads for cross-file resolution
// DO NOT mock: the actual extraction logic

describe('ExpressExtractor', () => {
  const extractor = new ExpressExtractor();

  describe('Basic route extraction', () => {
    it('extracts GET route from app.get()', async () => {
      const files = createFixtureFiles({
        'app.ts': `
          import express from 'express';
          const app = express();
          app.get('/users', (req, res) => res.json([]));
        `
      });

      const result = await extractor.extract(files, mockDetection('express'));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        method: 'GET',
        path: '/users',
        authRequired: false,
        confidence: expect.any(Number),
      });
    });
  });
});
```

### 2.2 Fixture Helper Utility

```typescript
// test/helpers/fixture-helpers.ts
// CRITICAL: This helper is used by EVERY unit test. Build it first.

import { parseFile, ParsedFile } from '../../src/analysis/parser';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

/**
 * Creates ParsedFile objects from in-memory code strings.
 * Writes them to a temp directory, parses them, returns ParsedFile[].
 * No mocking — real AST parsing on real files.
 */
export function createFixtureFiles(
  files: Record<string, string>  // { 'relative/path.ts': 'code string' }
): ParsedFile[] {
  const tmpDir = join(tmpdir(), `smokeforge-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const parsedFiles: ParsedFile[] = [];

  for (const [relativePath, code] of Object.entries(files)) {
    const fullPath = join(tmpDir, relativePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, code, 'utf-8');

    const parsed = parseFile(fullPath);
    if (parsed) parsedFiles.push(parsed);
  }

  // Cleanup after test (register with afterEach in test file)
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  return parsedFiles;
}

/**
 * Creates a mock PackageDetection for a given framework.
 */
export function mockDetection(framework: string) {
  return {
    rootPath: '/tmp/test-repo',
    name: 'test-app',
    backendFrameworks: [framework],
    frontendFrameworks: [],
    schemaLibraries: ['zod'],
    authLibraries: ['jsonwebtoken'],
    routerLibraries: [],
    isFullStack: false,
    hasTypeScript: true,
    packageJson: {},
  };
}
```

### 2.3 Express Extractor — Complete Test Cases

Every single pattern from the implementation spec must have a test. This is the reference for all other extractors.

```typescript
// test/unit/analysis/backend/express.extractor.test.ts

describe('ExpressExtractor — Route Patterns', () => {

  // ── Pattern 1: Basic HTTP methods ─────────────────────────────────────────
  it('extracts app.get()', ...);
  it('extracts app.post()', ...);
  it('extracts app.put()', ...);
  it('extracts app.patch()', ...);
  it('extracts app.delete()', ...);
  it('extracts app.all() as method ALL', ...);

  // ── Pattern 2: Router instances ───────────────────────────────────────────
  it('extracts routes from express.Router()', ...);
  it('extracts routes from Router() (named import)', ...);

  // ── Pattern 3: Router.route() chaining ───────────────────────────────────
  it('extracts GET and POST from router.route().get().post()', ...);
  it('handles all methods on same route path', ...);

  // ── Pattern 4: Router prefix mounting ────────────────────────────────────
  it('prepends prefix from app.use("/api/v1", router)', ...);
  it('handles nested prefix: app.use("/api", router1), router1.use("/v1", router2)', ...);
  it('resolves prefix for routes in the mounted router', ...);

  // ── Pattern 5: Cross-file resolution ─────────────────────────────────────
  it('follows require() to extract routes from imported file', ...);
  it('follows import { router } from "./routes" to extract routes', ...);
  it('handles .ts extension resolution', ...);
  it('handles /index.ts resolution', ...);
  it('stops at max depth 5 for circular imports', ...);

  // ── Pattern 6: Conditional routes ────────────────────────────────────────
  it('flags route inside if(process.env.X) as CONDITIONAL_ROUTE', ...);
  it('still extracts the route path even when conditional', ...);

  // ── Pattern 7: Dynamic paths ──────────────────────────────────────────────
  it('flags template literal path as DYNAMIC_PATH', ...);
  it('extracts static segments from mixed template literal', ...);

  // ── Pattern 8: Auth middleware detection ─────────────────────────────────
  it('sets authRequired: true when authenticate middleware in chain', ...);
  it('sets authRequired: true when requireAuth in chain', ...);
  it('sets authRequired: false when no auth middleware', ...);
  it('detects app.use(authenticate) as global auth for all routes below', ...);

  // ── Pattern 9: Role detection ─────────────────────────────────────────────
  it('extracts roles from requireRole(["admin", "manager"])', ...);
  it('extracts roles from authorize("admin")', ...);

  // ── Pattern 10: File upload detection ────────────────────────────────────
  it('flags route with multer middleware as FILE_UPLOAD', ...);
  it('flags route with upload.single() as FILE_UPLOAD', ...);
});

describe('ExpressExtractor — Path Parameter Extraction', () => {
  it('extracts :userId as pathParam from /users/:userId', ...);
  it('extracts type uuid when Zod schema has z.string().uuid()', ...);
  it('extracts type number when Zod schema has z.coerce.number()', ...);
  it('extracts multiple params from /users/:userId/orders/:orderId', ...);
  it('generates example values per type', ...);
});

describe('ExpressExtractor — Schema Integration', () => {
  it('links validateBody(CreateUserSchema) to Zod schema fields', ...);
  it('extracts body fields from inline z.object({})', ...);
  it('extracts query params from validateQuery(QuerySchema)', ...);
  it('returns null requestBody when no schema found', ...);
  it('sets confidence lower when schema is inferred not explicit', ...);
});

describe('ExpressExtractor — Confidence Scoring', () => {
  it('scores 1.0 for simple route with Zod schema and detected auth', ...);
  it('reduces score by 0.20 for UNRESOLVED_PREFIX', ...);
  it('reduces score by 0.15 for DYNAMIC_PATH', ...);
  it('reduces score by 0.25 for no schema found', ...);
});

describe('ExpressExtractor — Edge Cases', () => {
  it('handles file with syntax errors gracefully (no throw)', ...);
  it('handles empty router with no routes', ...);
  it('deduplicates routes with same method and path', ...);
  it('handles route with no handler (only middleware)', ...);
  it('extracts routes when app variable is renamed (const server = express())', ...);
});
```

### 2.4 NestJS Extractor — Complete Test Cases

```typescript
describe('NestJSExtractor — Controller Patterns', () => {

  describe('@Controller decorator', () => {
    it('extracts base path from @Controller("users")', ...);
    it('extracts base path from @Controller({ path: "users" })', ...);
    it('uses "/" when @Controller() has no args', ...);
    it('handles @Controller({ path: "users", version: "1" })', ...);
  });

  describe('HTTP method decorators', () => {
    it('extracts @Get() as GET /', ...);
    it('extracts @Get(":id") as GET /:id', ...);
    it('extracts @Post() as POST /', ...);
    it('extracts @Put(":id") as PUT /:id', ...);
    it('extracts @Patch(":id") as PATCH /:id', ...);
    it('extracts @Delete(":id") as DELETE /:id', ...);
    it('extracts @All() as ALL /', ...);
    it('combines controller base + method path correctly', ...);
  });

  describe('Parameter decorators', () => {
    it('extracts @Param("id") id: string as pathParam', ...);
    it('extracts @Query("page") page: number as queryParam', ...);
    it('extracts @Body() dto: CreateUserDto as requestBody', ...);
    it('resolves CreateUserDto fields from class-validator decorators', ...);
    it('handles nested @ValidateNested() DTOs recursively', ...);
    it('extracts @ApiProperty example values', ...);
  });

  describe('Guards and auth', () => {
    it('sets authRequired: true from class-level @UseGuards(AuthGuard)', ...);
    it('sets authRequired: true from method-level @UseGuards(JwtAuthGuard)', ...);
    it('sets authRequired: false when @Public() overrides class guard', ...);
    it('extracts roles from @Roles("admin", "manager")', ...);
    it('method-level guards override class-level guards', ...);
  });

  describe('Module graph', () => {
    it('finds controllers from @Module({ controllers: [...] })', ...);
    it('follows imported modules recursively', ...);
    it('handles lazy-loaded modules', ...);
  });

  describe('Global configuration', () => {
    it('applies global prefix from app.setGlobalPrefix("api")', ...);
    it('applies URI versioning from app.enableVersioning()', ...);
    it('combines: global prefix + version + controller base + method path', ...);
  });
});
```

### 2.5 Next.js App Router — Complete Test Cases

```typescript
describe('NextJSAppExtractor — File Convention', () => {

  describe('Route file detection', () => {
    it('detects /app/api/users/route.ts as /api/users', ...);
    it('detects /app/api/users/[userId]/route.ts as /api/users/:userId', ...);
    it('strips route groups: /app/(dashboard)/users/route.ts → /users', ...);
    it('strips nested route groups', ...);
    it('handles catch-all: /app/api/[...slug]/route.ts → /api/*', ...);
    it('handles optional catch-all: /app/api/[[...slug]]/route.ts', ...);
    it('ignores layout.tsx, loading.tsx, error.tsx, page.tsx', ...);
  });

  describe('Named export method detection', () => {
    it('registers GET when export async function GET() present', ...);
    it('registers POST when export async function POST() present', ...);
    it('registers multiple methods from same file', ...);
    it('is case-sensitive: lowercase get() is NOT detected', ...);
  });

  describe('Parameter extraction', () => {
    it('extracts path param from TypeScript type { params: { userId: string } }', ...);
    it('extracts query params from searchParams.get("page")', ...);
    it('extracts query params from Object.fromEntries(searchParams)', ...);
    it('extracts body from request.json() with Zod parse', ...);
  });

  describe('Auth detection', () => {
    it('detects auth from getServerSession() call', ...);
    it('detects auth from getToken() call', ...);
    it('applies middleware.ts matcher to correct routes', ...);
    it('handles matcher: ["/api/users/:path*"]', ...);
  });
});
```

### 2.6 Zod Schema Extractor — Complete Test Cases

```typescript
describe('ZodSchemaExtractor', () => {

  describe('Basic type extraction', () => {
    it('extracts z.string() as type string', ...);
    it('extracts z.number() as type number', ...);
    it('extracts z.boolean() as type boolean', ...);
    it('extracts z.date() as type string format date-time', ...);
    it('extracts z.array(z.string()) as array of string', ...);
    it('extracts z.enum(["a","b"]) as enum with values', ...);
    it('extracts z.literal("admin") as literal', ...);
    it('extracts nested z.object() recursively', ...);
    it('extracts z.union([...]) as union', ...);
    it('extracts z.record(z.string()) as object with additionalProperties', ...);
  });

  describe('Validator extraction', () => {
    it('extracts .email() validator', ...);
    it('extracts .url() validator', ...);
    it('extracts .uuid() validator and sets type hint to uuid', ...);
    it('extracts .min(8) validator', ...);
    it('extracts .max(128) validator', ...);
    it('extracts .regex() validator with pattern', ...);
    it('extracts .int() validator', ...);
    it('extracts .positive() validator', ...);
  });

  describe('Optionality and defaults', () => {
    it('marks .optional() fields as required: false', ...);
    it('extracts .default("user") value', ...);
    it('marks .default() fields as required: false', ...);
  });

  describe('Schema chaining', () => {
    it('resolves CreateSchema.partial() — all fields optional', ...);
    it('resolves CreateSchema.pick({ email: true }) — only email', ...);
    it('resolves CreateSchema.omit({ password: true }) — no password', ...);
    it('resolves CreateSchema.extend({ extra: z.string() }) — adds field', ...);
    it('handles chained: CreateSchema.partial().extend({})', ...);
  });

  describe('Schema registry', () => {
    it('builds registry from multiple schema declarations in one file', ...);
    it('builds registry across multiple files', ...);
    it('resolves schema by variable name', ...);
    it('returns null for unknown schema name', ...);
  });

  describe('Inline schema extraction', () => {
    it('extracts schema from validateBody(z.object({...}))', ...);
    it('extracts schema from zValidator("json", z.object({...}))', ...);
  });

  describe('Aliased z import', () => {
    it('handles: import { z as zod } from "zod"', ...);
    it('handles: import * as z from "zod"', ...);
  });
});
```

### 2.7 React UI Extractor — Complete Test Cases

```typescript
describe('ReactExtractor — Locator Strategies', () => {

  describe('Priority 1: data-testid attributes', () => {
    it('extracts data-testid="submit-btn" → getByTestId("submit-btn")', ...);
    it('extracts data-cy as testid', ...);
    it('extracts data-e2e as testid', ...);
    it('extracts data-pw as testid', ...);
    it('flags dynamic data-testid={`item-${id}`} as DYNAMIC_TESTID', ...);
  });

  describe('Priority 2: ARIA attributes', () => {
    it('extracts aria-label="Close" → getByRole with name', ...);
    it('extracts aria-label on input → getByLabel', ...);
  });

  describe('Priority 3: HTML semantic roles', () => {
    it('extracts <button>Login</button> → getByRole("button", { name: "Login" })', ...);
    it('extracts <a href="/x">Link</a> → getByRole("link", { name: "Link" })', ...);
    it('extracts <h1>Title</h1> → getByRole("heading", { name: "Title", level: 1 })', ...);
    it('extracts <input type="checkbox" /> → getByRole("checkbox")', ...);
    it('extracts <select> → getByRole("combobox")', ...);
    it('extracts <textarea> → getByRole("textbox")', ...);
    it('extracts <img alt="Photo" /> → getByAltText("Photo")', ...);
  });

  describe('Priority 4: Labels and placeholders', () => {
    it('extracts htmlFor+id pair → getByLabel', ...);
    it('extracts wrapping <label> → getByLabel', ...);
    it('extracts placeholder as last resort → getByPlaceholder', ...);
  });

  describe('Priority 5: CSS selectors (brittle)', () => {
    it('extracts className → locator(".class") with BRITTLE flag', ...);
    it('extracts id → locator("#id") with BRITTLE flag', ...);
  });

  describe('Form flow detection', () => {
    it('detects <form> with fields and submit button as a flow', ...);
    it('orders form steps correctly', ...);
    it('links form action URL to backend endpoint', ...);
    it('assigns correct test values per field type', ...);
    it('detects email field from type="email" → uses SMOKE_TEST_EMAIL', ...);
    it('detects password field from type="password" → uses SMOKE_TEST_PASSWORD', ...);
  });

  describe('Conditional and dynamic elements', () => {
    it('flags {condition && <button>} as CONDITIONAL_ELEMENT', ...);
    it('flags ternary rendering as CONDITIONAL_ELEMENT', ...);
    it('flags .map() rendering as DYNAMIC_LIST', ...);
    it('generates regex locator for dynamic testids', ...);
  });
});
```

### 2.8 Auth Detector — Complete Test Cases

```typescript
describe('AuthDetector', () => {

  describe('Login endpoint detection', () => {
    it('finds POST /auth/login by path convention', ...);
    it('finds POST /api/v1/auth/login by path convention', ...);
    it('confirms by email+password body fields', ...);
    it('extracts token field "accessToken" from response schema', ...);
    it('extracts token field "token" from response schema', ...);
    it('extracts token field at nested path "data.accessToken"', ...);
    it('returns null when no login endpoint found', ...);
  });

  describe('Auth type detection', () => {
    it('detects bearer_jwt from Authorization header extraction', ...);
    it('detects bearer_jwt from jsonwebtoken.verify() call', ...);
    it('detects bearer_jwt from passport JwtStrategy', ...);
    it('detects session_cookie from req.cookies access', ...);
    it('detects next_auth from getServerSession() call', ...);
    it('detects api_key_header from x-api-key header access', ...);
  });

  describe('Route enrichment', () => {
    it('marks routes after app.use(authenticate) as authRequired: true', ...);
    it('marks specific route with auth middleware as authRequired: true', ...);
    it('leaves public routes as authRequired: false', ...);
  });
});
```

---

## SECTION 3 — LAYER 2: INTEGRATION TESTS (PIPELINE ACCURACY)

Integration tests run the full extraction pipeline on fixture repos and assert the complete blueprint output — without making any AI API calls.

### 3.1 What Integration Tests Verify

```
Input:  Fixture repo directory (real files, real structure)
Output: TestBlueprint JSON

Assertions:
  - Correct number of endpoints found
  - Correct methods on each endpoint
  - Correct paths (including prefix resolution)
  - Correct schema fields and types
  - Correct auth detection
  - Correct page inventory
  - Correct locators generated
  - Confidence scores within expected ranges
  - No unexpected DYNAMIC_PATH or UNRESOLVED_PREFIX flags
```

### 3.2 Integration Test Pattern

```typescript
// test/integration/express-zod.test.ts

import { describe, it, expect, beforeAll } from 'vitest';
import { cloneRepo } from '../../src/ingestion/cloner';
import { detect } from '../../src/ingestion/detector';
import { getAllFiles } from '../../src/utils/file-utils';
import { parseFile } from '../../src/analysis/parser';
import { runExtractors } from '../../src/analysis/backend';
import { detectAuth } from '../../src/analysis/auth/auth-detector';
import { buildBlueprint } from '../../src/blueprint/builder';
import { ANALYZABLE_EXTENSIONS } from '../../src/analysis/parser';
import path from 'path';

const FIXTURE_PATH = path.join(__dirname, '../fixtures/express-zod');

describe('Express + Zod — Full Pipeline Integration', () => {
  let blueprint: TestBlueprint;

  beforeAll(async () => {
    // Run full pipeline on fixture (no AI calls)
    const detection = await detect(FIXTURE_PATH);
    const files = getAllFiles(FIXTURE_PATH, ANALYZABLE_EXTENSIONS)
      .map(f => parseFile(f))
      .filter(Boolean) as ParsedFile[];

    const endpoints = await runExtractors(files, detection.packages[0]);
    const auth = await detectAuth(files, endpoints);
    const pages: ExtractedPage[] = []; // no UI in this fixture
    blueprint = buildBlueprint(
      'local://test',
      detection,
      endpoints,
      pages,
      auth,
      {} as HarvestedConfigs
    );
  }, 30000);

  describe('Endpoint extraction', () => {
    it('finds exactly 12 endpoints', () => {
      expect(blueprint.endpoints).toHaveLength(12);
    });

    it('finds GET /api/v1/users', () => {
      const ep = blueprint.endpoints.find(e => e.method === 'GET' && e.path === '/api/v1/users');
      expect(ep).toBeDefined();
      expect(ep!.authRequired).toBe(true);
    });

    it('finds POST /api/v1/users with correct schema fields', () => {
      const ep = blueprint.endpoints.find(e => e.method === 'POST' && e.path === '/api/v1/users');
      expect(ep).toBeDefined();
      expect(ep!.requestBody!.fields.map(f => f.name)).toContain('email');
      expect(ep!.requestBody!.fields.map(f => f.name)).toContain('password');
    });

    it('resolves prefix correctly: /api/v1/users/:userId not /users/:userId', () => {
      const ep = blueprint.endpoints.find(e => e.path === '/api/v1/users/:userId');
      expect(ep).toBeDefined();
    });

    it('all auth-required routes have authRequired: true', () => {
      const protectedPaths = ['/api/v1/users', '/api/v1/products'];
      protectedPaths.forEach(path => {
        const ep = blueprint.endpoints.find(e => e.path.startsWith(path));
        expect(ep?.authRequired).toBe(true);
      });
    });
  });

  describe('Auth config', () => {
    it('finds login endpoint', () => {
      expect(blueprint.auth).not.toBeNull();
      expect(blueprint.auth!.loginEndpoint).toBe('POST /api/v1/auth/login');
    });

    it('extracts accessToken as token field', () => {
      expect(blueprint.auth!.tokenResponsePath).toBe('accessToken');
    });
  });

  describe('Confidence scores', () => {
    it('all endpoints have confidence > 0.70', () => {
      blueprint.endpoints.forEach(ep => {
        expect(ep.confidence).toBeGreaterThan(0.70);
      });
    });

    it('no endpoints have UNRESOLVED_PREFIX flag', () => {
      blueprint.endpoints.forEach(ep => {
        expect(ep.flags).not.toContain('UNRESOLVED_PREFIX');
      });
    });
  });
});
```

### 3.3 Integration Test Fixtures — What Each Must Contain

Each fixture is a directory of real TypeScript/JavaScript files (not a running app — just source code). Build them to cover every pattern in the spec.

#### EXPRESS-ZOD Fixture Must Cover:
```
fixtures/express-zod/
├── package.json                  ← { "dependencies": { "express": "...", "zod": "..." } }
├── src/
│   ├── app.ts                    ← app.use('/api/v1', v1Router) prefix mounting
│   ├── middleware/
│   │   ├── auth.ts               ← authenticate middleware (jwt.verify)
│   │   ├── validate.ts           ← validateBody(schema) middleware
│   │   └── rbac.ts               ← requireRole(['admin']) middleware
│   └── routes/
│       ├── v1/
│       │   ├── auth.routes.ts    ← public routes (login, register, refresh)
│       │   ├── users.routes.ts   ← CRUD + nested (/users/:userId/activity)
│       │   ├── products.routes.ts← CRUD + nested variants + inventory
│       │   └── orders.routes.ts  ← CRUD + cancel + refund + tracking
│       └── v2/
│           └── users.routes.ts   ← versioned routes (cursor pagination)
```

**Required edge cases to include in this fixture:**
- Cross-file router mounting (v1Router mounted in app.ts, routes defined elsewhere)
- Conditional route: `if (process.env.FEATURE_X) { router.get('/beta', handler) }`
- Dynamic path: `` app.get(`/${resource}/:id`, handler) ``
- File upload: `router.post('/avatar', upload.single('file'), handler)`
- Chain: `router.route('/users').get(list).post(create)`
- Nested router prefix: `v1Router.use('/admin', adminRouter)`

#### NESTJS Fixture Must Cover:
```
fixtures/nestjs/
├── package.json                  ← { "dependencies": { "@nestjs/core": "...", "class-validator": "..." } }
├── src/
│   ├── main.ts                   ← app.setGlobalPrefix('api'), app.enableVersioning()
│   ├── app.module.ts             ← imports UsersModule, AuthModule, ProductsModule
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts    ← @Controller('auth'), @Public() on login/register
│   │   └── dto/
│   │       ├── login.dto.ts      ← class-validator decorators
│   │       └── register.dto.ts
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.controller.ts   ← @UseGuards(JwtAuthGuard), @Roles('admin')
│   │   └── dto/
│   │       ├── create-user.dto.ts← nested DTO with @ValidateNested
│   │       └── user-query.dto.ts ← @IsOptional() query params
│   └── products/
│       ├── products.module.ts
│       └── products.controller.ts← versioned: @Version('2')
```

#### NEXTJS-APP-ROUTER Fixture Must Cover:
```
fixtures/nextjs-app/
├── package.json                  ← { "dependencies": { "next": "14..." } }
├── app/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── login/route.ts    ← POST only, no auth
│   │   │   └── me/route.ts       ← GET, requires auth
│   │   ├── users/
│   │   │   ├── route.ts          ← GET + POST
│   │   │   └── [userId]/
│   │   │       ├── route.ts      ← GET + PATCH + DELETE
│   │   │       └── orders/
│   │   │           └── route.ts  ← GET (nested dynamic)
│   │   └── products/
│   │       └── [productId]/
│   │           └── route.ts
│   ├── (auth)/                   ← route group
│   │   └── login/
│   │       └── page.tsx          ← UI page
│   └── (dashboard)/              ← route group
│       ├── dashboard/
│       │   └── page.tsx
│       └── users/
│           └── page.tsx
├── middleware.ts                  ← matcher config for protected routes
└── components/
    ├── LoginForm.tsx              ← form with data-testid attributes
    └── UserTable.tsx              ← table with aria labels
```

#### TRPC Fixture Must Cover:
```
fixtures/trpc/
├── package.json                  ← { "dependencies": { "@trpc/server": "...", "zod": "..." } }
├── src/
│   ├── server/
│   │   ├── trpc.ts               ← createTRPCRouter, publicProcedure, protectedProcedure
│   │   ├── root.ts               ← appRouter combining all routers
│   │   └── routers/
│   │       ├── auth.router.ts    ← login mutation, me query
│   │       ├── users.router.ts   ← getAll query, getById query, create mutation
│   │       └── products.router.ts
│   └── pages/
│       └── api/
│           └── trpc/
│               └── [trpc].ts     ← tRPC adapter → base path /api/trpc
```

#### REMIX Fixture Must Cover:
```
fixtures/remix/
├── package.json                  ← { "dependencies": { "@remix-run/node": "..." } }
├── app/
│   ├── routes/
│   │   ├── _index.tsx            ← / (home, loader only)
│   │   ├── login.tsx             ← /login (action: POST)
│   │   ├── users._index.tsx      ← /users (loader: GET, action: POST)
│   │   ├── users.$userId.tsx     ← /users/:userId (loader: GET, action: PUT+DELETE)
│   │   ├── users.$userId.edit.tsx← /users/:userId/edit
│   │   ├── api.products.tsx      ← /api/products (resource route, no component)
│   │   └── [sitemap.xml].tsx     ← /sitemap.xml (bracket escape)
│   └── utils/
│       └── auth.server.ts        ← requireUser() auth utility
```

#### REACT-SPA Fixture Must Cover:
```
fixtures/react-spa/
├── package.json                  ← { "dependencies": { "react": "...", "react-router-dom": "..." } }
├── src/
│   ├── App.tsx                   ← React Router v6 routes
│   ├── pages/
│   │   ├── LoginPage.tsx         ← form with data-testid
│   │   ├── UsersPage.tsx         ← table with aria-label
│   │   ├── UserDetailPage.tsx    ← dynamic route /users/:userId
│   │   └── DashboardPage.tsx     ← auth-gated
│   └── components/
│       ├── LoginForm.tsx         ← all 5 locator strategies present
│       ├── UserTable.tsx         ← data-testid on rows
│       └── NavBar.tsx            ← navigation links
```

---

## SECTION 4 — LAYER 3: EXECUTION TESTS (END-TO-END VALIDATION)

The highest-value tests. These run the FULL pipeline including AI generation and then ACTUALLY EXECUTE the generated Playwright tests against a running application.

### 4.1 What These Tests Do

```
1. Start a real mini application (Docker or in-process)
2. Run smokeforge generate <repo-url> on it
3. Run the generated Playwright tests against the running app
4. Assert: all generated @smoke tests pass
5. Assert: all generated Postman requests return 2xx
6. Measure: what % of actual endpoints were covered
```

### 4.2 Mini App Repos (Git Submodules)

Create three minimal but real applications as separate git repos. Keep them in `test/repos/` as git submodules. They must be runnable with a single command.

```
test/repos/
├── express-todo-api/           ← Express + Zod + JWT + SQLite (in-memory)
│   ├── src/
│   │   ├── app.ts
│   │   └── routes/
│   │       ├── auth.ts         ← POST /auth/login, POST /auth/register
│   │       ├── todos.ts        ← GET/POST /todos, GET/PATCH/DELETE /todos/:id
│   │       └── users.ts        ← GET /users/me, PATCH /users/me
│   ├── package.json
│   └── Dockerfile
│
├── nextjs-blog/                ← Next.js App Router + Prisma (SQLite) + NextAuth
│   ├── app/
│   │   ├── api/
│   │   │   ├── posts/route.ts
│   │   │   └── posts/[id]/route.ts
│   │   ├── (auth)/login/page.tsx
│   │   └── posts/page.tsx
│   ├── components/
│   │   ├── LoginForm.tsx
│   │   └── PostList.tsx
│   └── package.json
│
└── nestjs-inventory/           ← NestJS + class-validator + JWT + in-memory store
    ├── src/
    │   ├── auth/
    │   ├── products/
    │   └── users/
    └── package.json
```

### 4.3 E2E Test Structure

```typescript
// test/e2e/express-app.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

const REPO_PATH = path.join(__dirname, '../repos/express-todo-api');
const OUTPUT_PATH = path.join(__dirname, '../e2e-output/express');
const APP_PORT = 4001;

describe('Express Todo API — Full E2E', () => {
  let appProcess: ChildProcess;

  beforeAll(async () => {
    // 1. Start the test application
    appProcess = spawn('node', ['dist/app.js'], {
      cwd: REPO_PATH,
      env: { ...process.env, PORT: String(APP_PORT), NODE_ENV: 'test' }
    });
    await waitForPort(APP_PORT, 10000);

    // 2. Run SmokeForge generation
    execSync(
      `node dist/cli/index.js generate ${REPO_PATH} --output ${OUTPUT_PATH} --base-url http://localhost:${APP_PORT}`,
      {
        env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
        timeout: 120000
      }
    );
  }, 180000);

  afterAll(async () => {
    appProcess?.kill();
    fs.rmSync(OUTPUT_PATH, { recursive: true, force: true });
  });

  describe('Generated files exist', () => {
    it('creates Playwright config', () => {
      expect(fs.existsSync(path.join(OUTPUT_PATH, 'playwright/playwright.config.ts'))).toBe(true);
    });
    it('creates auth fixture', () => {
      expect(fs.existsSync(path.join(OUTPUT_PATH, 'playwright/fixtures/auth.fixture.ts'))).toBe(true);
    });
    it('creates at least one spec file', () => {
      const specs = fs.readdirSync(path.join(OUTPUT_PATH, 'playwright/smoke'))
        .filter(f => f.endsWith('.spec.ts'));
      expect(specs.length).toBeGreaterThan(0);
    });
    it('creates Postman collection', () => {
      expect(fs.existsSync(path.join(OUTPUT_PATH, 'postman/smoke-tests.postman_collection.json'))).toBe(true);
    });
  });

  describe('Generated Playwright tests compile', () => {
    it('tsc --noEmit passes on generated files', () => {
      expect(() => {
        execSync('tsc --noEmit', { cwd: path.join(OUTPUT_PATH, 'playwright') });
      }).not.toThrow();
    });
  });

  describe('Generated Playwright tests pass', () => {
    it('all @smoke tests pass against running app', () => {
      const result = execSync(
        'npx playwright test --grep @smoke --reporter=json',
        {
          cwd: path.join(OUTPUT_PATH, 'playwright'),
          env: {
            ...process.env,
            BASE_URL: `http://localhost:${APP_PORT}`,
            SMOKE_TEST_EMAIL: 'smoketest@example.com',
            SMOKE_TEST_PASSWORD: 'SmokeTest123!'
          }
        }
      ).toString();

      const report = JSON.parse(result);
      expect(report.stats.unexpected).toBe(0);  // zero failed tests
    });
  });

  describe('Endpoint coverage', () => {
    it('covers at least 80% of actual endpoints', () => {
      // Read smokeforge-report.json and check coverage
      const report = JSON.parse(
        fs.readFileSync(path.join(OUTPUT_PATH, 'smokeforge-report.json'), 'utf-8')
      );
      const total = report.summary.totalEndpoints;
      const covered = total - report.summary.todos;
      expect(covered / total).toBeGreaterThan(0.80);
    });
  });
});
```

---

## SECTION 5 — FIXTURE REPO STRATEGY

### 5.1 Fixture Design Principles

Every fixture must be designed to test a specific extraction capability. Do not create generic fixtures — every file in every fixture should be there because it tests a specific pattern from the spec.

**Each fixture must include a `FIXTURE_MANIFEST.json`** documenting exactly what it tests:

```json
{
  "name": "express-zod",
  "framework": "express",
  "schemaLibrary": "zod",
  "expectedEndpoints": [
    { "method": "POST", "path": "/api/v1/auth/login", "authRequired": false, "schemaFields": ["email", "password"] },
    { "method": "GET", "path": "/api/v1/users", "authRequired": true, "roles": ["admin", "manager"] },
    { "method": "GET", "path": "/api/v1/users/:userId", "authRequired": true, "pathParams": ["userId"] }
  ],
  "expectedPages": [],
  "authConfig": {
    "loginEndpoint": "POST /api/v1/auth/login",
    "tokenResponsePath": "accessToken"
  },
  "edgeCasesPresent": [
    "cross-file-prefix-resolution",
    "conditional-route",
    "dynamic-path",
    "file-upload",
    "router-chain"
  ]
}
```

The integration test reads `FIXTURE_MANIFEST.json` and asserts the blueprint matches it exactly. This makes the manifest the source of truth and makes failures immediately obvious.

### 5.2 Complete Fixture List

| Fixture | Framework | Schema | Edge Cases |
|---|---|---|---|
| express-zod | Express | Zod | Cross-file, conditional, dynamic |
| express-joi | Express | Joi | No TS types, CommonJS require |
| express-vanilla | Express | None (inference) | Destructuring only |
| express-js | Express (JS) | None | Plain JavaScript, module.exports |
| fastify-typebox | Fastify | TypeBox | Plugin prefix, scoped hooks |
| fastify-zod | Fastify | Zod | @fastify/zod-validator |
| nestjs-full | NestJS | class-validator | Global prefix, versioning, nested DTOs |
| nestjs-swagger | NestJS | class-validator + @ApiProperty | Swagger examples |
| nextjs-pages | Next.js | Zod | Pages router, middleware.ts |
| nextjs-app | Next.js | Zod | App router, route groups, middleware |
| nextjs-mixed | Next.js | Both Zod + TS types | Pages + App router mixed |
| trpc-nextjs | tRPC + Next.js | Zod | Pages adapter |
| trpc-express | tRPC + Express | Zod | Express adapter |
| remix-flat | Remix | Zod | v2 flat routing, action methods |
| remix-legacy | Remix | TS types | v1 __auth prefix convention |
| koa-router | Koa | Joi | koa-router prefix |
| hapi-joi | Hapi | Joi | Hapi route config object |
| hono-zod | Hono | Zod | basePath, zValidator |
| sveltekit | SvelteKit | Zod | +server.ts, +page.server.ts |
| elysia | Elysia | TypeBox | Bun-native, guard plugin |
| react-router-v6 | React SPA | — | All 5 locator strategies |
| react-router-v5 | React SPA | — | v5 Route syntax |
| vue-spa | Vue 3 | — | Script setup, Options API |
| angular | Angular | — | Reactive forms, template-driven |
| nextjs-fullstack | Next.js | Zod | API + UI + auth in one |
| monorepo-turborepo | Express + Next.js | Zod | Turbo monorepo, workspace packages |
| monorepo-nx | NestJS + Angular | class-validator | Nx monorepo |
| mixed-js-ts | Express | Mixed | .js + .ts files in same repo |

---

## SECTION 6 — SNAPSHOT TESTING STRATEGY

Snapshot tests catch AI generation regressions. When the prompt changes or the model updates, snapshots tell you exactly what changed in the output.

### 6.1 How Snapshot Tests Work

```typescript
// test/unit/generation/playwright.generator.test.ts

import { describe, it, expect } from 'vitest';
import { buildPlaywrightUserMessage } from '../../../src/generation/playwright.generator';
import { mockAuthChunk } from '../../helpers/mock-blueprints';

// NOTE: We snapshot the PROMPT (user message), not the AI output.
// AI output is non-deterministic — don't snapshot it.
// What IS deterministic: the prompt we send to the AI.

describe('Playwright prompt generation', () => {
  it('generates correct prompt for auth domain chunk', () => {
    const chunk = mockAuthChunk();
    const prompt = buildPlaywrightUserMessage(chunk);
    expect(prompt).toMatchSnapshot();
  });

  it('generates correct prompt for users domain chunk with 5 endpoints', () => {
    const chunk = mockUsersChunk(5);
    const prompt = buildPlaywrightUserMessage(chunk);
    expect(prompt).toMatchSnapshot();
  });
});
```

### 6.2 Snapshot the Blueprint, Not the AI Output

```typescript
// test/integration/express-zod.test.ts

it('generates correct blueprint — snapshot', () => {
  // Snapshot the TestBlueprint JSON
  // This catches regressions in extraction logic
  expect(blueprint).toMatchSnapshot();
});

// When extraction logic improves, update snapshots intentionally:
// vitest --update-snapshots
```

### 6.3 AI Output Quality Test (Non-Deterministic)

For AI output, instead of exact snapshots, use structural assertions:

```typescript
// test/e2e/output-quality.test.ts

describe('Generated Playwright output structure', () => {
  it('contains import statement', () => {
    expect(output).toMatch(/import \{ test, expect \} from '@playwright\/test'/);
  });
  it('contains at least one test.describe block', () => {
    expect(output).toMatch(/test\.describe\(/);
  });
  it('contains @smoke tag on every test', () => {
    const tests = output.match(/test\(['"]/g) || [];
    const smokeTests = output.match(/@smoke/g) || [];
    expect(smokeTests.length).toBeGreaterThanOrEqual(tests.length);
  });
  it('uses BASE_URL env var not hardcoded URL', () => {
    expect(output).not.toMatch(/https?:\/\/(?!.*BASE_URL)/);
  });
  it('has no test blocks without expect()', () => {
    // Parse test blocks and verify each contains expect
    const testBlocks = extractTestBlocks(output);
    testBlocks.forEach(block => {
      expect(block).toContain('expect(');
    });
  });
});
```

---

## SECTION 7 — AI OUTPUT QUALITY EVALUATION

A dedicated evaluation harness to measure generation quality over time. Run this monthly or after any prompt change.

### 7.1 Evaluation Metrics

```typescript
// test/eval/quality-evaluator.ts

export interface EvalResult {
  fixture: string;
  framework: string;

  // Extraction metrics
  endpointRecall: number;       // % of actual endpoints found
  endpointPrecision: number;    // % of found endpoints that are correct (no hallucinations)
  schemaAccuracy: number;       // % of schema fields correctly extracted
  authAccuracy: number;         // auth config correct? (0 or 1)
  locatorQuality: number;       // avg locator strategy score (testId=1.0, css=0.5)

  // Generation metrics
  compilationSuccess: boolean;  // tsc --noEmit passes?
  testCount: number;            // how many tests generated?
  assertionCoverage: number;    // % of tests with assertions
  syntaxErrors: number;         // parsing errors in output

  // Execution metrics (Layer 3 only)
  passRate: number;             // % of generated tests that pass
  coverageRate: number;         // % of endpoints covered by passing tests
}
```

### 7.2 Evaluation Runner

```typescript
// test/eval/run-eval.ts

// Run against every fixture and produce a quality report
// Compare against baseline (stored in test/eval/baseline.json)
// Alert if any metric drops > 5% from baseline

const METRICS_BASELINE = {
  'express-zod': {
    endpointRecall: 0.95,
    endpointPrecision: 1.0,
    schemaAccuracy: 0.92,
    authAccuracy: 1.0,
  },
  'nestjs-full': {
    endpointRecall: 0.90,
    schemaAccuracy: 0.88,
    authAccuracy: 1.0,
  },
  // ... per fixture
};

// Run: pnpm eval
// Output: test/eval/results-<timestamp>.json
// Diff: test/eval/baseline.json vs latest
```

---

## SECTION 8 — CI/CD PIPELINE

### 8.1 GitHub Actions Workflow

```yaml
# .github/workflows/ci.yml

name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  # ── Fast checks (always run) ──────────────────────────────────────────────
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm install
      - run: pnpm tsc --noEmit

  # ── Unit tests (always run, fast) ────────────────────────────────────────
  unit-tests:
    runs-on: ubuntu-latest
    needs: typecheck
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm install
      - run: pnpm vitest run --coverage
      - uses: codecov/codecov-action@v4

  # ── Integration tests (always run, medium speed) ─────────────────────────
  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    strategy:
      matrix:
        fixture-group:
          - "express"
          - "nestjs"
          - "nextjs"
          - "trpc-remix"
          - "ui-frameworks"
          - "monorepos"
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: true        # for test/repos submodules
      - uses: pnpm/action-setup@v3
      - run: pnpm install
      - run: pnpm vitest run test/integration/${{ matrix.fixture-group }}*

  # ── E2E tests (only on main, requires API key) ────────────────────────────
  e2e-tests:
    runs-on: ubuntu-latest
    needs: integration-tests
    if: github.ref == 'refs/heads/main'
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      SMOKE_TEST_EMAIL: smoketest@example.com
      SMOKE_TEST_PASSWORD: SmokeTest123!
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: true
      - uses: pnpm/action-setup@v3
      - run: pnpm install
      - run: pnpm build
      - name: Run E2E tests
        run: pnpm vitest run --config vitest.e2e.config.ts
        timeout-minutes: 20

  # ── Quality evaluation (weekly, on schedule) ─────────────────────────────
  quality-eval:
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule'
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install && pnpm build
      - run: pnpm eval
      - name: Upload eval results
        uses: actions/upload-artifact@v4
        with:
          name: eval-results-${{ github.run_id }}
          path: test/eval/results-*.json

# ── Scheduled quality evaluation ─────────────────────────────────────────────
on:
  schedule:
    - cron: '0 2 * * 1'   # Every Monday 2am UTC
```

### 8.2 Test Commands in package.json

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "test:watch": "vitest watch test/unit",
    "test:coverage": "vitest run --coverage",
    "eval": "ts-node test/eval/run-eval.ts",
    "eval:diff": "ts-node test/eval/diff-baseline.ts"
  }
}
```

---

## SECTION 9 — COVERAGE TARGETS PER FRAMEWORK

These are the minimum acceptable coverage numbers before shipping each framework extractor.

| Framework | Endpoint Recall | Schema Accuracy | Auth Accuracy | Locator Quality | Min E2E Pass Rate |
|---|---|---|---|---|---|
| Express + Zod | ≥ 95% | ≥ 90% | 100% | — | ≥ 90% |
| Express + Joi | ≥ 95% | ≥ 85% | 100% | — | ≥ 85% |
| Express (no schema) | ≥ 90% | ≥ 50% | 100% | — | ≥ 70% |
| Express (JavaScript) | ≥ 85% | ≥ 45% | 95% | — | ≥ 65% |
| Fastify + TypeBox | ≥ 90% | ≥ 85% | 100% | — | ≥ 85% |
| NestJS | ≥ 88% | ≥ 88% | 100% | — | ≥ 85% |
| Next.js App Router | ≥ 88% | ≥ 82% | 95% | ≥ 80% | ≥ 82% |
| Next.js Pages Router | ≥ 90% | ≥ 80% | 95% | ≥ 75% | ≥ 80% |
| tRPC | ≥ 85% | ≥ 88% | 95% | — | ≥ 80% |
| Remix | ≥ 75% | ≥ 70% | 90% | ≥ 65% | ≥ 70% |
| Koa | ≥ 88% | ≥ 80% | 95% | — | ≥ 80% |
| Hapi | ≥ 90% | ≥ 88% | 100% | — | ≥ 85% |
| Hono | ≥ 90% | ≥ 85% | 95% | — | ≥ 82% |
| SvelteKit | ≥ 80% | ≥ 75% | 90% | ≥ 65% | ≥ 75% |
| Elysia | ≥ 85% | ≥ 80% | 90% | — | ≥ 78% |
| React SPA | — | — | — | ≥ 85% | ≥ 80% |
| Vue SPA | — | — | — | ≥ 75% | ≥ 72% |
| Angular | — | — | — | ≥ 72% | ≥ 70% |
| Monorepo (mixed) | ≥ 80% | ≥ 78% | 95% | ≥ 72% | ≥ 75% |

**How to measure endpoint recall:**
```
recall = (endpoints found by SmokeForge) / (actual endpoints in fixture manifest)
precision = (correct endpoints) / (endpoints found by SmokeForge)
```

**How to measure schema accuracy:**
```
For each endpoint with a schema:
  accuracy = (correct fields found) / (total fields in fixture manifest)
  Overall = average across all endpoints
```

---

## SECTION 10 — TEST DATA & FIXTURE MANAGEMENT

### 10.1 Fixture Versioning

```
test/fixtures/
└── express-zod/
    ├── FIXTURE_MANIFEST.json   ← source of truth for assertions
    ├── FIXTURE_VERSION         ← "1.2.0" — bump when fixture changes
    └── src/                   ← actual TypeScript files
```

When a fixture changes (new pattern added), bump `FIXTURE_VERSION` and update `FIXTURE_MANIFEST.json`. The integration test reads the version and ensures it matches the expected manifest.

### 10.2 Real-World Repo Snapshot Tests

Once a month, run SmokeForge against these real public repos and snapshot the blueprint output:

```typescript
const REAL_WORLD_REPOS = [
  'https://github.com/trpc/examples-next-prisma-starter',  // tRPC + Next.js
  'https://github.com/nestjs/nest/tree/master/sample/01-cats-app', // NestJS
  'https://github.com/remix-run/examples/tree/main/todos', // Remix
  'https://github.com/vercel/next.js/tree/canary/examples/with-mongodb', // Next.js
];

// If blueprint output changes from last snapshot → investigation required
// Either the extractor improved (expected) or regressed (bug)
```

---

## SECTION 11 — REGRESSION TESTING STRATEGY

### 11.1 When to Run Regression Tests

| Trigger | Tests to Run |
|---|---|
| Any PR | Unit tests + affected integration tests |
| Merge to main | All unit + all integration + E2E |
| Prompt change | All unit + all integration + E2E + quality eval |
| Model version update | Full quality eval + E2E |
| New extractor added | Unit tests for new extractor + all integration |
| Schema extractor change | All extractors that use that schema library |

### 11.2 Extractor Regression Test Pattern

When a bug is found in an extractor, immediately add a test that reproduces it:

```typescript
// REGRESSION: Bug #47 — Express extractor missed routes when
// router variable was renamed after creation
it('REGRESSION #47: extracts routes when router is renamed', () => {
  const files = createFixtureFiles({
    'app.ts': `
      const router = express.Router();
      const renamedRouter = router;  // renamed!
      renamedRouter.get('/users', handler);
      app.use('/api', renamedRouter);
    `
  });

  const result = await extractor.extract(files, mockDetection('express'));
  expect(result).toHaveLength(1);
  expect(result[0].path).toBe('/api/users');
});
```

Never delete regression tests. They are a historical record of bugs.

---

## SECTION 12 — IMPLEMENTATION ORDER FOR TESTS

Build tests in this exact order — parallel to the source code build:

```
1.  test/helpers/fixture-helpers.ts          ← Before ANY test
2.  test/helpers/mock-blueprints.ts          ← Mock data builders
3.  test/unit/ingestion/detector.test.ts     ← After Step 5 (detector)
4.  test/unit/analysis/schemas/zod.extractor.test.ts  ← After Step 10
5.  test/unit/analysis/backend/express.extractor.test.ts ← After Step 12
6.  test/fixtures/express-zod/               ← Build fixture after unit tests pass
7.  test/integration/express-zod.test.ts     ← After fixture + pipeline works
8.  All remaining unit tests (one per extractor)
9.  All remaining fixtures (one per framework)
10. All remaining integration tests
11. test/e2e/ (after everything else works)
12. test/eval/ (monthly evaluation harness)
```

**Golden rule: Never commit an extractor without its unit tests. Never commit a new framework support without its fixture and integration test.**

---

## QUICK REFERENCE — Test Count Targets

| Test Type | Target Count | Runtime |
|---|---|---|
| Unit tests | ~600 tests | < 30 seconds |
| Integration tests | ~28 test suites | < 3 minutes |
| E2E tests | ~3 test suites | < 10 minutes |
| Eval harness | 28 fixtures × 5 metrics | ~30 minutes |
| **Total (CI, no E2E)** | **~630 tests** | **< 4 minutes** |
