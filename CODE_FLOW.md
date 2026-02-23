# SmokeForge — Full Code Flow Walkthrough

> **Framework used as the running example throughout this document: Remix (enterprise-remix-healthcare)**  
> Command: `node smokeforge/dist/cli/index.js generate ./enterprise-repos/enterprise-remix-healthcare --output smokeforge-output/smoke-v2-healthcare`

---

## High-Level Overview

```
CLI entry ──► generate command ──► 14-step pipeline
                                        │
                ┌───────────────────────┼───────────────────────────────────┐
                │                       │                                   │
          [INGESTION]            [ANALYSIS]                         [GENERATION]
          cloner.ts              parser.ts                          client.ts
          detector.ts            backend/remix.extractor.ts         playwright.generator.ts
          config-harvester.ts    ui/router-extractor.ts             prompts/playwright.system.ts
                                 auth/auth-detector.ts              criticality-ranker.ts
                                 blueprint/builder.ts
                                 blueprint/chunker.ts
                                        │
                                 [OUTPUT]
                                 playwright-writer.ts
                                 reporter.ts
```

---

## Step-by-Step Code Flow

---

### STEP 0 — CLI Entrypoint

**File:** `smokeforge/src/cli/index.ts`

```
node smokeforge/dist/cli/index.js generate <repo-path> --output <dir>
```

1. `dotenv` loads `smokeforge/.env` → injects `ANTHROPIC_API_KEY` into `process.env`
2. `commander` parses argv → matches the `generate <repo-url>` command
3. Calls `generateCommand(repoUrl, options)` from `commands/generate.ts`

**Key imports at this point:**
```
cli/index.ts
  └─► cli/commands/generate.ts     ← orchestrates all 14 steps
```

---

### STEP 1 — Validate API Key

**File:** `smokeforge/src/cli/commands/generate.ts` (lines ~190–200)

```typescript
if (!options.dryRun && !process.env["ANTHROPIC_API_KEY"]) {
  logError("ANTHROPIC_API_KEY is not set...");
  process.exit(1);
}
```

- If `--dry-run` flag is set, this step is skipped entirely (no LLM calls needed)
- Otherwise, confirms the key exists before any expensive work starts

---

### STEP 2 — Clone / Read Repository

**File:** `smokeforge/src/ingestion/cloner.ts`

```
generate.ts
  └─► cloneRepo(repoUrl, undefined, options.branch)
        └─► isLocalPath(repoUrl) ?
              YES → path.resolve(repoUrl), no-op cleanup
              NO  → simpleGit().clone(url, tempDir, ['--depth', '1'])
```

**For Remix example (local path):**
- `repoUrl = "./enterprise-repos/enterprise-remix-healthcare"`
- `isLocalPath()` returns `true` → resolves to `/Users/.../enterprise-remix-healthcare`
- `cleanup()` is a no-op (local paths are never deleted)

**For remote GitHub URL:**
- Creates a temp dir: `/tmp/smokeforge-<timestamp>-<random>`
- Reads `GITHUB_TOKEN` or `GHE_TOKEN` from env
- Injects as `Authorization: token <tok>` HTTP header on the clone
- `cleanup()` deletes the temp dir at step 14

**Returns:** `{ repoPath, repoName, cleanup }`

---

### STEP 3 — Detect Frameworks

**File:** `smokeforge/src/ingestion/detector.ts`

```
generate.ts
  └─► detect(repoPath)
        └─► readJson(repoPath/package.json)
              └─► inspects "dependencies" + "devDependencies" keys
                    ├─ "remix" | "@remix-run/*"    → backendFramework: "remix"
                    ├─ "express"                   → "express"
                    ├─ "fastify"                   → "fastify"
                    ├─ "next"                      → "nextjs"
                    ├─ "react"                     → frontendFramework: "react-spa"
                    ├─ "jsonwebtoken"              → authLibrary: "jsonwebtoken"
                    ├─ "zod"                       → schemaLibrary: "zod"
                    └─ ... (40+ pattern matches)
```

**For Remix example, returns:**
```json
{
  "monorepo": false,
  "packages": [{
    "backendFrameworks": ["remix"],
    "frontendFrameworks": ["react-spa"],
    "authLibraries": ["jsonwebtoken"],
    "schemaLibraries": ["zod"],
    "routerLibraries": ["react-router-dom"]
  }]
}
```

