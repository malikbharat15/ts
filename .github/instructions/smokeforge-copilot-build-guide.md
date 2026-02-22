# SmokeForge — Complete Copilot Build Guide
## Every step, every prompt, every section reference in order

> Keep this file open alongside Copilot the entire time.
> After EVERY step: run `tsc --noEmit` before moving to the next step.
> Never skip a step. Never combine two steps into one message.

---

## PRE-FLIGHT (Already Done)
- [x] Initial context prompt sent
- [x] Section 1 scaffold created
- [x] tsconfig.json created
- [x] `pnpm install` ran clean

---

## STEP 1 — AST Utilities
**Copy from document:** Section 3 — `src/utils/ast-utils.ts` block only (stop before parser.ts)

**Prompt:**
```
Implement the AST utility helpers now.

#file: section-03-parser.md

Create ONLY this file:
  src/utils/ast-utils.ts

Implement every function in the file exactly as specified:
- walk()
- extractStringValue()
- getDecorators()
- isImportedFrom()
- collectImports()
- extractRequirePath()

Do not create parser.ts yet. Only ast-utils.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 2 — Central Parser
**Copy from document:** Section 3 — `src/analysis/parser.ts` block

**Prompt:**
```
Implement the central AST parser now.

#file: section-03-parser.md

Create ONLY this file:
  src/analysis/parser.ts

It must:
- Import from @typescript-eslint/typescript-estree
- Implement parseFile() exactly as specified
- Export ANALYZABLE_EXTENSIONS, SCRIPT_BLOCK_EXTENSIONS, SKIP_DIRS constants
- Handle parse errors with a warning log, never throw

Import ast-utils.ts where needed.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 3 — Logger Utility
**Copy from document:** Nothing — this is a small utility Opus should create from scratch.

**Prompt:**
```
Create a simple logger utility.

Create this file:
  src/utils/logger.ts

It must export:
- log(message: string): void         — standard output with chalk green prefix [smokeforge]
- warn(message: string): void        — chalk yellow prefix [warn]
- error(message: string): void       — chalk red prefix [error]
- debug(message: string): void       — chalk gray prefix [debug], only logs if DEBUG=true env var
- spinner(message: string)           — returns an ora spinner instance, already started

Use chalk and ora packages (already in package.json).
No other dependencies.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 4 — File Utilities
**Copy from document:** Nothing — small utility Opus creates from scratch.

**Prompt:**
```
Create a file utilities helper.

Create this file:
  src/utils/file-utils.ts

It must export:
- getAllFiles(dir: string, extensions: string[]): string[]
  Recursively finds all files with given extensions.
  Skips any directory whose name is in SKIP_DIRS (import from parser.ts).
  Returns absolute file paths.

- resolveImportPath(importPath: string, fromFile: string): string | null
  Given a relative import like './routes/users' and the file it appears in,
  resolves to an absolute file path.
  Tries extensions in order: .ts, .tsx, .js, .jsx, /index.ts, /index.js, /index.tsx, /index.jsx
  Returns null if no file found.

- readJson<T>(filePath: string): T | null
  Reads and parses a JSON file. Returns null on any error.

- ensureDir(dirPath: string): void
  Creates directory and all parents if they don't exist.

- writeFile(filePath: string, content: string): void
  Writes a file, creating parent dirs automatically.

Use only Node.js built-ins (fs, path) and the SKIP_DIRS import.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 5 — Framework Detector
**Copy from document:** Section 2 — the entire section

**Prompt:**
```
Implement the framework detector now.

#file: section-02-detection.md

Create this file:
  src/ingestion/detector.ts

It must implement:
1. All TypeScript types: BackendFramework, FrontendFramework, RouterLibrary,
   SchemaLibrary, AuthLibrary, DetectionResult, PackageDetection
2. All detection signal maps: BACKEND_SIGNALS, FRONTEND_SIGNALS,
   SCHEMA_SIGNALS, AUTH_SIGNALS — with every entry in the spec
3. Monorepo detection logic in this order:
   pnpm-workspace.yaml → turbo.json → nx.json → lerna.json → package.json workspaces field
4. detect(repoPath: string): Promise<DetectionResult> — the main export

Import readJson from file-utils.ts.
No other external dependencies.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 6 — Config Harvester
**Copy from document:** Section 1 description of config-harvester.ts

**Prompt:**
```
Create the config harvester.

Create this file:
  src/ingestion/config-harvester.ts

It must export:
- harvestConfigs(repoPath: string): Promise<HarvestedConfigs>

