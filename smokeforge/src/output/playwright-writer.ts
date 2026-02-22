import * as path from "path";
import type { BlueprintChunk } from "../blueprint/chunker";
import type { AuthConfig } from "../blueprint/types";
import { ensureDir, writeFile } from "../utils/file-utils";

// ─── Static file content ──────────────────────────────────────────────────────

function buildPlaywrightConfig(auth: AuthConfig | null, baseUrl: string): string {
  const storageStateLine = auth?.tokenType === "oauth_sso"
    ? `\n    storageState: process.env.PLAYWRIGHT_AUTH_STATE || undefined,`
    : "";
  return `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './smoke',
  grep: /@smoke/,
  timeout: 30000,
  retries: 0,
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

function buildAuthFixture(auth: AuthConfig | null, baseUrl = "http://localhost:3000"): string {
  // ── SSO / OAuth apps: use storageState instead of form/JSON login ───────────
  if (auth?.tokenType === "oauth_sso") {
    return `// ⚠️  SSO / OAuth authentication detected (SAML / OIDC / OAuth2).
//
// These tests CANNOT automate the external IdP login flow directly.
// Instead, use Playwright's storageState to reuse a pre-authenticated session:
//
//   Step 1 — Run the auth setup script once to save your session:
//     npx playwright codegen --save-storage=auth.json <BASE_URL>
//     (Log in manually via SSO, then Ctrl+C — auth.json will contain your cookies/tokens)
//
//   Step 2 — Set the env var:
//     PLAYWRIGHT_AUTH_STATE=./auth.json
//
//   Step 3 — Tests will load the saved state automatically (see playwright.config.ts).
//
// Alternative: if a non-SSO service account exists, set:
//   SMOKE_TEST_EMAIL, SMOKE_TEST_PASSWORD and update the login logic below.

import { test as base } from '@playwright/test';
export const test = base; // storageState is loaded via playwright.config.ts globalSetup
`;
  }

  const loginPath = auth?.loginEndpoint
    ? // loginEndpoint format: "POST /api/v1/auth/login" — strip the method prefix
      auth.loginEndpoint.replace(/^[A-Z]+\s+/, "")
    : "/api/v1/auth/login";

  const emailField = auth?.credentialsFields?.emailField ?? "email";
  const passwordField = auth?.credentialsFields?.passwordField ?? "password";
  const tokenPath = auth?.tokenResponsePath ?? "accessToken";
  const loginBodyFormat = auth?.loginBodyFormat ?? "json";

  // Build the token extraction expression (supports dot-notation like "data.token")
  const segments = tokenPath.split(".");
  const tokenExpr = segments.reduce((acc, seg) => `${acc}.${seg}`, "body");

  // Use seed-extracted credentials as fallbacks when available
  const fallbackEmail = auth?.defaultEmail ?? 'smoketest@example.com';
  const fallbackPassword = auth?.defaultPassword ?? 'SmokeTest123!';

  // Use the correct Playwright body option: form-urlencoded vs JSON
  const bodyOption = loginBodyFormat === "form"
    ? `form: {
          ${emailField}: process.env.SMOKE_TEST_EMAIL || '${fallbackEmail}',
          ${passwordField}: process.env.SMOKE_TEST_PASSWORD || '${fallbackPassword}',
        }`
    : `data: {
          ${emailField}: process.env.SMOKE_TEST_EMAIL || '${fallbackEmail}',
          ${passwordField}: process.env.SMOKE_TEST_PASSWORD || '${fallbackPassword}',
        }`;

  return `import { test as base, request } from '@playwright/test';

type AuthFixtures = { authToken: string };

export const test = base.extend<AuthFixtures>({
  authToken: async ({}, use) => {
    const ctx = await request.newContext();
    const response = await ctx.post(
      \`\${process.env.BASE_URL || '${baseUrl}'}${loginPath}\`,
      {
        ${bodyOption}
      }
    );
    const body = await response.json();
    await use(${tokenExpr});
    await ctx.dispose();
  },
});
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

  // 3. Write fixtures/auth.fixture.ts
  writeFile(
    path.join(fixturesDir, "auth.fixture.ts"),
    buildAuthFixture(auth, baseUrl)
  );

  // 4. Write package.json
  const repoSlug = path.basename(outputDir).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  writeFile(
    path.join(playwrightDir, "package.json"),
    buildPackageJson(`${repoSlug}-smoke`)
  );

  // 5. Write .env.example at the output root
  writeFile(path.join(outputDir, ".env.example"), buildEnvExample(auth, baseUrl));
}
