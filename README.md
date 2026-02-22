# SmokeForge

**GenAI-powered smoke test generator for any JavaScript / TypeScript repository.**

Point SmokeForge at a GitHub URL (or a local path), and it generates ready-to-run **Playwright** specs and/or a **Postman collection** — with zero configuration required from you.

```
smokeforge generate https://github.com/acme/myapp --base-url http://localhost:3000
```

---

## How It Works

SmokeForge runs a 13-step pipeline:

| Step | What happens |
|------|-------------|
| **1** | Validate `ANTHROPIC_API_KEY` |
| **2** | **Git clone** the repository (`git clone --depth 1`) via `simple-git` → [`smokeforge/src/ingestion/cloner.ts`](smokeforge/src/ingestion/cloner.ts) |
| **3** | Detect frameworks from `package.json` (Express, Fastify, Next.js, Remix, React, Vue…) |
| **4** | Parse all `.ts/.tsx/.js/.jsx` files into ASTs, extract API endpoints + UI pages |
| **5** | Detect authentication patterns (JWT, NextAuth, session cookies…) |
| **6** | Build a typed **Test Blueprint JSON** — the LLM's source of truth |
| **7** | Chunk the blueprint by domain (1 LLM call per chunk) |
| **8** | Call Claude (Anthropic) to generate spec files, with up to 2 validation retries per chunk |
| **9** | Write Playwright spec files + `playwright.config.ts` |
| **10** | Write merged Postman collection + environment JSON |
| **11** | Write `smokeforge-report.json` (confidence scores, coverage, warnings) |
| **12** | Print summary |
| **13** | Delete the cloned temp directory |

> **Where is the Git step?**  
> Step 2 — `cloner.ts` calls `simpleGit().clone(url, tempDir, ['--depth', '1'])`.  
> For local paths (starting with `/`, `./`, `../`) it skips cloning entirely and reads in-place.

---

## Prerequisites

- **Node.js ≥ 18** (tested on v20 LTS)
- **npm ≥ 9**
- An **Anthropic API key** with access to `claude-sonnet-4-5` or later

---

## Installation

```bash
# 1. Clone this repository
git clone https://github.com/your-org/JSSmoketest.git
cd JSSmoketest

# 2. Install SmokeForge dependencies
cd smokeforge
npm install

# 3. Build the CLI
npm run build

# 4. (Optional) Link globally so you can call `smokeforge` from anywhere
npm link
```

---

## Configuration

Create `smokeforge/.env` (never committed):

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Or export it inline:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Usage

### Generate smoke tests from a GitHub URL

```bash
node smokeforge/dist/cli/index.js generate https://github.com/acme/myapp \
  --base-url http://localhost:3000 \
  --output ./smokeforge-output/myapp
```

### Generate from a GitHub Enterprise URL (with token auth)

Set your token in `smokeforge/.env` — no token in the command:

```bash
# In smokeforge/.env:
# GITHUB_TOKEN=ghp_your_token   (or GHE_TOKEN=... as fallback)

node smokeforge/dist/cli/index.js generate \
  "https://your-ghe.company.com/owner/repo" \
  --branch main \
  --base-url http://localhost:8080 \
  --output ./smokeforge-output/my-repo
```

### Generate from a local path (already cloned repo)

```bash
node smokeforge/dist/cli/index.js generate ./my-local-repo \
  --base-url http://localhost:3001 \
  --output ./smokeforge-output/local
```

### Generate API tests only

```bash
node smokeforge/dist/cli/index.js generate ./my-local-repo \
  --only-api \
  --output ./smokeforge-output/api-only
```

### Generate UI tests only

```bash
node smokeforge/dist/cli/index.js generate ./my-local-repo \
  --only-ui \
  --output ./smokeforge-output/ui-only
```

### Generate tests for a single domain

```bash
node smokeforge/dist/cli/index.js generate ./my-local-repo \
  --domain auth \
  --output ./smokeforge-output/auth-only
```

### Generate Postman collection only

```bash
node smokeforge/dist/cli/index.js generate ./my-local-repo \
  --format postman \
  --output ./smokeforge-output/postman-only
```

### Override framework detection

```bash
node smokeforge/dist/cli/index.js generate ./my-local-repo \
  --framework express \
  --output ./smokeforge-output/local
```

### Dry-run (no LLM calls, no API key needed)

Analyses the repo and dumps all blueprint chunks — useful for debugging extraction quality:

```bash
node smokeforge/dist/cli/index.js generate https://github.com/acme/myapp \
  --dry-run \
  --output ./smokeforge-output/dry-run
```

