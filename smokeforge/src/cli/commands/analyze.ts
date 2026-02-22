import * as path from "path";
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
import type { ExtractedPage } from "../../blueprint/types";
import { buildBlueprint } from "../../blueprint/builder";
import { log, warn, error as logError, spinner } from "../../utils/logger";

// ─── Main export ──────────────────────────────────────────────────────────────

export async function analyzeCommand(
  repoUrl: string,
  options: { output: string }
): Promise<void> {
  const outputFile = path.resolve(options.output);

  // ── Step 1: Clone repo ───────────────────────────────────────────────────────
  const cloneSpinner = spinner(`Cloning ${repoUrl}...`);
  let cloneResult: Awaited<ReturnType<typeof cloneRepo>>;
  try {
    cloneResult = await cloneRepo(repoUrl);
    cloneSpinner.succeed(`Cloned to ${cloneResult.repoPath}`);
  } catch (err) {
    cloneSpinner.fail(`Clone failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const { repoPath, repoName, cleanup } = cloneResult;

  try {
    // ── Step 2: Detect frameworks ──────────────────────────────────────────────
    const detectSpinner = spinner("Detecting frameworks...");
    const detection = await detect(repoPath);
    const primary = detection.packages[0];
    const backendFrameworks = primary?.backendFrameworks ?? [];
    const frontendFrameworks = primary?.frontendFrameworks ?? [];
    const frameworkNames = [...backendFrameworks, ...frontendFrameworks];
    detectSpinner.succeed(
      `Frameworks: ${frameworkNames.join(", ") || "unknown"}`
    );

    // ── Step 3: Parse all source files ─────────────────────────────────────────
    const parseSpinner = spinner("Parsing source files...");
    const allFiles = getAllFiles(repoPath, ANALYZABLE_EXTENSIONS);
    const parsedFiles = allFiles
      .map((f) => parseFile(f))
      .filter((f): f is NonNullable<typeof f> => f !== null);
    parseSpinner.succeed(`Parsed ${parsedFiles.length} files`);

    // ── Step 4: Extract endpoints ──────────────────────────────────────────────
    const extractSpinner = spinner("Extracting endpoints...");
    const endpoints = await runExtractors(parsedFiles, detection);
    extractSpinner.succeed(`Extracted ${endpoints.length} endpoints`);

    // ── Step 4b: Extract UI pages ─────────────────────────────────────────────
    const uiSpinner = spinner("Extracting UI pages...");
    const routerPages = extractPages(parsedFiles, detection, repoPath);
    const reactPages = extractReactLocators(parsedFiles);
    const vuePages = extractVueLocators(parsedFiles);
    const angularPages = extractAngularLocators(parsedFiles);
    const allPages: ExtractedPage[] = [
      ...routerPages,
      ...reactPages,
      ...vuePages,
      ...angularPages,
    ];
    uiSpinner.succeed(`Extracted ${allPages.length} pages`);

    // ── Step 5: Auth detection ─────────────────────────────────────────────────
    const authSpinner = spinner("Detecting authentication...");
    const auth = await detectAuth(parsedFiles, endpoints, repoPath);
    authSpinner.succeed(
      auth ? `Auth detected: ${auth.tokenType}` : "No auth detected"
    );

    // ── Step 6: Harvest configs + build blueprint ──────────────────────────────
    const blueprintSpinner = spinner("Building test blueprint...");
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
      `Blueprint: ${blueprint.endpoints.length} endpoints, ${blueprint.pages.length} pages`
    );

    // ── Write blueprint JSON ───────────────────────────────────────────────────
    const outputDir = path.dirname(outputFile);
    await ensureDir(outputDir);
    writeFile(outputFile, JSON.stringify(blueprint, null, 2));

    // ── Print summary ──────────────────────────────────────────────────────────
    const line = "─────────────────────────────────────";
    log(line);
    log(`📁 Repository:      ${repoName}`);
    log(`🔍 Frameworks:      ${frameworkNames.join(", ") || "unknown"}`);
    log(`🔗 Endpoints found: ${blueprint.endpoints.length}`);
    log(`🖥️  Pages found:     ${blueprint.pages.length}`);
    log(`🔐 Auth config:     ${auth ? "yes" : "no"}`);
    log(`📄 Blueprint written to: ${outputFile}`);
    log(line);
    log("Run `smokeforge generate` to generate tests from this blueprint.");

    if (blueprint.endpoints.length === 0) {
      warn(
        "No endpoints were extracted. Check that the framework is supported and source files are present."
      );
    }
  } catch (err) {
    logError(`Analysis failed: ${(err as Error).message}`);
    await cleanup();
    process.exit(1);
  } finally {
    await cleanup();
  }
}
