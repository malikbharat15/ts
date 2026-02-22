import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const POSTMAN_V21_SCHEMA =
  "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

// Matches hardcoded http(s):// URLs that are NOT:
//  - inside a template literal that references BASE_URL: `${BASE_URL}/path`
//  - the fallback value in: process.env.BASE_URL || 'http://localhost:3000'
//  - a schema string like 'https://schema.getpostman.com/...'
const HARDCODED_URL_RE = /https?:\/\/(?![^'"\`]*BASE_URL)(?![^'"\`]*schema\.)(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/

// Matches `test(` or `test.only(` or `test.skip(` openings
const TEST_BLOCK_RE = /\btest(?:\.only|\.skip)?\s*\(/g;

// Matches `expect(` anywhere — used to check assertions inside test blocks
const EXPECT_RE = /\bexpect\s*\(/;

// Real credential patterns that should never appear in generated tests
const REAL_CREDENTIAL_RE = /@(gmail|yahoo|hotmail|outlook|live)\.(com|co\.|net|org)/i;

// ─── Playwright validator ─────────────────────────────────────────────────────

/**
 * Extracts the body of the n-th test() call (everything between its outermost braces).
 * Returns null if the block cannot be isolated.
 */
function extractTestBodies(source: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(TEST_BLOCK_RE.source, "g");
  let m: RegExpExecArray | null;

  while ((m = re.exec(source)) !== null) {
    // Find the opening `async ({` or `({` after the test() call
    let idx = m.index + m[0].length;

    // For arrow functions like: test('title', async ({ page }) => { ... })
    // we must skip past the `=>` to find the callback body {, not parameter destructuring {.
    // Look ahead for `=>` before the next `{` to determine if this is an arrow function.
    let arrowIdx = -1;
    let tempIdx = idx;
    // Scan for `=>` while tracking paren depth (to skip string/paren contents)
    let parenDepth = 0;
    while (tempIdx < source.length) {
      const ch = source[tempIdx];
      if (ch === '(') { parenDepth++; tempIdx++; continue; }
      if (ch === ')') { parenDepth--; tempIdx++; continue; }
      if (ch === '{' && parenDepth === 0) break; // non-arrow function body
      if (ch === '=' && source[tempIdx + 1] === '>' && parenDepth === 0) {
        arrowIdx = tempIdx;
        break;
      }
      tempIdx++;
    }

    if (arrowIdx !== -1) {
      // Arrow function: skip past `=>` then find `{`
      idx = arrowIdx + 2;
      while (idx < source.length && /\s/.test(source[idx])) idx++;
    } else {
      // Non-arrow (function keyword): find first `{`
      while (idx < source.length && source[idx] !== "{") idx++;
    }

    if (idx >= source.length || source[idx] !== "{") continue;

    // Walk to matching closing brace
    let depth = 0;
    let start = idx;
    let end = idx;
    for (let i = idx; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    bodies.push(source.slice(start, end + 1));
  }

  return bodies;
}

export async function validatePlaywright(
  filePath: string
): Promise<ValidationResult> {
  const errors: string[] = [];

  // ── Read file ───────────────────────────────────────────────────────────────
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return { valid: false, errors: [`Cannot read file: ${filePath}`] };
  }

  // ── Static check 1: every test() block has at least one expect() ────────────
  const testBodies = extractTestBodies(source);
  if (testBodies.length === 0) {
    errors.push("No test() blocks found in generated file");
  } else {
    testBodies.forEach((body, i) => {
      if (!EXPECT_RE.test(body)) {
        errors.push(`test block #${i + 1} has no expect() assertion`);
      }
    });
  }

  // ── Static check 2: no hardcoded URLs ───────────────────────────────────────
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    // Skip comment lines and lines that are clearly fallback defaults
    if (/^\s*\/\//.test(line)) return;
    // Allow: process.env.BASE_URL || 'http://localhost:3000'
    if (/process\.env(?:\[.BASE_URL.\]|\.BASE_URL)\s*(?:\?\?|\|\|)/.test(line)) return;
    if (HARDCODED_URL_RE.test(line)) {
      errors.push(
        `Line ${i + 1}: hardcoded URL detected — use process.env.BASE_URL instead`
      );
    }
  });

  // ── Static check 3: no real credential patterns ─────────────────────────────
  if (REAL_CREDENTIAL_RE.test(source)) {
    errors.push(
      "Real email domain detected (e.g. @gmail.com) — use smoketest@example.com"
    );
  }

  // ── TypeScript compilation check ────────────────────────────────────────────
  // tsc's `node` moduleResolution walks UP from the *file's* directory tree —
  // not from process.cwd(). Temp files live in the OS tmpdir which has no
  // node_modules, so @playwright/test (and others) are never found by default.
  // Fix: write a tsconfig.json next to the temp file that uses baseUrl+paths to
  // point at smokeforge's own node_modules.
  const smokeforgeRoot = path.resolve(__dirname, "../../");
  const tempDir = path.dirname(filePath);
  const tempTsConfigPath = path.join(tempDir, "tsconfig.json");
  const tempTsConfig = {
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      moduleResolution: "node",
      strict: false,
      // baseUrl = smokeforge root so `paths` values resolve correctly
      baseUrl: smokeforgeRoot,
      paths: {
        "@playwright/test": ["node_modules/@playwright/test"],
      },
      // Point typeRoots ONLY at smokeforge's @types directory so TypeScript
      // can find @types/node (for process, Buffer, etc.) without traversing
      // the entire node_modules folder (which would cause TS2688 on scoped pkgs).
      typeRoots: [path.join(smokeforgeRoot, "node_modules/@types")],
      // Include only `node` global types; skip test runners, react, etc.
      types: ["node"],
      skipLibCheck: true,
    },
    // include only the single file being validated
    include: [filePath],
  };
  fs.writeFileSync(tempTsConfigPath, JSON.stringify(tempTsConfig, null, 2));
  try {
    await execAsync(
      `npx tsc --noEmit -p "${tempTsConfigPath}"`,
      { timeout: 30000, cwd: smokeforgeRoot }
    );
  } catch (err) {
    const message = (err as { stderr?: string; stdout?: string }).stderr
      || (err as { stderr?: string; stdout?: string }).stdout
      || String(err);
    // Extract just the error lines (filter out noise)
    const tscErrors = message
      .split("\n")
      .filter((l) => /error TS/.test(l))
      .slice(0, 10); // cap at 10 to avoid flooding the retry prompt
    if (tscErrors.length > 0) {
      errors.push(...tscErrors.map((l) => `tsc: ${l.trim()}`));
    } else if (message.trim()) {
      errors.push(`tsc compilation failed: ${message.trim().slice(0, 300)}`);
    }
  } finally {
    // Clean up the temporary tsconfig
    try { fs.unlinkSync(tempTsConfigPath); } catch { /* ignore */ }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Postman validator ────────────────────────────────────────────────────────

interface PostmanCollection {
  info?: {
    name?: string;
    schema?: string;
  };
  item?: unknown[];
  variable?: Array<{ key?: string; value?: string }>;
}

export function validatePostman(jsonString: string): ValidationResult {
  const errors: string[] = [];

  // ── 1: JSON parse check ─────────────────────────────────────────────────────
  let collection: PostmanCollection;
  try {
    collection = JSON.parse(jsonString) as PostmanCollection;
  } catch (err) {
    return {
      valid: false,
      errors: [`Invalid JSON: ${(err as Error).message}`],
    };
  }

  // ── 2: Required field — info.name ───────────────────────────────────────────
  if (!collection.info?.name) {
    errors.push("Missing required field: info.name");
  }

  // ── 3: Required field — info.schema must equal Postman v2.1 URL ─────────────
  if (!collection.info?.schema) {
    errors.push("Missing required field: info.schema");
  } else if (collection.info.schema !== POSTMAN_V21_SCHEMA) {
    errors.push(
      `info.schema must be "${POSTMAN_V21_SCHEMA}", got "${collection.info.schema}"`
    );
  }

  // ── 4: At least one item ─────────────────────────────────────────────────────
  if (!Array.isArray(collection.item) || collection.item.length === 0) {
    errors.push("Collection must have at least one item");
  }

  // ── 5: Collection variables must include BASE_URL and AUTH_TOKEN ─────────────
  const varKeys = (collection.variable ?? [])
    .map((v) => v.key ?? "")
    .filter(Boolean);

  if (!varKeys.includes("BASE_URL")) {
    errors.push("Collection variables must include BASE_URL");
  }
  if (!varKeys.includes("AUTH_TOKEN")) {
    errors.push("Collection variables must include AUTH_TOKEN");
  }

  return { valid: errors.length === 0, errors };
}