HarvestedConfigs interface:
  {
    dotEnvExample: Record<string, string> | null,  // parsed .env.example key=value pairs
    openApiSpec: unknown | null,                    // raw parsed JSON/YAML if found
    nextConfig: unknown | null,                     // next.config.js/ts contents as string
    viteConfig: unknown | null,                     // vite.config.ts contents as string
    tsconfigPaths: Record<string, string[]>,        // compilerOptions.paths from tsconfig.json
    packageJsons: Record<string, unknown>[],        // all package.json files found
  }

Rules:
- For .env.example: parse KEY=VALUE lines, ignore comments (#), ignore blank lines
- For openapi: look for openapi.yaml, openapi.json, swagger.yaml, swagger.json
  in root and /docs directory
- For tsconfigPaths: read ALL tsconfig*.json files, merge their paths entries
- Never throw — return null for any config that cannot be found or parsed
- Use readJson and getAllFiles from file-utils.ts
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 7 — Repo Cloner
**Copy from document:** Section 1 description of cloner.ts

**Prompt:**
```
Create the repo cloner.

Create this file:
  src/ingestion/cloner.ts

It must export:
- cloneRepo(repoUrl: string, targetDir?: string): Promise<CloneResult>

CloneResult interface:
  {
    repoPath: string,       // absolute path to cloned repo
    repoName: string,       // extracted from URL: "acme/myapp"
    cleanup: () => Promise<void>  // deletes the cloned directory
  }

Rules:
- Use simple-git to clone with --depth 1 (shallow clone)
- If targetDir not provided: clone to os.tmpdir()/smokeforge-<timestamp>-<random>
- Extract repoName from URL: handle both
    https://github.com/acme/myapp
    https://github.com/acme/myapp.git
- Show progress via logger spinner
- On clone error: clean up partial clone, rethrow with clear message
- cleanup() must rm -rf the cloned directory safely

Use logger from utils/logger.ts.
Use os and path from Node.js built-ins.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 8 — Blueprint Types
**Copy from document:** Section 8.1 — the complete types.ts block

**Prompt:**
```
Implement the complete blueprint type definitions now.

#file: section-08-blueprint.md

Create ONLY this file:
  src/blueprint/types.ts

This file contains ONLY TypeScript interfaces and types — no logic.
Implement every interface in the spec exactly:
- TestBlueprint
- AuthConfig
- ExtractedPage
- ExtractedLocator
- FormFlow
- FormStep
- NavigationLink
- TestDataHints

Also re-export these types from the backend extractor interface
(they will be defined in the extractor index but are needed here):
- ExtractedEndpoint
- PathParam
- QueryParam
- RequestBodySchema
- BodyField
- ExtractorFlag
- AuthType (type alias: "bearer_jwt" | "api_key_header" | "api_key_query" | "basic_auth" | "session_cookie" | "next_auth" | "firebase" | "supabase" | "clerk" | "oauth_bearer")
- ResponseSchema (interface: { statusCode: number; schema: unknown | null })

No imports from other src files yet — this file is the foundation.
No logic. Types only.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 9 — Extractor Interface & Registry
**Copy from document:** Section 4.1 — IFrameworkExtractor interface block

**Prompt:**
```
Implement the extractor interface and registry.

#file: section-04-1-extractor-interface.md

Create this file:
  src/analysis/backend/index.ts

It must:
1. Re-export the IFrameworkExtractor interface exactly as specified
2. Export a function: getExtractors(detection: DetectionResult): IFrameworkExtractor[]
   - Returns the correct extractor instances based on detected frameworks
   - For now, return an empty array — we will register extractors as we build them
3. Export a function: runExtractors(files: ParsedFile[], detection: DetectionResult): Promise<ExtractedEndpoint[]>
   - Calls getExtractors(), runs each concurrently with Promise.all
   - Merges results, deduplicates by method+path
   - Returns merged ExtractedEndpoint[]

Import types from blueprint/types.ts and ingestion/detector.ts.
Import ParsedFile from analysis/parser.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 10 — Schema Extractor: Zod
**Copy from document:** Section 5.1 — complete Zod extractor spec

**Prompt:**
```
Implement the Zod schema extractor.

#file: section-05-1-zod.md

Create this file:
  src/analysis/schemas/zod.extractor.ts

It must export:
- extractZodSchemas(files: ParsedFile[]): Map<string, RequestBodySchema>
  Scans all files for Zod schema variable declarations.
  Returns a map of variableName → RequestBodySchema.

- resolveZodSchema(schemaName: string, schemaRegistry: Map<string, RequestBodySchema>): RequestBodySchema | null
  Looks up a schema by name, handling .partial(), .pick(), .omit(), .extend() chains.

- extractInlineZodSchema(node: TSESTree.CallExpression): RequestBodySchema | null
  Extracts schema from an inline z.object({...}) call expression node.

Implement ALL type mappings from the spec:
z.string(), z.number(), z.boolean(), z.date(), z.array(), z.enum(),
z.literal(), z.object(), z.union(), z.record()

Implement ALL validator mappings:
.optional(), .default(), .email(), .url(), .uuid(), .min(), .max(),
.regex(), .int(), .positive(), .nonempty()

Implement ALL chained schema transformations:
.partial(), .pick(), .omit(), .extend()

Import ParsedFile from analysis/parser.ts.
Import walk, extractStringValue from utils/ast-utils.ts.
Import RequestBodySchema, BodyField from blueprint/types.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 11 — Schema Extractor: TypeScript Types (Fallback)
**Copy from document:** Section 5.4 — TypeScript types extractor spec

**Prompt:**
```
Implement the TypeScript types fallback schema extractor.

#file: section-05-4-typescript-types.md

Create this file:
  src/analysis/schemas/typescript-types.extractor.ts

It must export:
- extractTypeScriptTypes(files: ParsedFile[]): Map<string, RequestBodySchema>
  Finds all interface and type alias declarations.
  Returns map of typeName → RequestBodySchema.
  Confidence for all fields extracted this way: 0.70

- extractDestructuredBodyFields(functionNode: TSESTree.Node): BodyField[]
  Given a function body, finds const { a, b } = req.body or const { a, b } = await request.json()
  Returns extracted fields with type: "unknown" and confidence: 0.40

Implement all type mappings from the spec.
Mark optional properties (? suffix) as required: false.
Import ParsedFile, walk, extractStringValue from correct paths.
Import RequestBodySchema, BodyField from blueprint/types.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 12 — Express Extractor
**Copy from document:** Section 4.2 — complete Express extractor spec

**Prompt:**
```
Implement the Express route extractor — this is the most important extractor.

#file: section-04-2-express.md

Create this file:
  src/analysis/backend/express.extractor.ts

It must implement IFrameworkExtractor with:
  framework = "express"
  canHandle(): true if detection includes "express"
  extract(): runs the full 5-phase algorithm from the spec

Implement all 5 phases exactly:
  Phase A: Build Router Graph (cross-file prefix resolution)
  Phase B: Extract Leaf Routes
  Phase C: Resolve Full Paths
  Phase D: Extract Middleware Signals (auth, roles, file upload)
  Phase E: Resolve Params (path params with types from Zod if available)

Handle ALL patterns from the spec:
  - app.get/post/put/patch/delete/all
  - router.get/post/put/patch/delete
  - router.route('/path').get().post()
  - app.use('/prefix', router) — cross file
  - require() resolution — follow to source file
  - Conditional routes (if blocks) — flag CONDITIONAL_ROUTE
  - Dynamic path variables — flag DYNAMIC_PATH
  - Auth middleware detection
  - Role middleware detection

Import and use:
  - IFrameworkExtractor from ./index
  - extractZodSchemas from ../schemas/zod.extractor
  - extractTypeScriptTypes from ../schemas/typescript-types.extractor
  - walk, extractStringValue, collectImports, extractRequirePath from utils/ast-utils
  - resolveImportPath from utils/file-utils
  - parseFile, ParsedFile from analysis/parser
  - All types from blueprint/types

Register this extractor in src/analysis/backend/index.ts getExtractors() function.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 13 — Auth Detector
**Copy from document:** Section 6 — complete auth detector spec

**Prompt:**
```
Implement the authentication pattern detector.

#file: section-06-auth.md

Create this file:
  src/analysis/auth/auth-detector.ts

It must export:
- detectAuth(files: ParsedFile[], endpoints: ExtractedEndpoint[]): Promise<AuthConfig | null>
  Runs all auth detection heuristics from the spec.
  Enriches each endpoint's authRequired and authType fields in place.
  Returns the global AuthConfig if a login endpoint is found, null otherwise.

Implement detection for ALL auth libraries from the spec:
  - jsonwebtoken / jose
  - passport (JwtStrategy, LocalStrategy)
  - next-auth / Auth.js
  - express-jwt / koa-jwt
  - Manual header extraction patterns

Implement login endpoint detection heuristics:
  - Path matching: /auth/login, /login, /api/auth/login etc.
  - Body fields: email + password
  - Response: returns accessToken, token, jwt
  - Method: POST

Implement token response path detection:
  - "accessToken" → tokenResponsePath: "accessToken"
  - "data.token" → tokenResponsePath: "data.token"
  - "token" → tokenResponsePath: "token"

Import all required types from blueprint/types.ts and analysis/parser.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 14 — Blueprint Builder
**Copy from document:** Section 8.2 — blueprint builder logic

**Prompt:**
```
Implement the blueprint builder.

#file: section-08-blueprint.md

Create this file:
  src/blueprint/builder.ts

It must export:
- buildBlueprint(
    repoUrl: string,
    detection: DetectionResult,
    endpoints: ExtractedEndpoint[],
    pages: ExtractedPage[],
    auth: AuthConfig | null,
    configs: HarvestedConfigs
  ): TestBlueprint

Implement all assembly logic from the spec:
1. Merge and deduplicate endpoints by method + normalized path
2. Link endpoints to pages by:
   a. fetch/axios calls found in page component files
   b. URL convention matching: /users → GET /api/users
   c. Form flow linked endpoints
3. Generate normalizedRoute for each page (replace :param with example values)
4. Generate test data values per field type (exact mappings from spec)
5. Calculate confidence score per endpoint and page
6. Populate all TestBlueprint fields

Import from blueprint/types.ts, ingestion/detector.ts, ingestion/config-harvester.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 15 — Blueprint Chunker
**Copy from document:** Section 8.2 — chunking strategy block

**Prompt:**
```
Implement the blueprint chunker.

Create this file:
  src/blueprint/chunker.ts

It must export:

BlueprintChunk interface:
  {
    domain: string,              // "auth", "users", "products"
    hasPages: boolean,
    endpoints: ExtractedEndpoint[],
    pages: ExtractedPage[],
    auth: AuthConfig | null,     // always included in every chunk
    testDataHints: TestDataHints,
    outputFileName: string       // "auth.api.spec.ts" or "users.page.spec.ts"
  }

- chunkBlueprint(blueprint: TestBlueprint): BlueprintChunk[]

Rules from spec:
- Max 15 endpoints per chunk
- Max 10 pages per chunk
- Group by domain: extract domain from 3rd path segment /api/v1/{domain}/...
- If domain has >15 endpoints, split alphabetically into domain-1, domain-2
- Every chunk gets full AuthConfig and TestDataHints
- Name output files: {domain}.api.spec.ts or {domain}.page.spec.ts

Import from blueprint/types.ts only.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 16 — Anthropic Client
**Copy from document:** Section 9.1 — complete client.ts block

**Prompt:**
```
Implement the Anthropic API client wrapper.

#file: section-09-generation.md

Create this file:
  src/generation/client.ts

It must export:
- generateWithRetry(
    systemPrompt: string,
    userMessage: string,
    maxRetries?: number
  ): Promise<string>

Rules from spec:
- Model: ALWAYS "claude-opus-4-6" — hardcoded, not configurable
- max_tokens: 4096
- temperature: 0.1
- Exponential backoff on retry: 1000ms, 2000ms
- Add cache_control: { type: "ephemeral" } to system prompt message
  (this caches the system prompt across chunk calls — cost saving)
- On all retries exhausted: throw the last error

Use @anthropic-ai/sdk.
Read ANTHROPIC_API_KEY from process.env.
Throw clear error if ANTHROPIC_API_KEY is missing before making any call.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 17 — Generation Prompts
**Copy from document:** Section 9.2 (Playwright prompt) and Section 9.3 (Postman prompt) and Section 9.4 (user message builder)

**Prompt:**
```
Implement the generation prompts.

#file: section-09-generation.md

Create these files:

1. src/generation/prompts/playwright.system.ts
   Export: PLAYWRIGHT_SYSTEM_PROMPT string
   Exact content from spec — do not shorten or summarize any rule.

2. src/generation/prompts/postman.system.ts
   Export: POSTMAN_SYSTEM_PROMPT string
   Exact content from spec — do not shorten or summarize any rule.

3. src/generation/prompts/retry.ts
   Export: buildRetryMessage(originalOutput: string, validationErrors: string[]): string
   Exact implementation from spec.

4. src/generation/playwright.generator.ts
   Export: buildPlaywrightUserMessage(chunk: BlueprintChunk): string
   Exact implementation from spec.

5. src/generation/postman.generator.ts
   Export: buildPostmanUserMessage(chunk: BlueprintChunk): string
   Same structure as buildPlaywrightUserMessage but for Postman context.

Import BlueprintChunk from blueprint/chunker.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 18 — Output Validator
**Copy from document:** Section 12.1 — output validation spec

**Prompt:**
```
Implement the output validator.

#file: section-12-validation.md

Create this file:
  src/output/validator.ts

It must export:

- validatePlaywright(filePath: string): Promise<ValidationResult>
  Runs these checks in order:
  1. Every test() block has at least one expect() — regex check
  2. No hardcoded URLs (regex: /https?:\/\/(?!.*BASE_URL)/)
  3. TypeScript compilation check using child_process to run tsc --noEmit
  Returns: { valid: boolean, errors: string[] }

- validatePostman(jsonString: string): ValidationResult
  1. JSON.parse check
  2. Required fields: info.name, info.schema
  3. Schema value equals Postman v2.1 URL
  4. At least one item exists
  5. Collection variables include BASE_URL and AUTH_TOKEN
  Returns: { valid: boolean, errors: string[] }

ValidationResult interface:
  { valid: boolean, errors: string[] }

Use child_process (exec) for tsc check.
Use ajv for JSON schema validation.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 19 — Playwright Writer
**Copy from document:** Section 10.1 — complete Playwright writer spec

**Prompt:**
```
Implement the Playwright output writer.

#file: section-10-output.md

Create this file:
  src/output/playwright-writer.ts

It must export:
- writePlaywrightOutput(
    chunks: BlueprintChunk[],
    generatedSpecs: Array<{ chunk: BlueprintChunk, code: string }>,
    outputDir: string,
    auth: AuthConfig | null
  ): Promise<void>

It must write these files:
1. {outputDir}/playwright/smoke/{domain}.api.spec.ts — one per chunk
2. {outputDir}/playwright/smoke/{domain}.page.spec.ts — one per chunk with pages
3. {outputDir}/playwright/fixtures/auth.fixture.ts — generated from AuthConfig
4. {outputDir}/playwright/playwright.config.ts — exact content from spec
5. {outputDir}/.env.example — BASE_URL, SMOKE_TEST_EMAIL, SMOKE_TEST_PASSWORD

Generate auth.fixture.ts and playwright.config.ts content exactly as shown in spec.
Use writeFile and ensureDir from utils/file-utils.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 20 — Postman Writer
**Copy from document:** Section 10.2 — complete Postman writer spec

**Prompt:**
```
Implement the Postman output writer.

#file: section-10-output.md

Create this file:
  src/output/postman-writer.ts

It must export:
- writePostmanOutput(
    generatedCollections: Array<{ chunk: BlueprintChunk, json: string }>,
    outputDir: string,
    auth: AuthConfig | null
  ): Promise<void>

It must:
1. Merge all chunk collections into one Postman collection JSON
2. Ensure login request is FIRST in Auth folder
3. Ensure collection variables: BASE_URL, AUTH_TOKEN, SMOKE_TEST_EMAIL, SMOKE_TEST_PASSWORD
4. Validate merged JSON before writing
5. Write: {outputDir}/postman/smoke-tests.postman_collection.json
6. Write: {outputDir}/postman/smoke-env.postman_environment.json
   (exact content from spec)

Use validatePostman from output/validator.ts.
Use writeFile and ensureDir from utils/file-utils.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 21 — Confidence Reporter
**Copy from document:** Section 12.2 — complete confidence scoring and reporter spec

**Prompt:**
```
Implement the confidence scorer and reporter.

#file: section-12-validation.md

Create this file:
  src/output/reporter.ts

It must export:

- scoreEndpoint(endpoint: ExtractedEndpoint): number
  Calculates confidence 0.0-1.0 using exact deduction table from spec.

- scoreLocator(locator: ExtractedLocator): number
  Calculates confidence 0.0-1.0 using exact table from spec.

- generateReport(
    blueprint: TestBlueprint,
    outputDir: string
  ): Promise<SmokeForgeReport>

SmokeForgeReport interface:
  {
    summary: {
      totalEndpoints: number,
      totalPages: number,
      highConfidence: number,    // >= 0.80
      mediumConfidence: number,  // 0.60-0.79
      lowConfidence: number,     // 0.40-0.59
      todos: number              // < 0.40
    },
    items: ReportItem[],
    locatorRecommendations: LocatorRecommendation[]
  }

ReportItem and LocatorRecommendation interfaces — define from spec content.

Write report to: {outputDir}/smokeforge-report.json
Use writeFile from utils/file-utils.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 22 — Generate Command (Core Orchestration)
**Copy from document:** Section 11 — generate command flow

**Prompt:**
```
Implement the generate command — this is the main orchestration logic.

#file: section-11-cli.md

Create this file:
  src/cli/commands/generate.ts

It must export:
- generateCommand(repoUrl: string, options: GenerateOptions): Promise<void>

GenerateOptions interface:
  {
    output: string,
    format: string,        // "playwright,postman"
    baseUrl: string,
    framework?: string,
    onlyApi?: boolean,
    onlyUi?: boolean,
    domain?: string,
    verbose?: boolean,
    install?: boolean,
  }

Implement the exact 11-step flow from spec:
  1. Validate ANTHROPIC_API_KEY exists
  2. Clone repo (show spinner)
  3. Detect frameworks (log results)
  4. Run all extractors (log counts)
  5. Run auth detector
  6. Build blueprint (log endpoint/page counts)
  7. Chunk blueprint (log chunk count)
  8. For each chunk — sequential (not parallel — respect API rate limits):
     a. Generate Playwright if not --only-ui
     b. Validate → retry up to 2x if invalid
     c. Generate Postman if not --only-api
     d. Validate → retry up to 2x if invalid
  9. Write Playwright output
  10. Write Postman output
  11. Generate report
  12. Print summary (exact format from spec)
  13. Cleanup cloned repo

Use generateWithRetry from generation/client.ts.
Use buildPlaywrightUserMessage, PLAYWRIGHT_SYSTEM_PROMPT.
Use buildPostmanUserMessage, POSTMAN_SYSTEM_PROMPT.
Use buildRetryMessage for retries.
Use logger spinner for progress.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 23 — Analyze Command
**Copy from document:** Section 11 — analyze command description

**Prompt:**
```
Implement the analyze command.

Create this file:
  src/cli/commands/analyze.ts

It must export:
- analyzeCommand(repoUrl: string, options: { output: string }): Promise<void>

It runs steps 1-6 of generateCommand (clone through build blueprint)
but STOPS before generation.

Writes the TestBlueprint JSON to the output file specified.
Prints a summary of what was found:
  - Frameworks detected
  - Endpoints found (count)
  - Pages found (count)
  - Auth config found: yes/no
  - Blueprint written to: <path>

This command is useful for debugging extraction before running generation.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 24 — CLI Entry Point
**Copy from document:** Section 11 — CLI commands block

**Prompt:**
```
Implement the CLI entry point.

#file: section-11-cli.md

Create this file:
  src/cli/index.ts

First line must be: #!/usr/bin/env node

Use commander to register:
1. generate <repo-url> command with all options from spec
2. analyze <repo-url> command with options from spec

Import generateCommand and analyzeCommand from their files.

Also add to package.json (update it):
  "bin": { "smokeforge": "./dist/cli/index.js" }

And add build script:
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/cli/index.ts",
    "start": "node dist/cli/index.js"
  }