This `DetectionResult` is passed to every downstream extractor so each one can decide whether it can handle this repo.

---

### STEP 4a — Parse All Source Files into ASTs

**File:** `smokeforge/src/analysis/parser.ts`

```
generate.ts
  └─► getAllFiles(repoPath, ANALYZABLE_EXTENSIONS)
        └─► walks directory tree, skips: node_modules, .git, dist,
            build, __tests__, e2e, cypress, smoke, spec, coverage
            collects: *.ts, *.tsx, *.js, *.jsx, *.mjs, *.cjs

  └─► parsedFiles = allFiles.map(f => parseFile(f)).filter(notNull)
        └─► parseFile(filePath)
              └─► readFileSync(filePath, 'utf-8')
              └─► @typescript-eslint/typescript-estree parse(code, {
                    jsx: true for .tsx/.jsx,
                    loc: true, range: true
                  })
              └─► returns { filePath, ast: TSESTree.Program, code }
              └─► parse error → warns + returns null (never aborts)
```

**For Remix example:**
- Walks `app/` directory → collects `~40-60` `.ts/.tsx` files
- Skips `build/`, `node_modules/`
- Each parsed file carries its full AST for downstream extractors to traverse

---

### STEP 4b — Extract API Endpoints

**File:** `smokeforge/src/analysis/backend/index.ts` + `backend/remix.extractor.ts`

```
generate.ts
  └─► runExtractors(parsedFiles, detection)
        └─► loops EXTRACTOR_REGISTRY:
              [expressExtractor, nestjsExtractor, nextjsPagesExtractor,
               nextjsAppExtractor, fastifyExtractor, trpcExtractor,
               remixExtractor, koaExtractor, hapiExtractor,
               honoExtractor, sveltekitExtractor]

            └─► each extractor.canHandle(detection.packages[0])
                  └─► remixExtractor.canHandle() checks:
                        detection.backendFrameworks.includes("remix")
                        → TRUE → runs

                  └─► fastifyExtractor.canHandle() → FALSE → skipped
                  └─► expressExtractor.canHandle() → FALSE → skipped
                  ...

        └─► remixExtractor.extract(parsedFiles, detection)
              └─► for each parsedFile:
                    scans AST for Remix loader/action patterns:
                    ├─ export function loader({ request })
                    │    → extracts GET endpoint for that route file's path
                    ├─ export function action({ request })
                    │    → reads request.method / formData / json()
                    │    → extracts POST/PUT/PATCH/DELETE endpoint
                    └─ export async function action() with switch(request.method)
                         → multi-method endpoint

              └─► for each endpoint found, builds ExtractedEndpoint:
                    {
                      method: "POST",
                      path: "/api/appointments",
                      authRequired: true,       // detected from session checks
                      requestBody: {
                        source: "zod",
                        fields: [
                          { name: "patientId", type: "string", required: true },
                          { name: "date",      type: "string", required: true },
                          { name: "notes",     type: "string", required: false }
                        ]
                      },
                      pathParams: [],
                      queryParams: [],
                      responseSchema: { fields: [] },
                      flags: ["has-zod-schema"]
                    }
```

**All extractors run in parallel (`Promise.all`) and results are merged.**

---

### STEP 4c — Extract UI Pages

**Files:** `smokeforge/src/analysis/ui/router-extractor.ts`, `react.extractor.ts`

```
generate.ts
  └─► extractPages(parsedFiles, detection, repoPath)      ← router-extractor.ts
        └─► detects router type:
              remix detected → walks app/routes/ directory
              maps file paths to URL routes:
                app/routes/_index.tsx           → /
                app/routes/appointments._index.tsx → /appointments
                app/routes/appointments.$id.tsx    → /appointments/:id
                app/routes/login.tsx               → /login

              scans each route file's AST for:
              ├─ JSX elements → <h1>, <button>, <input>, <form>
              │    → builds locators: getByRole('heading'), getByRole('button')
              ├─ Link components → href targets → navigationLinks
              └─ meta() exports → page title

  └─► extractReactLocators(parsedFiles)                    ← react.extractor.ts
        └─► scans JSX for ARIA roles, labels,
            placeholder attributes, test IDs

  └─► extractVueLocators(parsedFiles)                      ← skipped (no Vue)
  └─► extractAngularLocators(parsedFiles)                  ← skipped (no Angular)

Merge step — deduplicates pages by route:
  routerPages + reactPages both produce a page for /login
  → merged into one ExtractedPage with combined locators
```

