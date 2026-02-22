// src/analysis/parser.ts

import { parse, TSESTree } from "@typescript-eslint/typescript-estree";
import { readFileSync } from "fs";

export interface ParsedFile {
  filePath: string;
  ast: TSESTree.Program;
  code: string;
}

export function parseFile(filePath: string): ParsedFile | null {
  try {
    const code = readFileSync(filePath, "utf-8");
    const ast = parse(code, {
      jsx: filePath.endsWith(".jsx") || filePath.endsWith(".tsx"),
      loc: true,
      range: true,
      tokens: false,
      comment: false,
      // CRITICAL: set this to allow TS syntax in .js files (common in config files)
      errorOnUnknownASTType: false,
    });
    return { filePath, ast, code };
  } catch (err) {
    // Log warning but never throw — bad files should not abort extraction
    console.warn(`[parser] Failed to parse ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

// File extensions to include in analysis
export const ANALYZABLE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"
];

// File extensions for Vue/Svelte — require special handling (extract <script> block first)
export const SCRIPT_BLOCK_EXTENSIONS = [".vue", ".svelte"];

// Directories to always skip
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  ".svelte-kit", "out", "coverage", ".turbo", ".cache", "storybook-static",
  "public", "static", "assets", ".vercel", ".netlify"
]);