```

**After:** Run `tsc --noEmit` — should be zero errors.
**Then:** Run `pnpm build` — should compile to dist/ with zero errors.

---

## STEP 25 — NestJS Extractor
**Copy from document:** Section 4.4 — complete NestJS extractor spec

**Prompt:**
```
Implement the NestJS route extractor.

#file: section-04-4-nestjs.md

Create this file:
  src/analysis/backend/nestjs.extractor.ts

Implement IFrameworkExtractor with framework = "nestjs"

Implement all 5 phases from the spec:
  Phase A: Find all @Controller() decorated classes
  Phase B: Extract HTTP method decorators per controller method
  Phase C: Resolve guards (@UseGuards, @Public, @Roles)
  Phase D: Extract parameter decorators (@Body, @Query, @Param, @Headers)
  Phase E: Resolve version and global prefix from main.ts bootstrap()

Handle ALL patterns:
  - @Controller('path') and @Controller({ path, version })
  - All HTTP decorators: @Get, @Post, @Put, @Patch, @Delete, @Head, @Options, @All
  - DTO extraction via class-validator decorators
  - Nested DTOs via @ValidateNested + @Type
  - @ApiProperty examples
  - Module graph traversal (AppModule → imported modules → controllers)
  - Global prefix from app.setGlobalPrefix()
  - Versioning from app.enableVersioning()

