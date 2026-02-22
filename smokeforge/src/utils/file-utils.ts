// src/utils/file-utils.ts

import * as fs from "fs";
import * as path from "path";
import { SKIP_DIRS } from "../analysis/parser";

/**
 * Recursively finds all files with the given extensions under dir.
 * Skips directories whose basename is in SKIP_DIRS.
 * Returns absolute file paths.
 */
export function getAllFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          results.push(path.join(current, entry.name));
        }
      }
    }
  }

  walk(path.resolve(dir));
  return results;
}

/**
 * Given a relative import path and the file it appears in, resolves to an
 * absolute file path by trying multiple extensions.
 * Returns null if no matching file is found.
 */
export function resolveImportPath(importPath: string, fromFile: string): string | null {
  if (!importPath.startsWith(".")) return null;

  const base = path.resolve(path.dirname(fromFile), importPath);
  const candidates = [
    base + ".ts",
    base + ".tsx",
    base + ".js",
    base + ".jsx",
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
    path.join(base, "index.tsx"),
    path.join(base, "index.jsx"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Reads and parses a JSON file.
 * Returns null on any error.
 */
export function readJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Creates the directory and all parent directories if they don't exist.
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Writes content to filePath, creating parent directories automatically.
 */
export function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
}
