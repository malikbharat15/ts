import type { BlueprintChunk } from "../blueprint/chunker";
import type { ExtractedEndpoint, ExtractedPage } from "../blueprint/types";

// ─── Auth notes builder ───────────────────────────────────────────────────────

/**
 * Builds the AUTH USAGE NOTES section of the LLM prompt.
 *
 * Strategy determines the entire auth pattern for the generated spec file:
 *
 * - storageState  → Login happened ONCE in auth.setup.ts (globalSetup). This spec file
 *                   must NOT contain any login logic. { page } and { request } fixtures
 *                   already carry the authenticated session from storageState.
 *
 * - bearer_inline → One beforeAll per file gets a token; ALL tests in this file share it
 *                   via module-level ctx + authToken variables.
 *
 * - none          → App is public; no auth setup needed anywhere.
 */
function buildAuthNotes(chunk: BlueprintChunk): string {
  const { auth, authStrategy } = chunk;

  // ── none: public app ───────────────────────────────────────────────────────
  if (authStrategy === "none" || !auth) {
    return [
      `AUTH STRATEGY: NONE — this application has no authentication.`,
      `All endpoints and pages are publicly accessible.`,
      `DO NOT generate any login logic, beforeAll auth setup, or Authorization headers.`,
      `Just make requests directly and navigate to pages.`,
    ].join("\n");
  }

  // ── storageState: session already loaded by globalSetup ───────────────────
  if (authStrategy === "storageState") {
    const fallbackEmail = auth.defaultEmail ?? "smoketest@example.com";
    const fallbackPassword = auth.defaultPassword ?? "SmokeTest123!";
    return [
      `AUTH STRATEGY: STORAGE STATE`,
      ``,
      `⚠️  CRITICAL — DO NOT write any login logic in this spec file.`,
      ``,
      `The session has already been established ONCE by the shared auth.setup.ts globalSetup`,
      `and saved to smoke/auth.state.json. Playwright loads it automatically for every spec`,
      `via storageState in playwright.config.ts.`,
      ``,
      `WHAT THIS MEANS FOR YOUR GENERATED CODE:`,
      `- NO beforeAll login / CSRF / newContext() auth setup`,
      `- NO import of playwrightRequest or APIRequestContext for session setup`,
      `- NO calls to any /auth/login, /api/auth/csrf, or /api/auth/callback endpoints`,
      ``,
      `FOR UI PAGES (use { page } fixture):`,
      `  test('dashboard @smoke', async ({ page }) => {`,
      `    await page.goto(process.env.BASE_URL + '/dashboard');`,
      `    await expect(page.getByRole('heading')).toBeVisible();`,
      `  });`,
      ``,
      `FOR API ENDPOINTS that use session cookies (use { request } fixture):`,
      `  test('GET /api/users @smoke', async ({ request }) => {`,
      `    const response = await request.get(process.env.BASE_URL + '/api/users');`,
      `    expect(response.status()).toBe(200);`,
      `  });`,
      ``,
      `RULES:`,
      `- The { page } and { request } fixtures automatically carry the storageState session`,
      `- DO NOT use request.newContext() — it would create a fresh unauthenticated context`,
      `- DO NOT add auth headers manually — session cookies handle auth`,
      auth.defaultEmail ? `` : ``,
      auth.defaultEmail ? `SEED CREDENTIALS (for reference only — do not use in login code):` : ``,
      auth.defaultEmail ? `  Default email:    ${fallbackEmail}` : ``,
      auth.defaultPassword ? `  Default password: ${fallbackPassword}` : ``,
    ].filter(s => s !== undefined).join("\n");
  }

  // ── bearer_inline: one beforeAll per file, shared token ───────────────────
  // (bearer_jwt, api_key_header, api_key_query, basic_auth, oauth_bearer)
  const loginPath = auth.loginEndpoint.replace(/^[A-Z]+\s+/, "");
  const ef = auth.credentialsFields.emailField;
  const pf = auth.credentialsFields.passwordField;
  const tokenPath = auth.tokenResponsePath ?? "accessToken";
  const fallbackEmail = auth.defaultEmail ?? "smoketest@example.com";
  const fallbackPassword = auth.defaultPassword ?? "SmokeTest123!";
  const bodyOption = auth.loginBodyFormat === "form"
    ? `{ form: { ${ef}: EMAIL, ${pf}: PASSWORD } }  // form-urlencoded`
    : `{ data: { ${ef}: EMAIL, ${pf}: PASSWORD } }  // JSON body`;

  // Build token extraction (supports dot-notation like "data.accessToken")
  const tokenExpr = tokenPath.split(".").reduce((acc, seg) => `${acc}.${seg}`, "body");

  return [
    `AUTH STRATEGY: BEARER INLINE`,
    ``,
    `ONE login at file scope in test.beforeAll — token shared across ALL tests in this file.`,
    ``,
    `Login endpoint : ${auth.loginEndpoint}`,
    `Body format    : ${auth.loginBodyFormat === "form" ? "FORM (application/x-www-form-urlencoded)" : "JSON (application/json)"}`,
    `Token path     : body.${tokenPath}`,
    `Header         : ${auth.tokenHeaderName}: ${auth.tokenHeaderFormat}`,
    ``,
    `USE THIS EXACT PATTERN — copy precisely:`,
    ``,
    `import { test, expect, request as playwrightRequest } from '@playwright/test';`,
    `import type { APIRequestContext } from '@playwright/test';`,
    ``,
    `const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';`,
    `const EMAIL    = process.env.SMOKE_TEST_EMAIL    || '${fallbackEmail}';`,
    `const PASSWORD = process.env.SMOKE_TEST_PASSWORD || '${fallbackPassword}';`,
    ``,
    `let ctx: APIRequestContext;`,
    `let authToken: string;`,
    ``,
    `test.beforeAll(async () => {`,
    `  ctx = await playwrightRequest.newContext();`,
    `  const loginResp = await ctx.post(BASE_URL + '${loginPath}', ${bodyOption});`,
    `  const body = await loginResp.json();`,
    `  authToken = ${tokenExpr};`,
    `});`,
    ``,
    `test.afterAll(async () => { await ctx.dispose(); });`,
    ``,
    `// In every test — use module-level ctx with Authorization header:`,
    `test('GET /api/resource @smoke', async () => {`,
    `  const response = await ctx.get(BASE_URL + '/api/resource', {`,
    `    headers: { '${auth.tokenHeaderName}': \`${auth.tokenHeaderFormat.replace("{token}", "${authToken}")}\` },`,
    `  });`,
    `  expect(response.status()).toBe(200);`,
    `});`,
    ``,
    `RULES:`,
    `- ONE beforeAll per file — NEVER login inside individual test() bodies`,
    `- Use module-level ctx for ALL API requests in this file`,
    `- Always pass the ${auth.tokenHeaderName} header on every authenticated request`,
    `- For UI pages using { page } fixture: fill and submit the login form instead of using ctx`,
    auth.refreshEndpoint ? `- Refresh endpoint available: ${auth.refreshEndpoint}` : ``,
    auth.defaultEmail ? `\nSEED CREDENTIALS (use as fallbacks in generated code):` : ``,
    auth.defaultEmail ? `  Default email:    ${fallbackEmail}` : ``,
    auth.defaultPassword ? `  Default password: ${fallbackPassword}` : ``,
  ].filter(s => s !== undefined && s !== null).join("\n");
}