Register this extractor in src/analysis/backend/index.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 26 — Next.js Pages Router Extractor
**Copy from document:** Section 4.5 (Pages Router part)

**Prompt:**
```
Implement the Next.js Pages Router extractor.

#file: section-04-5-nextjs-pages.md

Create this file:
  src/analysis/backend/nextjs-pages.extractor.ts

Implement IFrameworkExtractor with framework = "nextjs" (pages router variant)

canHandle(): true if "nextjs" detected AND /pages/api directory exists in repo

Handle ALL file patterns from spec:
  /pages/api/users.ts → /api/users
  /pages/api/users/[id].ts → /api/users/:id
  /pages/api/[...slug].ts → /api/* (catch-all)

Handle ALL method detection patterns:
  Pattern 1: switch(req.method) { case 'GET': ... }
  Pattern 2: if (req.method === 'GET') { ... }
  Pattern 3: const handlers = { GET: fn, POST: fn }
  Pattern 4: no method check → method: "ALL"
  Pattern 5: next-connect library

Extract query/body fields from req.query and req.body destructuring.
Detect auth via wrapper functions and getServerSession calls.
Parse middleware.ts matcher for route-level auth.

Register in src/analysis/backend/index.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 27 — Next.js App Router Extractor
**Copy from document:** Section 4.5 (App Router part) and Section 4.6

**Prompt:**
```
Implement the Next.js App Router extractor.

