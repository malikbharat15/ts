import * as path from "path";
import type { BlueprintChunk } from "../blueprint/chunker";
import type { AuthConfig } from "../blueprint/types";
import { classifyAuthStrategy } from "../blueprint/chunker";
import { ensureDir, writeFile } from "../utils/file-utils";

// ─── Static file content ──────────────────────────────────────────────────────

function buildPlaywrightConfig(auth: AuthConfig | null, baseUrl: string): string {
  const strategy = classifyAuthStrategy(auth);
  const isStorageState = strategy === "storageState";
  const globalSetupLine = isStorageState ? `\n  globalSetup: './auth.setup.ts',` : "";
  const storageStateLine = isStorageState
    ? `\n    storageState: './smoke/auth.state.json',`
    : "";
  return `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './smoke',
  grep: /@smoke/,
  timeout: 30000,
  retries: 0,${globalSetupLine}
  use: {
    baseURL: process.env.BASE_URL || '${baseUrl}',
    extraHTTPHeaders: { 'x-smokeforge-test': 'true' },${storageStateLine}
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'api', testMatch: /\\.api\\.spec\\.ts$/, use: {} },
  ],
});
`;
}

// ─── auth.setup.ts — global setup for storageState strategies ────────────────

export function buildAuthSetupFile(auth: AuthConfig, baseUrl: string): string {
  const fallbackEmail = auth.defaultEmail ?? "admin@example.com";
  const fallbackPassword = auth.defaultPassword ?? "SmokeTest123!";

  // OAuth SSO / Firebase / Supabase / Clerk — can't automate IdP login
  if (
    auth.tokenType === "oauth_sso" ||
    auth.tokenType === "firebase" ||
    auth.tokenType === "supabase" ||
    auth.tokenType === "clerk"
  ) {
    return `// ⚠️  External Identity Provider detected (${auth.tokenType}).
//
// This globalSetup cannot automate the IdP login flow directly.
//
// TO FIX: run Playwright codegen once to capture a logged-in session:
//   npx playwright codegen --save-storage=smoke/auth.state.json ${baseUrl}
//   (Log in manually, then Ctrl-C — auth.state.json will be saved)
//
// Once auth.state.json exists, playwright.config.ts will load it automatically.

import type { FullConfig } from '@playwright/test';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // Session captured via codegen — nothing to do here at runtime.
  // Delete smoke/auth.state.json and re-run codegen whenever your session expires.
}
`;
  }

  const loginPath = auth.loginEndpoint.replace(/^[A-Z]+\s+/, "");
  const ef = auth.credentialsFields.emailField;
  const pf = auth.credentialsFields.passwordField;

  if (auth.tokenType === "next_auth") {
    return `import { request as playwrightRequest } from '@playwright/test';
import type { FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL  = process.env.BASE_URL  || '${baseUrl}';
const EMAIL     = process.env.SMOKE_TEST_EMAIL    || '${fallbackEmail}';
const PASSWORD  = process.env.SMOKE_TEST_PASSWORD || '${fallbackPassword}';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const ctx = await playwrightRequest.newContext();

  // Step 1: Fetch NextAuth CSRF token (required before credentials login)
  const csrfResp = await ctx.get(BASE_URL + '/api/auth/csrf');
  if (!csrfResp.ok()) throw new Error(\`CSRF fetch failed: \${csrfResp.status()}\`);
  const { csrfToken } = await csrfResp.json();

  // Step 2: POST credentials + csrfToken to credentials callback
  const resp = await ctx.post(BASE_URL + '/api/auth/callback/credentials', {
    form: {
      ${ef}: EMAIL,
      ${pf}: PASSWORD,
      csrfToken,
      callbackUrl: BASE_URL + '/dashboard',
      json: 'true',
    },
  });
  if (![200, 302].includes(resp.status())) {
    throw new Error(\`NextAuth login failed: HTTP \${resp.status()}\`);
  }

  // Save session cookies to smoke/auth.state.json
  const stateDir = path.join(__dirname, 'smoke');
  fs.mkdirSync(stateDir, { recursive: true });
  await ctx.storageState({ path: path.join(stateDir, 'auth.state.json') });
  await ctx.dispose();
}
`;
  }

  // session_cookie (form or JSON login)
  const bodyOpt = auth.loginBodyFormat === "form"
    ? `{ form: { ${ef}: EMAIL, ${pf}: PASSWORD } }`
    : `{ data: { ${ef}: EMAIL, ${pf}: PASSWORD } }`;

  return `import { request as playwrightRequest } from '@playwright/test';
import type { FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL  = process.env.BASE_URL  || '${baseUrl}';
const EMAIL     = process.env.SMOKE_TEST_EMAIL    || '${fallbackEmail}';
const PASSWORD  = process.env.SMOKE_TEST_PASSWORD || '${fallbackPassword}';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const ctx = await playwrightRequest.newContext();

  const resp = await ctx.post(BASE_URL + '${loginPath}', ${bodyOpt});
  if (![200, 201, 302].includes(resp.status())) {
    throw new Error(\`Login failed: HTTP \${resp.status()}\`);
  }

  // Save session cookies to smoke/auth.state.json (loaded by playwright.config.ts)
  const stateDir = path.join(__dirname, 'smoke');
  fs.mkdirSync(stateDir, { recursive: true });
  await ctx.storageState({ path: path.join(stateDir, 'auth.state.json') });
  await ctx.dispose();
}
`;
}