// ─── FK lookup helper ─────────────────────────────────────────────────────────

/**
 * For a body field whose name ends in `Id`/`ID`, find the best list GET endpoint
 * that likely supplies real IDs for that resource.
 * Prefers a same-chunk GET; falls back to any GET in the full blueprint.
 * "List" endpoint = GET with no path params (avoids detail routes like /api/resource/:id).
 */
function findFkListEndpoint(
  fieldName: string,
  chunkEndpoints: ExtractedEndpoint[],
  allEndpoints: ExtractedEndpoint[]
): { path: string; isCrossChunk: boolean } | null {
  const resource = fieldName.replace(/Id$/i, "").toLowerCase();

  const isListGet = (e: ExtractedEndpoint) =>
    e.method === "GET" &&
    e.path.toLowerCase().includes(resource) &&
    (!e.pathParams || e.pathParams.length === 0);

  const sameChunk = chunkEndpoints.find(isListGet);
  if (sameChunk) return { path: sameChunk.path, isCrossChunk: false };

  const crossChunk = allEndpoints.find(isListGet);
  if (crossChunk) return { path: crossChunk.path, isCrossChunk: true };

  return null;
}

// ─── Endpoint detail builder ──────────────────────────────────────────────────

function buildEndpointDetail(
  ep: ExtractedEndpoint,
  chunkEndpoints: ExtractedEndpoint[],
  allEndpoints: ExtractedEndpoint[]
): string {
  const lines: string[] = [];
  lines.push(`${ep.method} ${ep.path}`);

  // PAGE ROUTE warning — must appear first so the LLM sees it immediately
  if (ep.isPageRoute) {
    lines.push(`  ⚠️  PAGE ROUTE — returns HTML (React SSR), NOT JSON.`);
    lines.push(`     NEVER call response.json() on this endpoint — you will get SyntaxError: Unexpected token '<'.`);
    lines.push(`     For this endpoint:`);
    lines.push(`       • Use page.goto(BASE_URL + '${ep.path}') with a browser { page } test.`);
    lines.push(`       • Assert a heading or key element is visible: await expect(page.getByRole('heading', { level: 1 })).toBeVisible()`);
    lines.push(`       • For headings with dynamic counts like 'Appointments (42)', use regex: { name: /^Appointments/i } — NEVER exact match.`);
    lines.push(`       • Do NOT use ctx.get() or any APIRequestContext for this route — only browser page tests.`);
  }

  lines.push(`  Auth required: ${ep.authRequired ? "YES" : "NO"}${ep.authType ? ` (${ep.authType})` : ""}`);


  if (ep.roles && ep.roles.length > 0) {
    lines.push(`  Required roles: [${ep.roles.join(", ")}]`);
    lines.push(`  → Use test credentials that have one of these roles. If using seeded admin user, confirm it has the required role.`);
  }

  if (ep.pathParams && ep.pathParams.length > 0) {
    lines.push(`  Path params: ${ep.pathParams.map((p) => `:${p.name} (${p.type ?? "string"})`).join(", ")}`);
    lines.push(`  → For path params: first GET the list endpoint to get a real ID, then use it. Do not hardcode placeholder UUIDs for DB lookups.`);
  }

  if (ep.queryParams && ep.queryParams.length > 0) {
    lines.push(`  Query params: ${ep.queryParams.map((p) => `${p.name}${p.required ? " (required)" : " (optional)"}: ${p.type ?? "string"}`).join(", ")}`);
  }

  if (ep.requestBody && ep.requestBody.fields.length > 0) {
    const schemaLabel = ep.requestBody.rawSchemaRef
      ? ` (schema: ${ep.requestBody.rawSchemaRef}, source: ${ep.requestBody.source})`
      : ` (source: ${ep.requestBody.source})`;
    lines.push(`  Request body fields${schemaLabel}:`);
    lines.push(`  ⚠️  Send ONLY these exact field names — extra or missing required fields → 422.`);
    for (const f of ep.requestBody.fields) {
      const req = f.required ? "REQUIRED" : "optional";
      const enumVals = f.validators?.find(v => v.startsWith("enum:"))?.replace("enum:", "");
      let typeHint = f.type ?? "string";
      if (enumVals) typeHint = `enum[${enumVals}]`;
      const exampleHint = f.example ? ` — example: "${f.example}"` : "";
      const fkFound = /Id$/i.test(f.name)
        ? findFkListEndpoint(f.name, chunkEndpoints, allEndpoints)
        : null;
      let fkHint = "";
      if (fkFound !== null) {
        // Build a short path hint: response array key is the plural resource name
        const resourcePlural = f.name.replace(/Id$/i, "s");
        const requiredNote = f.required ? " (REQUIRED)" : "";
        if (fkFound.isCrossChunk) {
          fkHint = ` ⚠️ FK${requiredNote} — CROSS-CHUNK: add in beforeAll: const r = await ctx.get(BASE_URL + '${fkFound.path}'); const ${resourcePlural} = await r.json(); const ${f.name} = ${resourcePlural}[0]?.id ?? ${resourcePlural}[0]?.${f.name}`;
        } else {
          fkHint = ` ⚠️ FK${requiredNote} — fetch real ID first: GET ${fkFound.path} → ${resourcePlural}[0].id or ${resourcePlural}[0].${f.name}`;
        }
      } else if (/Id$/i.test(f.name)) {
        const requiredNote = f.required ? " (REQUIRED — MUST resolve, do not skip)" : "";
        fkHint = ` ⚠️ FK${requiredNote} — no list endpoint found in blueprint; extract from seed data or skip if truly optional`;
      }
      lines.push(`    - ${f.name}: ${typeHint} (${req})${exampleHint}${fkHint}`);
    }
    // Required fields reminder
    const reqFields = ep.requestBody.fields.filter(f => f.required).map(f => f.name);
    if (reqFields.length > 0) {
      lines.push(`  → Required fields you MUST send: ${reqFields.join(", ")}`);
    }
    // For PATCH/PUT: if all fields are optional, the LLM must still send a body
    if ((ep.method === "PATCH" || ep.method === "PUT") && reqFields.length === 0) {
      lines.push(`  → ALL fields are optional but you MUST still send a body (empty body crashes request.json()). Send all listed fields with minimal test values.`);
    }
  }

  if (ep.responseSchema) {
    lines.push(`  Response: ${JSON.stringify(ep.responseSchema)}`);
  } else {
    lines.push(`  Response: Assert status 200/201. Assert response body is not empty. Check for key business fields if identifiable.`);
  }

  if (ep.flags && ep.flags.length > 0) {
    lines.push(`  Flags: ${ep.flags.join(", ")}`);
  }

  return lines.join("\n");
}