#file: section-04-6-nextjs-app.md

Create this file:
  src/analysis/backend/nextjs-app.extractor.ts

Implement IFrameworkExtractor with framework = "nextjs" (app router variant)

canHandle(): true if "nextjs" detected AND /app directory with route.ts files exists

Handle ALL file patterns:
  /app/api/users/route.ts → /api/users
  /app/api/users/[userId]/route.ts → /api/users/:userId
  /app/(group)/users/route.ts → /users (strip route groups)
  /app/api/[...slug]/route.ts → /api/*

Method detection: named exports GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS

Extract:
  - Path params from TypeScript type: { params: { userId: string } }
  - Query params from searchParams usage
  - Request body from request.json() and Zod schema references
  - Auth from getServerSession, getToken, cookies()
  - Auth from middleware.ts matcher config

Register in src/analysis/backend/index.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 28 — Fastify Extractor
**Copy from document:** Section 4.3 — complete Fastify spec

**Prompt:**
```
Implement the Fastify route extractor.

#file: section-04-3-fastify.md

Create this file:
  src/analysis/backend/fastify.extractor.ts

Implement IFrameworkExtractor with framework = "fastify"

Handle ALL patterns from spec:
  - fastify.get/post/put/patch/delete/route()
  - Plugin system with fastify.register(plugin, { prefix })
  - Inline JSON Schema in route options
  - TypeBox schema via @fastify/type-provider-typebox
  - Zod schema via @fastify/zod
  - Auth via addHook('preHandler') — global and scoped

Implement Plugin Tree building:
  - Find all fastify.register() calls
  - Resolve prefix from options
  - Follow plugin function definition (same file or imported)
  - Build prefix stack per plugin scope

Register in src/analysis/backend/index.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 29 — tRPC Extractor
**Copy from document:** Section 4.8 — complete tRPC spec

**Prompt:**
```
Implement the tRPC route extractor.

#file: section-04-8-trpc.md

Create this file:
  src/analysis/backend/trpc.extractor.ts

Implement IFrameworkExtractor with framework = "trpc"

Handle tRPC v10+ procedure builder pattern:
  - router({ ... }) nesting
  - publicProcedure.query() → GET
  - publicProcedure.mutation() → POST
  - .input(zodSchema) extraction
  - Procedure middleware chain for auth detection

Adapter detection (find base path):
  - Next.js pages: /pages/api/trpc/[trpc].ts
  - Next.js app: /app/api/trpc/[trpc]/route.ts
  - Express: createExpressMiddleware({ router, prefix })
  - fetchRequestHandler endpoint option

Map procedure paths to HTTP:
  users.getAll → GET /trpc/users.getAll
  users.create → POST /trpc/users.create

Register in src/analysis/backend/index.ts.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 30 — Remaining Backend Extractors
**Copy from document:** Sections 4.7 (Remix), 4.9 (Koa), 4.10 (Hapi), 4.11 (Hono), 4.12 (SvelteKit), 4.13 (Elysia) — one at a time

**Prompt template (repeat for each):**
```
Implement the {Framework} route extractor.

#file: section-04-{n}-{framework}.md

Create this file:
  src/analysis/backend/{framework}.extractor.ts

Implement all patterns from the spec exactly.
Register in src/analysis/backend/index.ts.
```

**Order:** Remix → Koa → Hapi → Hono → SvelteKit → Elysia
**After each:** Run `tsc --noEmit` before next framework.

---

## STEP 31 — Schema Extractors: Joi and Class-Validator
**Copy from document:** Section 5.2 (Joi) and Section 5.3 (class-validator)

**Prompt:**
```
Implement the remaining schema extractors.

#file: section-05-2-joi.md
#file: section-05-3-class-validator.md

Create these files one at a time:
  src/analysis/schemas/joi.extractor.ts
  src/analysis/schemas/class-validator.extractor.ts

Each must export the same interface as zod.extractor.ts:
  extractSchemas(files: ParsedFile[]): Map<string, RequestBodySchema>

Implement all type and validator mappings from the spec for each library.
```

**After each:** Run `tsc --noEmit`.

---

## STEP 32 — React UI Extractor
**Copy from document:** Section 7.1 — complete React extractor spec

**Prompt:**
```
Implement the React UI locator extractor.

#file: section-07-1-react.md

Create this file:
  src/analysis/ui/react.extractor.ts

It must export:
- extractReactLocators(files: ParsedFile[]): ExtractedPage[]

Implement ALL locator strategies in priority order from spec:
  Priority 1: data-testid, data-cy, data-e2e, data-pw, data-automation
  Priority 2: aria-label, aria-labelledby
  Priority 3: HTML semantic roles (full element→role mapping table from spec)
  Priority 4: htmlFor label associations, placeholder
  Priority 5: CSS selectors (flag as BRITTLE)

Implement form flow detection:
  - Find <form> elements
  - Extract ordered field + submit sequence
  - Link to backend endpoint by form action URL

Implement dynamic/conditional rendering detection:
  - Ternary expressions → flag CONDITIONAL_ELEMENT
  - .map() rendering → flag DYNAMIC_LIST, generate regex locator

Generate correct playwrightCode string for each locator.
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 33 — Router Extractor (Page Inventory)
**Copy from document:** Section 7.2 — complete router extractor spec

**Prompt:**
```
Implement the router/page inventory extractor.

#file: section-07-2-router.md

Create this file:
  src/analysis/ui/router-extractor.ts

It must export:
- extractPages(files: ParsedFile[], detection: DetectionResult, repoPath: string): ExtractedPage[]

Handle ALL routing solutions from the spec:
  - React Router v5 (<Route exact path=...>)
  - React Router v6 (<Routes><Route path=...>)
  - TanStack Router (createRoute)
  - Next.js Pages Router (derive from /pages directory)
  - Next.js App Router (derive from /app/**/page.tsx)
  - Vue Router (parse router/index.ts routes array)
  - Angular (parse app-routing.module.ts, follow lazy-loaded modules)

