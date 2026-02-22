#!/usr/bin/env node
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
// Load .env from the smokeforge root (works when running via `node dist/cli/index.js`)
dotenvConfig({ path: path.resolve(__dirname, "../../.env") });
import { Command } from "commander";
import { generateCommand } from "./commands/generate";
import { analyzeCommand } from "./commands/analyze";

const program = new Command();

program
  .name("smokeforge")
  .description("GenAI-powered smoke test generator for JS/TS applications")
  .version("1.0.0");

// ─── generate command ─────────────────────────────────────────────────────────

program
  .command("generate <repo-url>")
  .description("Generate smoke tests from a GitHub repository")
  .option("-o, --output <dir>", "Output directory", "./smokeforge-output")
  .option(
    "-f, --format <formats>",
    "Output formats (playwright,postman)",
    "playwright,postman"
  )
  .option(
    "-b, --base-url <url>",
    "Target application base URL",
    "http://localhost:3000"
  )
  .option("--framework <name>", "Override framework detection")
  .option("--only-api", "Generate API tests only (skip UI)")
  .option("--only-ui", "Generate UI tests only (skip API)")
  .option("--domain <name>", "Generate tests for specific domain only")
  .option("-v, --verbose", "Verbose output")
  .option(
    "--no-install",
    "Skip npm install in cloned repo (faster but lower schema accuracy)"
  )
  .option(
    "--dry-run",
    "Analyze repo and dump chunks without calling the LLM (no API key needed)"
  )
  .action(generateCommand);

// ─── analyze command ──────────────────────────────────────────────────────────

program
  .command("analyze <repo-url>")
  .description(
    "Analyze a repository and output the test blueprint JSON (no test generation)"
  )
  .option("-o, --output <file>", "Output file for blueprint JSON", "./blueprint.json")
  .action(analyzeCommand);

// ─── Parse argv ───────────────────────────────────────────────────────────────

program.parse(process.argv);