// ─── Page detail builder ──────────────────────────────────────────────────────

function buildPageDetail(page: ExtractedPage): string {
  const lines: string[] = [];
  lines.push(`PAGE: ${page.route}${page.title ? ` (title: "${page.title}")` : ""}`);
  lines.push(`  Auth required: ${page.authRequired ? "YES" : "NO"}${page.roles?.length ? ` — roles: [${page.roles.join(", ")}]` : ""}`);

  if (page.isDynamic && page.routeParams?.length) {
    lines.push(`  Route params: ${page.routeParams.map((p) => `:${p.name} (example: ${p.example})`).join(", ")}`);
  }

  if (page.locators && page.locators.length > 0) {
    lines.push(`  Locators found (use these in assertions):`);
    for (const loc of page.locators) {
      lines.push(`    - ${loc.name} [${loc.strategy}/${loc.elementType}]: ${loc.playwrightCode}`);
    }
  } else {
    lines.push(`  No pre-extracted locators — use getByRole/getByLabel/getByText for assertions.`);
    lines.push(`  → Navigate to page.goto('${page.route}') and assert a heading or key element is visible.`);
  }

  if (page.formFlows && page.formFlows.length > 0) {
    lines.push(`  Form flows:`);
    for (const form of page.formFlows) {
      lines.push(`    Form: ${form.name}`);
      for (const step of form.steps) {
        lines.push(`      ${step.order}. ${step.action} ${step.locatorCode}${step.testValue ? ` with "${step.testValue}"` : ""}`);
      }
      if (form.successRedirectHint) {
        lines.push(`      → Success redirect: ${form.successRedirectHint}`);
      }
    }
  }

  return lines.join("\n");
}