**For Remix example, produces ~10-15 ExtractedPage objects:**
```json
{
  "route": "/appointments",
  "title": "Appointments",
  "authRequired": true,
  "locators": [
    { "role": "heading", "name": "Appointments", "playwrightCode": "page.getByRole('heading', { name: 'Appointments', level: 1 })" },
    { "role": "button",  "name": "New Appointment", "playwrightCode": "page.getByRole('button', { name: 'New Appointment' })" }
  ],
  "formFlows": [],
  "navigationLinks": [{ "href": "/dashboard", "label": "Dashboard" }]
}
```

---

### STEP 5 — Auth Detection

**File:** `smokeforge/src/analysis/auth/auth-detector.ts`

```
generate.ts
  └─► detectAuth(parsedFiles, endpoints, repoPath)
        └─► scans ASTs for patterns:
              ├─ import ... from 'jsonwebtoken'         → tokenType: "jwt"
              ├─ import ... from 'next-auth'            → tokenType: "nextauth"
              ├─ session(options)  in route/middleware   → tokenType: "session_cookie"
              ├─ request.headers.authorization           → tokenType: "bearer"
              └─ passport.authenticate(...)             → tokenType: "passport"

        └─► finds login endpoint:
              looks for POST /login, /auth/login, /api/login, /api/auth/signin
              among extracted endpoints

        └─► extracts credentials fields:
              scans login endpoint's requestBody schema
              identifies { emailField: "email", passwordField: "password" }

        └─► reads SEED_CREDENTIALS.json if present:
              { "email": "admin@healthcare.com", "password": "Admin123!" }
              → defaultEmail + defaultPassword
```

**For Remix example, returns:**
```json
{
  "tokenType": "session_cookie",
  "loginEndpoint": "/login",
  "loginBodyFormat": "form",
  "credentialsFields": { "emailField": "email", "passwordField": "password" },
  "defaultEmail": "admin@healthcare.com",
  "defaultPassword": "Admin123!",
  "authCookieName": "__session"
}
```

---

### STEP 6 — Build Test Blueprint

**File:** `smokeforge/src/blueprint/builder.ts`

```
generate.ts
  └─► harvestConfigs(repoPath)    ← ingestion/config-harvester.ts
        └─► reads env files (.env, .env.example, .env.local)
            reads framework config (remix.config.js, vite.config.ts)
            extracts: PORT, DATABASE_URL, NODE_ENV, base paths
        └─► returns ConfigHints { inferredBaseUrl, port, envVars: [] }

  └─► buildBlueprint(repoUrl, detection, endpoints, allPages, auth, configs)
        └─► assembles TestBlueprint:
              {
                meta: { repoUrl, repoName, generatedAt, frameworks: ["remix"] },
                auth: <AuthConfig from step 5>,
                endpoints: <ExtractedEndpoint[] from step 4b>,
                pages: <ExtractedPage[] from step 4c>,
                testDataHints: { idSeed: "11111111-2222-3333-4444-555555555555" }
              }

  └─► writes blueprint.json → smokeforge-output/smoke-v2-healthcare/blueprint.json
```

The blueprint is the single source of truth passed to all downstream steps.

---

### STEP 7 — LLM Criticality Ranker

**File:** `smokeforge/src/blueprint/criticality-ranker.ts`

This is the **first LLM call** in the pipeline.