function buildAuthFixture(auth: AuthConfig | null, baseUrl = "http://localhost:3000"): string {
  const strategy = classifyAuthStrategy(auth);

  // storageState apps: session is loaded by playwright.config.ts globalSetup.
  // Spec files just use the built-in { page } and { request } fixtures directly.
  if (strategy === "storageState") {
    return `// Auth note: session is loaded globally via auth.setup.ts → playwright.config.ts storageState.
// Spec files should use the built-in Playwright { page } and { request } fixtures directly —
// no manual login is needed inside individual tests.

import { test, expect } from '@playwright/test';
export { test, expect };
`;
  }

  // bearer_inline apps: LLM generates module-level ctx + beforeAll in each spec file.
  if (strategy === "bearer_inline") {
    const loginPath = auth?.loginEndpoint
      ? auth.loginEndpoint.replace(/^[A-Z]+\s+/, "")
      : "/api/v1/auth/login";
    const ef    = auth?.credentialsFields?.emailField   ?? "email";
    const pf    = auth?.credentialsFields?.passwordField ?? "password";
    const tokenPath  = auth?.tokenResponsePath ?? "accessToken";
    const fallbackEmail    = auth?.defaultEmail    ?? "smoketest@example.com";
    const fallbackPassword = auth?.defaultPassword ?? "SmokeTest123!";
    const bodyOption = auth?.loginBodyFormat === "form"
      ? `form: { ${ef}: EMAIL, ${pf}: PASSWORD }`
      : `data: { ${ef}: EMAIL, ${pf}: PASSWORD }`;
    return `// Auth pattern for bearer-token apps:
// Each spec file must set up a module-level APIRequestContext in test.beforeAll.
//
// EXACT PATTERN (copy into each spec file):
//
//   import { test, expect, request as playwrightRequest } from '@playwright/test';
//   import type { APIRequestContext } from '@playwright/test';
//
//   const BASE_URL  = process.env.BASE_URL  || '${baseUrl}';
//   const EMAIL     = process.env.SMOKE_TEST_EMAIL    || '${fallbackEmail}';
//   const PASSWORD  = process.env.SMOKE_TEST_PASSWORD || '${fallbackPassword}';
//   let ctx: APIRequestContext;
//   let authToken: string;
//
//   test.beforeAll(async () => {
//     ctx = await playwrightRequest.newContext();
//     const loginResp = await ctx.post(BASE_URL + '${loginPath}', { ${bodyOption} });
//     const body = await loginResp.json();
//     authToken = body.${tokenPath};
//   });
//   test.afterAll(async () => { await ctx.dispose(); });
//
//   // In each test — use ctx and pass Authorization header:
//   test('title @smoke', async () => {
//     const resp = await ctx.get(BASE_URL + '/api/resource', {
//       headers: { 'Authorization': \`Bearer \${authToken}\` },
//     });
//     expect(resp.status()).toBe(200);
//   });

import { test, expect } from '@playwright/test';
export { test, expect };
`;
  }

  // none / public apps
  return `import { test, expect } from '@playwright/test';
export { test, expect };
`;
}

