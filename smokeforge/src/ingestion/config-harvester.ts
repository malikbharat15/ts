// src/ingestion/config-harvester.ts

import * as fs from "fs";
import * as path from "path";
import { readJson, getAllFiles } from "../utils/file-utils";

export interface HarvestedConfigs {
  dotEnvExample: Record<string, string> | null;
  openApiSpec: unknown | null;
  nextConfig: unknown | null;
  viteConfig: unknown | null;
  tsconfigPaths: Record<string, string[]>;
  packageJsons: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function findOpenApiSpec(repoPath: string): unknown | null {
  const candidates = [
    "openapi.json",
    "openapi.yaml",
    "openapi.yml",
    "swagger.json",
    "swagger.yaml",
    "swagger.yml",
    "docs/openapi.json",
    "docs/openapi.yaml",
    "docs/openapi.yml",
    "docs/swagger.json",
    "docs/swagger.yaml",
    "docs/swagger.yml",
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(repoPath, candidate);
    if (!fs.existsSync(fullPath)) continue;

    // JSON
    if (fullPath.endsWith(".json")) {
      const parsed = readJson<unknown>(fullPath);
      if (parsed) return parsed;
    }

    // YAML — return raw string content (no yaml parser dependency)
    const content = readFileSafe(fullPath);
    if (content) return content;
  }

  return null;
}

function mergeTsconfigPaths(repoPath: string): Record<string, string[]> {
  const merged: Record<string, string[]> = {};

  // Find all tsconfig*.json files (non-recursive — stay at root level for tsconfig files)
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(repoPath, { withFileTypes: true });
  } catch {
    return merged;
  }

  const tsconfigFiles = entries
    .filter((e) => e.isFile() && e.name.startsWith("tsconfig") && e.name.endsWith(".json"))
    .map((e) => path.join(repoPath, e.name));

  // Also check common subdirectories
  const subDirs = ["packages", "apps", "libs", "src"];
  for (const sub of subDirs) {
    const subPath = path.join(repoPath, sub);
    if (!fs.existsSync(subPath)) continue;
    try {
      const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
      for (const e of subEntries) {
        if (e.isFile() && e.name.startsWith("tsconfig") && e.name.endsWith(".json")) {
          tsconfigFiles.push(path.join(subPath, e.name));
        }
      }
    } catch {
      // ignore
    }
  }

  for (const tsconfigPath of tsconfigFiles) {
    const tsconfig = readJson<Record<string, unknown>>(tsconfigPath);
    if (!tsconfig) continue;
    const compilerOptions = tsconfig["compilerOptions"] as Record<string, unknown> | undefined;
    if (!compilerOptions) continue;
    const paths = compilerOptions["paths"] as Record<string, string[]> | undefined;
    if (!paths || typeof paths !== "object") continue;
    for (const [alias, targets] of Object.entries(paths)) {
      if (!merged[alias]) {
        merged[alias] = targets;
      } else {
        // Merge without duplicates
        for (const t of targets) {
          if (!merged[alias].includes(t)) merged[alias].push(t);
        }
      }
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function harvestConfigs(repoPath: string): Promise<HarvestedConfigs> {
  const abs = path.resolve(repoPath);

  // .env.example
  let dotEnvExample: Record<string, string> | null = null;
  try {
    const envExamplePath = path.join(abs, ".env.example");
    if (fs.existsSync(envExamplePath)) {
      const content = readFileSafe(envExamplePath);
      if (content) dotEnvExample = parseDotEnv(content);
    }
  } catch {
    dotEnvExample = null;
  }

  // OpenAPI / Swagger spec
  let openApiSpec: unknown | null = null;
  try {
    openApiSpec = findOpenApiSpec(abs);
  } catch {
    openApiSpec = null;
  }

  // next.config.js / next.config.ts — return raw file content as string
  let nextConfig: unknown | null = null;
  try {
    for (const name of ["next.config.ts", "next.config.js", "next.config.mjs"]) {
      const p = path.join(abs, name);
      if (fs.existsSync(p)) {
        nextConfig = readFileSafe(p);
        break;
      }
    }
  } catch {
    nextConfig = null;
  }

  // vite.config.ts / vite.config.js — return raw file content as string
  let viteConfig: unknown | null = null;
  try {
    for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mts"]) {
      const p = path.join(abs, name);
      if (fs.existsSync(p)) {
        viteConfig = readFileSafe(p);
        break;
      }
    }
  } catch {
    viteConfig = null;
  }

  // tsconfig paths — merge all tsconfig*.json
  let tsconfigPaths: Record<string, string[]> = {};
  try {
    tsconfigPaths = mergeTsconfigPaths(abs);
  } catch {
    tsconfigPaths = {};
  }

  // All package.json files
  const packageJsons: Record<string, unknown>[] = [];
  try {
    const pkgFiles = getAllFiles(abs, [".json"]).filter((f) =>
      path.basename(f) === "package.json"
    );
    for (const pkgFile of pkgFiles) {
      const parsed = readJson<Record<string, unknown>>(pkgFile);
      if (parsed) packageJsons.push(parsed);
    }
  } catch {
    // return empty array
  }

  return {
    dotEnvExample,
    openApiSpec,
    nextConfig,
    viteConfig,
    tsconfigPaths,
    packageJsons,
  };
}