```
generate.ts
  └─► rankCriticalSurfaces(endpoints, pages, auth, outputDir, isDryRun)
        │
        ├─► inferAppType() → "full-stack" (has both endpoints + pages)
        │
        ├─► buildSurfaceManifest(endpoints, pages)
        │     └─► builds compact text list of all surfaces:
        │           === API ENDPOINTS ===
        │             POST   /login                  (🔒 auth-required)
        │             GET    /api/appointments       (🔒 auth-required)
        │             POST   /api/appointments       (🔒 auth-required)
        │             DELETE /api/appointments/:id   (🔒 auth-required)
        │           === UI PAGES ===
        │             PAGE  /              (title: "Home")
        │             PAGE  /login         (title: "Login")
        │             PAGE  /appointments  (title: "Appointments", 🔒 auth)
        │             PAGE  /dashboard     (title: "Dashboard",    🔒 auth)
        │
        ├─► buildRankerPrompt(manifest, appType, auth)
        │     └─► system prompt instructs Claude to:
        │           - score each surface 1..N by smoke criticality
        │           - return JSON array of RankedSurface objects
        │           - reason for each selection
        │
        ├─► Anthropic SDK call (claude-sonnet-4-6):
        │     messages: [{ role: "user", content: rankerPrompt }]
        │     max_tokens: 4096
        │
        ├─► Claude responds with ranked JSON:
        │     [
        │       { type:"page",  route:"/login",        rank:1, reason:"auth gate" },
        │       { type:"api",   method:"POST", path:"/api/appointments", rank:2 ... },
        │       { type:"page",  route:"/appointments",  rank:3 ... },
        │       { type:"page",  route:"/dashboard",     rank:4 ... },
        │       ...
        │     ]
        │
        ├─► matchRankedToOriginals()
        │     └─► maps each ranked surface back to original
        │         ExtractedEndpoint / ExtractedPage objects
        │
        ├─► writes ranker-debug.json → outputDir/llm-debug/ranker-debug.json
        └─► writes ranker-debug.md   → outputDir/llm-debug/ranker-debug.md

  Returns: { endpoints: <filtered>, pages: <filtered>, rankedSurfaces, appType }
```

The ranked blueprint replaces the original — only top-ranked surfaces go forward.

---

### STEP 8 — Chunk Blueprint by Domain

**File:** `smokeforge/src/blueprint/chunker.ts`

```
generate.ts
  └─► chunkBlueprint(rankedBlueprint)
        │
        ├─► groupEndpointsByDomain(endpoints)
        │     └─► extractDomain(ep.path):
        │           /api/appointments/:id  → "appointments"
        │           /api/patients          → "patients"
        │           /login                 → "login" (auth)
        │           /api/auth/logout       → "auth"
        │
        ├─► groupPagesByDomain(pages)
        │     └─► same logic — /appointments → "appointments"
        │
        ├─► merges endpoints + pages that share domain key
        │
        ├─► enforces limits:
        │     MAX_ENDPOINTS_PER_CHUNK = 5
        │     MAX_PAGES_PER_CHUNK     = 10
        │     → splits large domains into chunk-01, chunk-02 ...
        │
        └─► each chunk → BlueprintChunk:
              {
                domain: "appointments",
                outputFileName: "appointments.page.spec.ts",
                hasPages: true,
                endpoints: [...],   // max 5
                pages: [...],       // max 10
                auth: <AuthConfig>,
                testDataHints: { idSeed: "11111111-2222-..." }
              }
```

**For Remix healthcare, produces ~6-8 chunks:**
```
chunk-01  auth          → login.page.spec.ts
chunk-02  appointments  → appointments.page.spec.ts
chunk-03  patients      → patients.page.spec.ts
chunk-04  dashboard     → dashboard.page.spec.ts
chunk-05  settings      → settings.page.spec.ts
...
```

Each chunk is also written to `outputDir/chunks/chunk-01-auth.json` for debugging.

---

### STEP 9 — Generate Tests Per Chunk (LLM calls)

**Files:** `smokeforge/src/generation/client.ts`, `playwright.generator.ts`, `prompts/playwright.system.ts`

This loops over all chunks. For each chunk, **one LLM call** is made.