function buildPackageJson(projectName: string): string {
  return JSON.stringify({
    name: projectName,
    version: "1.0.0",
    private: true,
    scripts: {
      test: "playwright test --grep @smoke",
      "test:api": "playwright test --grep @smoke --project=api",
      "test:ui": "playwright test --grep @smoke --project=chromium",
    },
    devDependencies: {
      "@playwright/test": "^1.44.0",
      "@types/node": "^20.0.0",
    },
  }, null, 2) + "\n";
}

function buildEnvExample(auth: AuthConfig | null, baseUrl = "http://localhost:3000"): string {
  const email = auth?.defaultEmail ?? 'smoketest@example.com';
  const password = auth?.defaultPassword ?? 'SmokeTest123!';

  if (auth?.tokenType === "oauth_sso") {
    return `BASE_URL=${baseUrl}
# SSO/OAuth detected — see fixtures/auth.fixture.ts for setup instructions.
# Run: npx playwright codegen --save-storage=auth.json <BASE_URL>
PLAYWRIGHT_AUTH_STATE=./auth.json
# Optional: if a non-SSO service account exists
# SMOKE_TEST_EMAIL=${email}
# SMOKE_TEST_PASSWORD=${password}
`;
  }

  return `BASE_URL=${baseUrl}
SMOKE_TEST_EMAIL=${email}
SMOKE_TEST_PASSWORD=${password}
`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function writePlaywrightOutput(
  _chunks: BlueprintChunk[],
  generatedSpecs: Array<{ chunk: BlueprintChunk; code: string }>,
  outputDir: string,
  auth: AuthConfig | null,
  baseUrl = "http://localhost:3000"
): Promise<void> {
  const playwrightDir = path.join(outputDir, "playwright");
  const smokeDir = path.join(playwrightDir, "smoke");
  const fixturesDir = path.join(playwrightDir, "fixtures");

  // Ensure all output directories exist
  await Promise.all([
    ensureDir(smokeDir),
    ensureDir(fixturesDir),
  ]);

  const strategy = classifyAuthStrategy(auth);

  // 1. Write one spec file per generated chunk (replace any hardcoded localhost:3000 with actual baseUrl)
  for (const { chunk, code } of generatedSpecs) {
    const specPath = path.join(smokeDir, chunk.outputFileName);
    const fixedCode = code.replace(/http:\/\/localhost:3000/g, baseUrl);
    writeFile(specPath, fixedCode);
  }

  // 2. Write playwright.config.ts
  writeFile(
    path.join(playwrightDir, "playwright.config.ts"),
    buildPlaywrightConfig(auth, baseUrl)
  );

  // 3. Emit auth.setup.ts for storageState strategies (session runs once via globalSetup)
  if (strategy === "storageState" && auth) {
    writeFile(
      path.join(playwrightDir, "auth.setup.ts"),
      buildAuthSetupFile(auth, baseUrl)
    );
  }

  // 4. Write fixtures/auth.fixture.ts
  writeFile(
    path.join(fixturesDir, "auth.fixture.ts"),
    buildAuthFixture(auth, baseUrl)
  );

  // 5. Write package.json
  const repoSlug = path.basename(outputDir).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  writeFile(
    path.join(playwrightDir, "package.json"),
    buildPackageJson(`${repoSlug}-smoke`)
  );

  // 6. Write .env.example at the output root
  writeFile(path.join(outputDir, ".env.example"), buildEnvExample(auth, baseUrl));
}