### Analyze only (output raw blueprint JSON)

```bash
node smokeforge/dist/cli/index.js analyze https://github.com/acme/myapp \
  --output ./blueprint.json
```

---

## CLI Reference

### `smokeforge generate <repo-url>`

`<repo-url>` can be a remote URL (`https://...`) or a local path (`./my-repo`, `/absolute/path`).

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--output <dir>` | `-o` | `./smokeforge-output` | Directory where generated tests are written |
| `--base-url <url>` | `-b` | `http://localhost:3000` | Target app URL injected into all generated tests |
| `--format <formats>` | `-f` | `playwright,postman` | Comma-separated output formats: `playwright`, `postman`, or both |
| `--framework <name>` | | _(auto-detect)_ | Override framework detection (e.g. `nextjs`, `express`, `fastify`, `remix`) |
| `--branch <name>` | | _(repo default)_ | Git branch to clone — only applies to remote URLs, ignored for local paths |
| `--only-api` | | false | Generate API tests only (skip UI/page tests) |
| `--only-ui` | | false | Generate UI/page tests only (skip API tests) |
| `--domain <name>` | | _(all domains)_ | Generate tests for one domain only (e.g. `auth`, `products`) |
| `--dry-run` | | false | Analyze + dump chunks — no LLM calls, no API key required |
| `--no-install` | | false | Skip `npm install` in the cloned repo (faster, lower schema accuracy) |
| `--verbose` | `-v` | false | Verbose output |

### `smokeforge analyze <repo-url>`

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--output <file>` | `-o` | `./blueprint.json` | Output file for the raw blueprint JSON |

---

## Running the Generated Tests

### Playwright

```bash
cd smokeforge-output/<name>/playwright

# Install dependencies (first time only)
npm install
npx playwright install chromium

# Run all smoke tests
SMOKE_TEST_EMAIL=admin@example.com \
SMOKE_TEST_PASSWORD='MyPassword123!' \
BASE_URL=http://localhost:3000 \
npx playwright test --grep @smoke

# Run with a visual reporter
npx playwright test --grep @smoke --reporter=list
```

### Postman / Newman

```bash
cd smokeforge-output/<name>/postman

npm install -g newman

newman run smoke-tests.postman_collection.json \
  -e smoke-env.postman_environment.json \
  --env-var "BASE_URL=http://localhost:3000" \
  --env-var "SMOKE_TEST_EMAIL=admin@example.com" \
  --env-var "SMOKE_TEST_PASSWORD=MyPassword123!"
```

---

## Output Structure

```
smokeforge-output/
└── <repo-name>/
    ├── blueprint.json               ← Full extraction: all endpoints + pages
    ├── smokeforge-report.json       ← Coverage + confidence scores
    ├── chunks/                      ← Per-domain LLM input (debug)
    │   ├── chunk-01-auth.json
    │   └── chunk-02-products.json
    ├── playwright/
    │   ├── playwright.config.ts
    │   ├── package.json
    │   └── smoke/
    │       ├── auth.api.spec.ts
    │       ├── products.api.spec.ts
    │       └── dashboard.page.spec.ts
    └── postman/
        ├── smoke-tests.postman_collection.json
        └── smoke-env.postman_environment.json
```

---

## Development

```bash
cd smokeforge

# Run tests
npm test

# Watch mode
npm run test:watch

# Type-check only (no emit)
npx tsc --noEmit

# Build
npm run build
```

---

## Environment Variables

Set these in `smokeforge/.env` or export them before running.

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes (except `--dry-run`) | Anthropic API key for Claude |
| `GITHUB_TOKEN` | No | GitHub / GitHub Enterprise personal access token — injected as `Authorization: token <token>` header during clone |
| `GHE_TOKEN` | No | Fallback token if `GITHUB_TOKEN` is not set — same behavior |
| `DEBUG` | No | Set to `true` for verbose debug logging |

---

## Supported Frameworks

| Category | Frameworks |
|----------|-----------|
| **Backend** | Express, Fastify, NestJS, Next.js (App + Pages Router), Remix, Koa, Hapi, Hono, tRPC, SvelteKit |
| **Frontend** | React (React Router v5/v6, TanStack Router), Vue (Vue Router), Angular, SvelteKit |
| **Schema validation** | Zod, Joi, class-validator, TypeScript types |
| **Auth** | JWT (Bearer), NextAuth/Auth.js, session cookies, Passport.js |

---

## License

MIT