```
generate.ts
  └─► for each chunk:
        └─► generatePlaywrightWithRetry(chunk, tempDir, allEndpoints)
              │
              ├─► buildPlaywrightUserMessage(chunk, allEndpoints)
              │     ← smokeforge/src/generation/playwright.generator.ts
              │
              │   Builds structured user message:
              │     DOMAIN: appointments
              │     AUTH: session_cookie  login=/login  form-encoded
              │     SEED_EMAIL: admin@healthcare.com
              │     SEED_PASSWORD: Admin123!
              │
              │     API ENDPOINTS:
              │       GET /api/appointments  (🔒 auth)
              │       POST /api/appointments  body=[patientId*, date*, notes]
              │
              │     UI PAGES:
              │       ROUTE: /appointments  TITLE: Appointments
              │       LOCATORS:
              │         getByRole('heading', { name: 'Appointments', level: 1 })
              │         getByRole('button', { name: 'New Appointment' })
              │
              │     NAVIGATION:
              │       /dashboard → "Dashboard"
              │
              ├─► generateWithRetry(PLAYWRIGHT_SYSTEM_PROMPT, userMessage)
              │     ← smokeforge/src/generation/client.ts
              │
              │   Anthropic SDK call:
              │     model: "claude-sonnet-4-6"
              │     system: PLAYWRIGHT_SYSTEM_PROMPT   ← 31-rule system prompt
              │     user:   userMessage                ← chunk-specific context
              │     max_tokens: 8192
              │     temperature: 0
              │
              │   PLAYWRIGHT_SYSTEM_PROMPT content (31 rules):
              │   ← smokeforge/src/generation/prompts/playwright.system.ts
              │     Rule 1:  import { test, expect } from '@playwright/test'
              │     Rule 5:  every test tagged @smoke
              │     Rule 8:  waitForLoadState('networkidle')
              │     Rule 26: login form getByLabel → getByPlaceholder → input[type=password]
              │     Rule 27: button regex /login|sign in|log in|submit/i
              │     Rule 30: NEVER guess CSS class names (.stats-grid etc.)
              │     Rule 31: redirect guard — check page.url() after goto()
              │     ... (31 rules total)
              │
              │   Claude responds with raw TypeScript spec file content
              │
              ├─► stripCodeFences(response)
              │     └─► removes ```typescript ... ``` wrappers if present
              │
              ├─► validatePlaywright(tempFile)
              │     ← smokeforge/src/output/validator.ts
              │     └─► writes to temp .ts file → runs tsc --noEmit
              │         valid → proceed
              │         invalid → retry up to 2 times with error context
              │
              └─► stores { chunk, code } in playwrightSpecs[]
```

**Retry flow (up to 2 retries per chunk):**
```
attempt 1 → validate → FAIL: "Property 'toHaveStatus' does not exist"
  └─► buildRetryMessage(code, errors)
        └─► sends original code + error list back to Claude
        └─► Claude fixes the code
attempt 2 → validate → PASS
  └─► spec added to results
```

---

### STEP 10 — Write Playwright Output

**File:** `smokeforge/src/output/playwright-writer.ts`

```
generate.ts
  └─► writePlaywrightOutput(chunks, playwrightSpecs, outputDir, auth, baseUrl)
        │
        ├─► ensureDir(outputDir/playwright/smoke)
        │
        ├─► for each { chunk, code } in playwrightSpecs:
        │     writeFile(outputDir/playwright/smoke/<outputFileName>, code)
        │       e.g. appointments.page.spec.ts ← LLM-generated TypeScript
        │
        ├─► buildPlaywrightConfig(auth, baseUrl)
        │     └─► generates playwright.config.ts:
        │           testDir: './smoke'
        │           grep: /@smoke/
        │           timeout: 30000
        │           use.baseURL = BASE_URL env var || baseUrl argument
        │           projects: [chromium, api]
        │
        ├─► writes playwright.config.ts
        │
        ├─► buildAuthFixture(auth)
        │     └─► for session_cookie auth:
        │           generates smoke/auth.setup.ts with login flow
        │           using the seed credentials from STEP 5
        │
        ├─► writes smoke/auth.setup.ts  (if auth detected)
        │
        └─► writes playwright/package.json with:
              { "@playwright/test": "^1.40.0" }
```

**Output directory structure:**
```
smokeforge-output/smoke-v2-healthcare/
  blueprint.json
  smokeforge-report.json
  llm-debug/
    ranker-debug.json
    ranker-debug.md
  chunks/
    chunk-01-auth.json
    chunk-02-appointments.json
    ...
  playwright/
    playwright.config.ts
    package.json
    smoke/
      auth.setup.ts
      login.page.spec.ts
      appointments.page.spec.ts
      patients.page.spec.ts
      dashboard.page.spec.ts
      ...
```

---

### STEP 11 — Write Postman Output (API-only repos)

**File:** `smokeforge/src/output/postman-writer.ts`

> For Remix healthcare, the ranker detected UI + API → `doPlaywright=true`, `doPostman=false`.  
> This step is **skipped**. It runs for `enterprise-express-hr` and `enterprise-fastify-inventory`.

```
generate.ts
  └─► writePostmanOutput(postmanCollections, outputDir, auth, baseUrl)
        ├─► merges all chunk collections into one Postman Collection v2.1 JSON
        ├─► injects pre-request script for Bearer auth:
        │     pm.sendRequest({ url: {{BASE_URL}}/login, body: credentials })
        │     pm.environment.set("authToken", response.json().token)
        ├─► writes postman/smoke-tests.postman_collection.json
        └─► writes postman/smoke-env.postman_environment.json
```

