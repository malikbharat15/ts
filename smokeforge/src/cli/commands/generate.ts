import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { cloneRepo } from "../../ingestion/cloner";
import { detect } from "../../ingestion/detector";
import { harvestConfigs } from "../../ingestion/config-harvester";
import { parseFile, ANALYZABLE_EXTENSIONS } from "../../analysis/parser";
import { getAllFiles, ensureDir, writeFile } from "../../utils/file-utils";
import { runExtractors } from "../../analysis/backend/index";
import { detectAuth } from "../../analysis/auth/auth-detector";
import { extractReactLocators } from "../../analysis/ui/react.extractor";
import { extractVueLocators } from "../../analysis/ui/vue.extractor";
import { extractAngularLocators } from "../../analysis/ui/angular.extractor";
import { extractPages } from "../../analysis/ui/router-extractor";
import type { ExtractedEndpoint, ExtractedPage } from "../../blueprint/types";
import { buildBlueprint } from "../../blueprint/builder";
import { chunkBlueprint } from "../../blueprint/chunker";
import type { BlueprintChunk } from "../../blueprint/chunker";
import { generateWithRetry } from "../../generation/client";
import { PLAYWRIGHT_SYSTEM_PROMPT } from "../../generation/prompts/playwright.system";
import { POSTMAN_SYSTEM_PROMPT } from "../../generation/prompts/postman.system";
import { buildPlaywrightUserMessage } from "../../generation/playwright.generator";
import { buildPostmanUserMessage } from "../../generation/postman.generator";
import { buildRetryMessage } from "../../generation/prompts/retry";
import { validatePlaywright, validatePostman } from "../../output/validator";
import { writePlaywrightOutput } from "../../output/playwright-writer";
import { writePostmanOutput } from "../../output/postman-writer";
import { generateReport } from "../../output/reporter";
import { log, info, detail, warn, error as logError, success, spinner, banner, step, divider, row } from "../../utils/logger";

// ─── Public interface ─────────────────────────────────────────────────────────

export interface GenerateOptions {
  output: string;
  format: string; // "playwright,postman"
  baseUrl: string;
  framework?: string;
  onlyApi?: boolean;
  onlyUi?: boolean;
  domain?: string;
  verbose?: boolean;
  install?: boolean;
  dryRun?: boolean;
  branch?: string;
}

// ─── Retry helpers ────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;

async function generatePlaywrightWithRetry(
  chunk: BlueprintChunk,
  tempDir: string,
  allEndpoints: ExtractedEndpoint[] = []
): Promise<string> {
  const tempFile = path.join(tempDir, `_validate_${chunk.domain}.ts`);
  let code = await generateWithRetry(
    PLAYWRIGHT_SYSTEM_PROMPT,
    buildPlaywrightUserMessage(chunk, allEndpoints)
  );

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Strip markdown fences if Claude wrapped the output
    code = stripCodeFences(code);
    writeFile(tempFile, code);

    const result = await validatePlaywright(tempFile);
    if (result.valid) break;

    if (attempt < MAX_RETRIES - 1) {
      warn(
        `[${chunk.domain}] Playwright validation failed (attempt ${attempt + 1}/${MAX_RETRIES}): ` +
          result.errors.join("; ")
      );
      code = await generateWithRetry(
        PLAYWRIGHT_SYSTEM_PROMPT,
        buildRetryMessage(code, result.errors)
      );
    } else {
      warn(
        `[${chunk.domain}] Playwright validation still failing after ${MAX_RETRIES} retries — using last output`
      );
    }
  }

  // Clean up temp file
  try {
    fs.unlinkSync(tempFile);
  } catch {
    // ignore cleanup errors
  }

  return stripCodeFences(code);
}