For each page extract:
  - route, normalizedRoute, title, filePath
  - authRequired (from route guards/meta)
  - roles, isDynamic, routeParams
  - linkedEndpoints (convention-based matching)
```

**After:** Run `tsc --noEmit` — should be zero errors.

---

## STEP 34 — Vue and Angular UI Extractors
**Copy from document:** Section 7.3 (Vue) and Section 7.4 (Angular)

**Prompt:**
```
Implement the Vue and Angular UI extractors.

#file: section-07-3-vue.md
#file: section-07-4-angular.md

Create these files:
  src/analysis/ui/vue.extractor.ts
  src/analysis/ui/angular.extractor.ts

Vue extractor:
  - Extract <script> block from .vue files
  - Parse template block for locators
  - Handle both <script setup> and Options API
  - Handle v-if (CONDITIONAL) and v-for (DYNAMIC_LIST)

Angular extractor:
  - Find @Component decorators, follow templateUrl to .html files
  - Extract locators from HTML templates
  - Handle *ngIf (CONDITIONAL) and *ngFor (DYNAMIC_LIST)
  - Extract reactive form fields from fb.group() definitions
  - Generate [formControlName] locators
  - Follow canActivate guards for auth detection
```

**After each:** Run `tsc --noEmit`.

---

## STEP 35 — Final Integration & Smoke Test
**No document section — this is validation.**

**Prompt:**
```
Run a final integration check.