---

### STEP 12 — Generate Report

**File:** `smokeforge/src/output/reporter.ts`

```
generate.ts
  └─► generateReport(rankedBlueprint, outputDir)
        └─► for each spec file:
              scans for @smoke tags, TODO comments, BRITTLE markers
              calculates confidence score per file

        └─► writes smokeforge-report.json:
              {
                "summary": {
                  "totalTests": 20,
                  "highConfidence": 18,
                  "lowConfidence": 1,
                  "todos": 1,
                  "coveragePercent": 85
                },
                "files": [
                  { "file": "appointments.page.spec.ts", "confidence": 0.92 },
                  ...
                ]
              }
```

---

### STEP 13 — Print Summary

**File:** `smokeforge/src/cli/commands/generate.ts` → `printSummary()`

```
════════════════════════════════════════
✅ SmokeForge Complete
════════════════════════════════════════
📁 Repository       enterprise-remix-healthcare
🔍 Frameworks       remix, react-spa
🔗 Endpoints found  12
🖥️  Pages found      8
────────────────
📄 Playwright specs  8 files
════════════════════════════════════════
📊 Report           smokeforge-output/smoke-v2-healthcare/smokeforge-report.json
🚀 Run tests        cd smokeforge-output/smoke-v2-healthcare/playwright && npx playwright test --grep @smoke
════════════════════════════════════════
```

---

### STEP 14 — Cleanup

**File:** `smokeforge/src/ingestion/cloner.ts` → `cleanup()`

```
generate.ts  (finally block — always runs even on error)
  └─► cleanup()
        ├─► local path  → no-op (never delete user's local code)
        └─► remote URL  → fs.promises.rm(tempDir, { recursive: true, force: true })
```

---

## File Responsibility Map

| File | Responsibility |
|------|---------------|
| `cli/index.ts` | CLI wiring (commander), .env loading, routes `generate` and `analyze` subcommands |
| `cli/commands/generate.ts` | Orchestrates all 14 steps; retry logic; summary printer |
| `ingestion/cloner.ts` | Local path resolution vs. shallow `git clone`; token injection |
| `ingestion/detector.ts` | Reads `package.json` → identifies frameworks, auth libs, schema libs |
| `ingestion/config-harvester.ts` | Reads `.env`, framework config files → extracts PORT, base paths |
| `analysis/parser.ts` | Walks repo, skips test/build dirs, parses each file into a TSESTree AST |
| `analysis/backend/index.ts` | Registry of all framework extractors; dispatches by `canHandle()` |
| `analysis/backend/remix.extractor.ts` | Walks AST nodes for Remix `loader()`/`action()` exports → endpoints |
| `analysis/backend/express.extractor.ts` | Walks AST for `app.get()`, `router.post()` etc. → endpoints |
| `analysis/backend/fastify.extractor.ts` | Walks AST for `fastify.route({})` and `.get/.post` shorthand |
| `analysis/ui/router-extractor.ts` | Maps file paths in `app/routes/` or `pages/` dirs → URL routes + locators |
| `analysis/ui/react.extractor.ts` | Scans JSX nodes for `role=`, `aria-label=`, `placeholder=` → locators |
| `analysis/auth/auth-detector.ts` | Identifies auth type, login endpoint, credential fields, seed values |
| `blueprint/builder.ts` | Assembles all extracted data into a single `TestBlueprint` JSON |
| `blueprint/chunker.ts` | Groups endpoints + pages by domain; enforces max 5 endpoints, 10 pages per chunk |
| `blueprint/criticality-ranker.ts` | **LLM Call #1** — sends full surface manifest to Claude, gets ranked selection back |
| `generation/client.ts` | Manages Anthropic SDK; `generateWithRetry()` with exponential back-off |
| `generation/prompts/playwright.system.ts` | 31-rule system prompt baked into every LLM call for Playwright |
| `generation/prompts/postman.system.ts` | System prompt for Postman collection generation |
| `generation/playwright.generator.ts` | Builds the per-chunk user message (context + locators + auth details) |
| `generation/postman.generator.ts` | Builds the per-chunk user message for Postman |
| `output/validator.ts` | Runs `tsc --noEmit` on generated spec, parses errors for retry |
| `output/playwright-writer.ts` | Writes spec files, `playwright.config.ts`, auth fixture, `package.json` |
| `output/postman-writer.ts` | Merges chunk collections → single Postman Collection v2.1 JSON |
| `output/reporter.ts` | Scans output files for `@smoke`, TODOs, confidence markers → report JSON |
| `utils/file-utils.ts` | `getAllFiles()`, `ensureDir()`, `writeFile()`, `readJson()` helpers |
| `utils/logger.ts` | `spinner()`, `step()`, `success()`, `warn()`, `banner()` console helpers |