async function generatePostmanWithRetry(chunk: BlueprintChunk): Promise<string> {
  let json = await generateWithRetry(
    POSTMAN_SYSTEM_PROMPT,
    buildPostmanUserMessage(chunk)
  );

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    json = stripCodeFences(json).trim();
    const result = validatePostman(json);
    if (result.valid) break;

    if (attempt < MAX_RETRIES - 1) {
      warn(
        `[${chunk.domain}] Postman validation failed (attempt ${attempt + 1}/${MAX_RETRIES}): ` +
          result.errors.join("; ")
      );
      json = await generateWithRetry(
        POSTMAN_SYSTEM_PROMPT,
        buildRetryMessage(json, result.errors)
      );
    } else {
      warn(
        `[${chunk.domain}] Postman validation still failing after ${MAX_RETRIES} retries — using last output`
      );
    }
  }

  return stripCodeFences(json).trim();
}

function stripCodeFences(text: string): string {
  // Remove ```typescript ... ``` or ```json ... ``` wrappers
  return text
    .replace(/^```(?:typescript|ts|json)?\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();
}

// ─── Summary printer ──────────────────────────────────────────────────────────

function printSummary(
  repoName: string,
  frameworkNames: string[],
  endpointCount: number,
  pageCount: number,
  playwrightSpecCount: number,
  postmanRequestCount: number,
  lowConfidenceCount: number,
  outputDir: string
): void {
  console.log();
  divider();
  success("SmokeForge Complete");
  divider();
  row("📁 Repository",     repoName);
  row("🔍 Frameworks",     frameworkNames.join(", ") || "unknown");
  row("🔗 Endpoints found", String(endpointCount));
  row("🖥️  Pages found",    String(pageCount));
  divider();
  if (playwrightSpecCount > 0)
    row("📄 Playwright specs", `${playwrightSpecCount} files`);
  if (postmanRequestCount > 0)
    row("📬 Postman requests", `${postmanRequestCount} items`);
  divider();
  if (lowConfidenceCount > 0) {
    warn(`Low-confidence items: ${lowConfidenceCount}  →  see smokeforge-report.json`);
  }
  row("📊 Report",         path.join(outputDir, "smokeforge-report.json"));
  divider();
  row("🚀 Run tests",      `cd ${outputDir}/playwright && npx playwright test --grep @smoke`);
  console.log();
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateCommand(
  repoUrl: string,
  options: GenerateOptions
): Promise<void> {
  const formats = options.format.split(",").map((f) => f.trim().toLowerCase());
  // Resolved after blueprint — see Step 6c below
  let doPlaywright = !options.onlyUi && formats.includes("playwright");
  let doPostman    = !options.onlyApi && formats.includes("postman");

  // ── Banner ────────────────────────────────────────────────────────────────
  banner();
  info(`Target repo : ${repoUrl}`);
  info(`Output dir  : ${options.output}`);
  info(`Base URL    : ${options.baseUrl}`);
  if (options.dryRun) info("Mode        : dry-run (no LLM calls)");
  console.log();

  // ── Step 1: Validate API key — skipped in dry-run mode ──────────────────────
  step(1, 13, "Checking API key");
  if (!options.dryRun && !process.env["ANTHROPIC_API_KEY"]) {
    logError(
      "ANTHROPIC_API_KEY is not set. Export it before running smokeforge."
    );
    process.exit(1);
  }
  if (!options.dryRun) detail("ANTHROPIC_API_KEY found ✔");
  else detail("Skipped (dry-run mode)");

  // ── Step 2: Clone repo ───────────────────────────────────────────────────────
  step(2, 13, "Cloning repository");
  const cloneSpinner = spinner(`Cloning ${repoUrl}...`);
  let cloneResult: Awaited<ReturnType<typeof cloneRepo>>;
  try {
    cloneResult = await cloneRepo(repoUrl, undefined, options.branch);
    cloneSpinner.succeed(`Cloned → ${cloneResult.repoPath}`);
  } catch (err) {
    cloneSpinner.fail(`Clone failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const { repoPath, repoName, cleanup } = cloneResult;

  try {
    // ── Step 3: Detect frameworks ──────────────────────────────────────────────
    step(3, 13, "Detecting frameworks");
    const detectSpinner = spinner("Scanning package.json...");
    const detection = await detect(repoPath);
    const primary = detection.packages[0];
    const frameworkNames = [
      ...(primary?.backendFrameworks ?? []),
      ...(primary?.frontendFrameworks ?? []),
    ];
    detectSpinner.succeed(`Detected: ${frameworkNames.join(", ") || "unknown"}`);
    if (primary?.schemaLibraries?.length)
      detail(`Schema libs : ${primary.schemaLibraries.join(", ")}`);
    if (primary?.authLibraries?.length)
      detail(`Auth libs   : ${primary.authLibraries.join(", ")}`);

    // ── Step 4: Parse + extract ────────────────────────────────────────────────
    step(4, 13, "Parsing source files");
    const parseSpinner = spinner("Parsing ASTs...");
    const allFiles = getAllFiles(repoPath, ANALYZABLE_EXTENSIONS);
    const parsedFiles = allFiles
      .map((f) => parseFile(f))
      .filter((f): f is NonNullable<typeof f> => f !== null);
    parseSpinner.succeed(`Parsed ${parsedFiles.length} / ${allFiles.length} files`);
    if (allFiles.length - parsedFiles.length > 0)
      detail(`Skipped ${allFiles.length - parsedFiles.length} unparseable files`);

    step(4, 13, "Extracting API endpoints");
    const extractSpinner = spinner("Running backend extractors...");
    const endpoints = await runExtractors(parsedFiles, detection);
    extractSpinner.succeed(`Found ${endpoints.length} endpoints`);

    // ── Step 4b: Extract UI pages ─────────────────────────────────────────────
    step(4, 13, "Extracting UI pages");
    const uiSpinner = spinner("Running UI extractors...");
    const routerPages = extractPages(parsedFiles, detection, repoPath);
    const reactPages = extractReactLocators(parsedFiles);
    const vuePages = extractVueLocators(parsedFiles);
    const angularPages = extractAngularLocators(parsedFiles);
    const rawPages: ExtractedPage[] = [
      ...routerPages,
      ...reactPages,
      ...vuePages,
      ...angularPages,
    ];

    // Merge pages that share the same route (e.g. router extractor + react locator extractor
    // both produce a page for /login — combine their locators, formFlows, and navLinks).
    // Pages whose route resolves to an absolute filesystem path (unmatched App Router files)
    // are dropped — they carry no meaningful route.
    const pagesByRoute = new Map<string, ExtractedPage>();
    for (const page of rawPages) {
      const route = page.route;
      // Drop pages that couldn't resolve to a URL path
      if (!route || /^(\/Users\/|\/home\/|[A-Z]:[/\\])/.test(route)) continue;
      const existing = pagesByRoute.get(route);
      if (!existing) {
        pagesByRoute.set(route, { ...page });
      } else {
        // Merge: prefer non-generic title, union locators/formFlows/navLinks
        const seenLocPw = new Set(existing.locators.map((l) => l.playwrightCode));
        const mergedLocators = [
          ...existing.locators,
          ...page.locators.filter((l) => !seenLocPw.has(l.playwrightCode)),
        ];
        const seenNavHref = new Set(existing.navigationLinks.map((n) => n.href));
        const mergedNavLinks = [
          ...existing.navigationLinks,
          ...page.navigationLinks.filter((n) => !seenNavHref.has(n.href)),
        ];
        pagesByRoute.set(route, {
          ...existing,
          // Prefer non-"page" / non-"index" titles from higher-quality sources
          title: ["page", "index"].includes(existing.title.toLowerCase())
            ? page.title
            : existing.title,
          authRequired: existing.authRequired || page.authRequired,
          roles: Array.from(new Set([...existing.roles, ...page.roles])),
          locators: mergedLocators,
          formFlows: existing.formFlows.length > 0 ? existing.formFlows : page.formFlows,
          navigationLinks: mergedNavLinks,
        });
      }
    }
    const allPages: ExtractedPage[] = Array.from(pagesByRoute.values());
    uiSpinner.succeed(`Found ${allPages.length} pages`);

    // ── Step 5: Auth detection ────────────────────────────────────────────────
    step(5, 13, "Detecting authentication");
    const authSpinner = spinner("Scanning auth patterns...");
    const auth = await detectAuth(parsedFiles, endpoints, repoPath);
    if (auth) {
      authSpinner.succeed(`Auth detected: ${auth.tokenType}`);
      detail(`Login endpoint : ${auth.loginEndpoint}`);
      detail(`Body format    : ${auth.loginBodyFormat}`);
      if (auth.defaultEmail)    detail(`Seed email     : ${auth.defaultEmail}`);
      if (auth.defaultPassword) detail(`Seed password  : ${auth.defaultPassword}`);
    } else {
      authSpinner.succeed("No auth detected — all endpoints appear public");
    }

    // ── Step 6: Harvest configs + build blueprint ─────────────────────────────
    step(6, 13, "Building test blueprint");
    const blueprintSpinner = spinner("Assembling blueprint...");
    const configs = await harvestConfigs(repoPath);
    const blueprint = buildBlueprint(
      repoUrl,
      detection,
      endpoints,
      allPages,
      auth,
      configs
    );
    blueprintSpinner.succeed(
      `Blueprint ready — ${blueprint.endpoints.length} endpoints, ${blueprint.pages.length} pages`
    );

    // ── Step 6b: Write blueprint.json to output dir ───────────────────────────
    await ensureDir(options.output);
    const blueprintPath = path.join(options.output, "blueprint.json");
    fs.writeFileSync(blueprintPath, JSON.stringify(blueprint, null, 2), "utf-8");
    detail(`Blueprint JSON → ${blueprintPath}`);

    // ── Step 6c: Auto-select output formats based on what was detected ────────
    // Only apply auto-selection when the user has NOT passed explicit --only-* flags
    // and is using the default format string (both formats requested).
    const userExplicitFormat = options.onlyApi || options.onlyUi ||
      (formats.length === 1); // single explicit format passed

    if (!userExplicitFormat) {
      const hasUI  = blueprint.pages.length > 0;
      const hasAPI = blueprint.endpoints.length > 0;

      if (hasAPI && !hasUI) {
        doPlaywright = false;
        doPostman    = true;
        info("Format auto-selected: postman  (API-only repo — 0 UI pages)");
      } else if (hasUI && !hasAPI) {
        doPlaywright = true;
        doPostman    = false;
        info("Format auto-selected: playwright  (UI-only repo — 0 API endpoints)");
      } else if (hasUI && hasAPI) {
        doPlaywright = true;
        doPostman    = false;
        info("Format auto-selected: playwright  (full-stack — covers both API + UI)");
      } else {
        doPlaywright = true;
        doPostman    = false;
        info("Format auto-selected: playwright  (fallback — may be CLI/batch/WS repo)");
      }
    }

    // ── Step 7: Chunk blueprint ───────────────────────────────────────────────
    step(7, 13, "Chunking blueprint");
    let chunks = chunkBlueprint(blueprint);
    if (options.domain) {
      chunks = chunks.filter((c) => c.domain === options.domain);
      detail(`Filtered to domain: ${options.domain}`);
    }
    info(`${chunks.length} chunks created  (1 LLM call per chunk)`);
    chunks.forEach((c, i) =>
      detail(`  chunk ${String(i+1).padStart(2,'0')}  ${c.domain}  →  ${c.outputFileName}  (${c.endpoints.length} ep, ${c.pages.length} pg)`)
    );

    // ── Step 7b: Pre-dump ALL chunks before any LLM calls ────────────────────
    await ensureDir(options.output);
    const chunksDir = path.join(options.output, "chunks");
    await ensureDir(chunksDir);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkFileName = `chunk-${String(i + 1).padStart(2, "0")}-${chunk.domain}.json`;
      const chunkDumpPath = path.join(chunksDir, chunkFileName);
      const chunkDump = {
        index: i + 1,
        total: chunks.length,
        domain: chunk.domain,
        outputFileName: chunk.outputFileName,
        hasPages: chunk.hasPages,
        endpointCount: chunk.endpoints.length,
        pageCount: chunk.pages.length,
        llmUserMessage: buildPlaywrightUserMessage(chunk, blueprint.endpoints),
        chunk,
      };
      fs.writeFileSync(chunkDumpPath, JSON.stringify(chunkDump, null, 2), "utf-8");
    }
    detail(`Chunks pre-dumped to: ${chunksDir}`);

    // ── Dry-run: print detailed validation report and exit ────────────────────
    if (options.dryRun) {
      log(`\n${'═'.repeat(70)}`);
      log(`DRY-RUN VALIDATION REPORT — ${chunks.length} chunks`);
      log('═'.repeat(70));

      // Auth summary
      log(`\n AUTH DETECTED:`);
      if (auth) {
        log(`  Type        : ${auth.tokenType}`);
        log(`  Login       : ${auth.loginEndpoint}`);
        log(`  Body format : ${auth.loginBodyFormat}`);
        log(`  Email field : ${auth.credentialsFields.emailField}`);
        log(`  Pass field  : ${auth.credentialsFields.passwordField}`);
        if (auth.defaultEmail)    log(`  Seed email  : ${auth.defaultEmail}`);
        if (auth.defaultPassword) log(`  Seed pass   : ${auth.defaultPassword}`);
        if (auth.authCookieName)  log(`  Cookie name : ${auth.authCookieName}`);
      } else {
        log(`  (none — all endpoints appear public)`);
      }

      log(`\n CHUNKS:`);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const issues: string[] = [];
        log(`\n  [${ i + 1 }/${ chunks.length }] ${chunk.domain}  →  ${chunk.outputFileName}`);

        // Endpoints
        if (chunk.endpoints.length === 0) {
          log(`    Endpoints : (none)`);
        } else {
          log(`    Endpoints (${chunk.endpoints.length}):`);
          for (const ep of chunk.endpoints) {
            const lock  = ep.authRequired ? '🔒' : '🔓';
            const parts: string[] = [`    ${lock} ${ep.method.padEnd(6)} ${ep.path}`];

            if (ep.pathParams?.length) {
              parts.push(`  pathParams=[${ep.pathParams.map(p => p.name).join(', ')}]`);
            }
            if (ep.queryParams?.length) {
              parts.push(`  query=[${ep.queryParams.map(p => `${p.name}${p.required ? '*' : ''}`).join(', ')}]`);
            }
            if (ep.requestBody) {
              const fields = ep.requestBody.fields.length
                ? ep.requestBody.fields.map(f => `${f.name}${f.required ? '*' : ''}`).join(', ')
                : '(empty body — ⚠️  inferred but no fields parsed)';
              parts.push(`  body(${ep.requestBody.source})=[${fields}]`);
              if (ep.requestBody.fields.length === 0
                  && (ep.method === 'PATCH' || ep.method === 'PUT' || ep.method === 'POST')) {
                issues.push(`  ⚠️  ${ep.method} ${ep.path}: requestBody present but 0 fields extracted — check parser`);
              }
            }
            log(parts.join(''));
          }
        }

        // Pages
        if (chunk.pages.length > 0) {
          log(`    Pages (${chunk.pages.length}):`);
          for (const pg of chunk.pages) {
            const locCount = pg.locators?.length ?? 0;
            log(`      📄 ${pg.route}  (title: "${pg.title ?? '?'}", locators: ${locCount})`);
            if (locCount === 0) {
              issues.push(`  ⚠️  ${pg.route}: no locators extracted — LLM will guess selectors`);
            }
          }
        }

        // Issues
        if (issues.length) {
          log(`    ISSUES:`);
          for (const iss of issues) log(iss);
        } else {
          log(`    ✅ no issues`);
        }
      }

      log(`\n${'═'.repeat(70)}`);
      log(`Chunks written to: ${chunksDir}`);
      log(`Run without --dry-run to invoke the LLM and generate spec files.`);
      log('═'.repeat(70));
      return;
    }

    // ── Step 8: Generate per chunk — sequential ───────────────────────────────
    step(8, 13, `Generating tests  (${chunks.length} LLM calls)`);
    const tempDir = path.join(os.tmpdir(), `smokeforge-validate-${Date.now()}`);
    await ensureDir(tempDir);

    const playwrightSpecs: Array<{ chunk: BlueprintChunk; code: string }> = [];
    const postmanCollections: Array<{ chunk: BlueprintChunk; json: string }> = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // ── Print chunk header ───────────────────────────────────────────────
      console.log();
      info(`Chunk [${i + 1}/${chunks.length}]  ${chunk.domain}  →  ${chunk.outputFileName}`);
      if (chunk.endpoints.length > 0) {
        for (const ep of chunk.endpoints) {
          const lock = ep.authRequired ? "🔒" : "🔓";
          detail(`  ${lock} ${ep.method.padEnd(6)} ${ep.path}`);
        }
      }
      if (chunk.pages.length > 0) {
        for (const pg of chunk.pages) {
          detail(`  📄 ${pg.route}`);
        }
      }

      const chunkSpinner = spinner(
        `[${i + 1}/${chunks.length}] Calling LLM for: ${chunk.domain}`
      );

      // (a) Playwright
      if (doPlaywright) {
        const code = await generatePlaywrightWithRetry(chunk, tempDir, blueprint.endpoints);
        playwrightSpecs.push({ chunk, code });
      }

      // (b) Postman
      if (doPostman) {
        const json = await generatePostmanWithRetry(chunk);
        postmanCollections.push({ chunk, json });
      }

      chunkSpinner.succeed(
        `[${i + 1}/${chunks.length}] ${chunk.domain}  ✔`
      );
    }

    // Clean up temp validation dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    // ── Step 9: Write Playwright output ───────────────────────────────────────
    if (doPlaywright && playwrightSpecs.length > 0) {
      step(9, 13, "Writing Playwright output");
      const writeSpinner = spinner("Writing spec files...");
      await writePlaywrightOutput(chunks, playwrightSpecs, options.output, auth, options.baseUrl);
      writeSpinner.succeed(`${playwrightSpecs.length} spec files written`);
      detail(`→ ${path.join(options.output, "playwright", "smoke")}`);
    }

    // ── Step 10: Write Postman output ─────────────────────────────────────────
    if (doPostman && postmanCollections.length > 0) {
      step(10, 13, "Writing Postman output");
      const writeSpinner = spinner("Writing collection...");
      await writePostmanOutput(postmanCollections, options.output, auth, options.baseUrl);
      writeSpinner.succeed("Postman collection written");
      detail(`→ ${path.join(options.output, "postman")}`);
    }

    // ── Step 11: Generate report ──────────────────────────────────────────────
    step(11, 13, "Generating report");
    const reportSpinner = spinner("Writing smokeforge-report.json...");
    const report = await generateReport(blueprint, options.output);
    reportSpinner.succeed("Report written");

    // ── Step 12: Print summary ────────────────────────────────────────────────
    const lowConfidenceCount =
      report.summary.lowConfidence + report.summary.todos;

    printSummary(
      repoName,
      frameworkNames,
      blueprint.endpoints.length,
      blueprint.pages.length,
      playwrightSpecs.length,
      postmanCollections.length,
      lowConfidenceCount,
      options.output
    );
  } finally {
    // ── Step 13: Cleanup cloned repo ──────────────────────────────────────────
    step(13, 13, "Cleaning up");
    const cleanSpinner = spinner("Removing cloned repo from temp dir...");
    await cleanup();
    cleanSpinner.succeed("Temp files removed");
  }
}