1. Ensure every extractor is registered in src/analysis/backend/index.ts
2. Ensure generateCommand imports and calls every extractor
3. Run tsc --noEmit — must be zero errors
4. Run pnpm build — must compile to dist/ with zero errors
5. Show me the final file count in src/ directory

Do not add any new features. Fix only compilation errors if any exist.
```

**After:** Run `pnpm build` — must be clean.

---

## FINAL BUILD VERIFICATION

```bash
# These commands must all succeed before you consider the build complete:
pnpm install          # clean install
tsc --noEmit          # zero type errors
pnpm build            # compiles to dist/
node dist/cli/index.js --help   # CLI responds correctly
```

---

## QUICK REFERENCE — What Each Step Produces

| Step | File Created | Depends On |
|------|-------------|------------|
| 1 | utils/ast-utils.ts | nothing |
| 2 | analysis/parser.ts | ast-utils |
| 3 | utils/logger.ts | nothing |
| 4 | utils/file-utils.ts | parser (SKIP_DIRS) |
| 5 | ingestion/detector.ts | file-utils |
| 6 | ingestion/config-harvester.ts | file-utils |
| 7 | ingestion/cloner.ts | logger |
| 8 | blueprint/types.ts | nothing |
| 9 | analysis/backend/index.ts | types, parser, detector |
| 10 | schemas/zod.extractor.ts | types, parser, ast-utils |
| 11 | schemas/typescript-types.extractor.ts | types, parser, ast-utils |
| 12 | backend/express.extractor.ts | all above |
| 13 | auth/auth-detector.ts | types, parser |
| 14 | blueprint/builder.ts | types, detector, config-harvester |
| 15 | blueprint/chunker.ts | types |
| 16 | generation/client.ts | nothing |
| 17 | generation/prompts/* | chunker, types |
| 18 | output/validator.ts | nothing |
| 19 | output/playwright-writer.ts | types, file-utils |
| 20 | output/postman-writer.ts | types, file-utils, validator |
| 21 | output/reporter.ts | types, file-utils |
| 22 | cli/commands/generate.ts | everything |
| 23 | cli/commands/analyze.ts | everything except generation |
| 24 | cli/index.ts | generate, analyze commands |
| 25-34 | remaining extractors | index.ts + types |
| 35 | integration check | all |