---

## LLM Call Sequence (for a 6-chunk Remix app)

```
LLM Call #1  criticality-ranker.ts     → ranks all surfaces (one call, full manifest)
LLM Call #2  generate chunk-01 auth           → login.page.spec.ts
LLM Call #3  generate chunk-02 appointments   → appointments.page.spec.ts
LLM Call #4  generate chunk-03 patients       → patients.page.spec.ts
LLM Call #5  generate chunk-04 dashboard      → dashboard.page.spec.ts
LLM Call #6  generate chunk-05 settings       → settings.page.spec.ts
LLM Call #7  generate chunk-06 schedule       → schedule.page.spec.ts
                                                                       ▲
                              each fails validation → up to 2 retries ─┘
```

Total LLM calls: **1 (ranker) + N (chunks) + up to 2N (retries)**

---

## Data Flow Diagram

```
package.json ──► detector.ts ──────────────────────────────────────────┐
                                                                        │
                                                                        ▼
*.ts/*.tsx ──► parser.ts ──► [AST files]                         DetectionResult
                               │                                        │
                  ┌────────────┼───────────────┐                        │
                  ▼            ▼               ▼                        │
          backend/        ui/router-      auth/auth-               passed to all
          remix.extractor extractor.ts    detector.ts              extractors
                  │            │               │
                  ▼            ▼               ▼
           ExtractedEndpoint[] ExtractedPage[] AuthConfig
                  │            │               │
                  └────────────┴───────┬───────┘
                                       │
                                       ▼
                              blueprint/builder.ts
                                       │
                                       ▼
                                 TestBlueprint
                                       │
                                       ▼
                          blueprint/criticality-ranker.ts
                              (LLM Call #1 — Claude)
                                       │
                                       ▼
                              ranked TestBlueprint
                                       │
                                       ▼
                            blueprint/chunker.ts
                                       │
                           ┌───────────┼───────────┐
                           ▼           ▼           ▼
                       chunk-01    chunk-02    chunk-03 ...
                           │           │           │
                           └─────┬─────┘           │
                                 ▼                 ▼
                     generation/client.ts   (LLM Call per chunk)
                     + playwright.system.ts (31-rule system prompt)
                     + playwright.generator.ts (user message builder)
                                 │
                                 ▼
                     raw TypeScript spec string
                                 │
                                 ▼
                     output/validator.ts (tsc --noEmit)
                        PASS ────┼──── FAIL → retry (max 2)
                                 │
                                 ▼
                     output/playwright-writer.ts
                                 │
                                 ▼
              smokeforge-output/<app>/playwright/smoke/*.spec.ts
```

---

## Key Design Decisions

| Decision | Why |
|----------|-----|
| **Shallow clone `--depth 1`** | Only needs source code, not git history. Fast even on large repos |
| **AST parsing, not regex** | Handles TypeScript, JSX, async/await patterns reliably. Regex would break on nested code |
| **Framework extractor registry** | Adding a new framework = add one file implementing `IFrameworkExtractor`. No changes to orchestrator |
| **Criticality ranker as a separate LLM call** | Separates "what to test" (business logic reasoning) from "how to test" (code generation). Better outputs, cheaper retries |
| **Chunk by domain, max 5 endpoints** | Keeps each LLM prompt token-efficient. At ~1800 chars/endpoint, 5 items ≈ 2300 tokens, safely under 8192 limit |
| **`tsc --noEmit` validation + retry** | Catches type errors, missing imports, wrong Playwright API calls before writing final files |
| **31-rule system prompt** | Prevents recurring failures (CSS class guessing, missing redirect guards) at the prompt level — fixes apply to all future generations automatically |
| **`cleanup()` in `finally` block** | Guarantees temp cloned repos are always deleted, even when steps 4-13 throw errors |