// ─── Main message builder ─────────────────────────────────────────────────────

export function buildPlaywrightUserMessage(chunk: BlueprintChunk, allEndpoints: ExtractedEndpoint[] = []): string {
  const authNotes = buildAuthNotes(chunk);
  const endpointDetails = chunk.endpoints
    .map(ep => buildEndpointDetail(ep, chunk.endpoints, allEndpoints))
    .join("\n\n");
  const pageDetails = chunk.pages.map(buildPageDetail).join("\n\n");

  return `
Generate Playwright smoke tests for the following application chunk.

═══════════════════════════════════════════════════
## AUTH CONFIGURATION (RAW):
${JSON.stringify(chunk.auth, null, 2)}

## AUTH USAGE NOTES — READ CAREFULLY:
${authNotes}

═══════════════════════════════════════════════════
## API ENDPOINTS TO TEST (${chunk.endpoints.length} total):
${endpointDetails || "None"}

## RAW ENDPOINT JSON (for completeness):
${JSON.stringify(chunk.endpoints, null, 2)}

═══════════════════════════════════════════════════
## UI PAGES TO TEST (${chunk.pages.length} total):
${pageDetails || "None"}

## RAW PAGES JSON (for completeness):
${JSON.stringify(chunk.pages, null, 2)}

═══════════════════════════════════════════════════
## TEST DATA HINTS:
${JSON.stringify(chunk.testDataHints, null, 2)}

═══════════════════════════════════════════════════
## COVERAGE REQUIREMENTS:
- Test EVERY endpoint listed above (no skipping).
- Test EVERY UI page listed above (navigate + assert key element).
- For each endpoint: assert correct HTTP status AND validate key response body fields.
- For auth-required endpoints: always authenticate first using the auth notes above.
- For endpoints with requestBody fields: send ALL required fields with realistic test data.
- For endpoints with pathParams: look up a real ID via a GET first (do NOT hardcode placeholder UUIDs for DB rows).
- For endpoints with roles: ensure the test user has the required role.
- For UI pages: navigate to the route, wait for load, assert at least one meaningful element is visible.
- For form pages: fill and submit the form if possible, assert the result.

## ASSERTIONS REQUIRED:
- Every API test: expect(response.status()).toBe(200) or expect([200, 201]).toContain(response.status())
- Every API test: const body = await response.json(); and assert at least one body field
- Every page test: await expect(page).toHaveURL(...) or await expect(page.getByRole(...)).toBeVisible()

## DOMAIN: ${chunk.domain}
## OUTPUT FILE NAME: ${chunk.outputFileName}

Generate the COMPLETE TypeScript test file now. Cover all endpoints and pages. No placeholders.
`.trim();
}
