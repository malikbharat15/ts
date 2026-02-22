import * as path from "path";
import type { BlueprintChunk } from "../blueprint/chunker";
import type { AuthConfig } from "../blueprint/types";
import { ensureDir, writeFile } from "../utils/file-utils";
import { validatePostman } from "./validator";

// ─── Internal types ───────────────────────────────────────────────────────────

interface PostmanVariable {
  key: string;
  value: string;
  enabled: boolean;
}

interface PostmanEvent {
  listen: string;
  script: { exec: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

interface PostmanRequest {
  name: string;
  event?: PostmanEvent[];
  [key: string]: unknown;
}

interface PostmanFolder {
  name: string;
  item: (PostmanRequest | PostmanFolder)[];
  [key: string]: unknown;
}

interface PostmanCollection {
  info: {
    name: string;
    schema: string;
    [key: string]: unknown;
  };
  variable: PostmanVariable[];
  item: PostmanFolder[];
  [key: string]: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const POSTMAN_V21_SCHEMA =
  "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

const REQUIRED_VARIABLES: PostmanVariable[] = [
  { key: "BASE_URL", value: "http://localhost:3000", enabled: true },
  { key: "AUTH_TOKEN", value: "", enabled: true },
  { key: "LAST_CREATED_ID", value: "", enabled: true },
  { key: "SMOKE_TEST_EMAIL", value: "smoketest@example.com", enabled: true },
  { key: "SMOKE_TEST_PASSWORD", value: "SmokeTest123!", enabled: true },
];

// ─── Merge helpers ────────────────────────────────────────────────────────────

function parseCollectionSafe(json: string): PostmanCollection | null {
  try {
    return JSON.parse(json) as PostmanCollection;
  } catch {
    return null;
  }
}

/**
 * Ensures all REQUIRED_VARIABLES exist in the variable array.
 * Preserves any existing values; only adds missing keys.
 */
function mergeVariables(
  existing: PostmanVariable[]
): PostmanVariable[] {
  const map = new Map<string, PostmanVariable>(
    existing.map((v) => [v.key, v])
  );
  for (const req of REQUIRED_VARIABLES) {
    if (!map.has(req.key)) {
      map.set(req.key, req);
    }
  }
  return Array.from(map.values());
}

/**
 * Finds folders named "Auth" (case-insensitive) across all collections
 * and ensures the login request is promoted to the front.
 */
function hoistLoginRequest(folders: PostmanFolder[]): PostmanFolder[] {
  return folders.map((folder) => {
    if (folder.name.toLowerCase() !== "auth") return folder;

    const items = [...folder.item];
    const loginIdx = items.findIndex((item) =>
      /login|signin|sign.in/i.test(item.name)
    );
    if (loginIdx > 0) {
      const [loginItem] = items.splice(loginIdx, 1);
      items.unshift(loginItem);
    }
    return { ...folder, item: items };
  });
}

/**
 * Merges multiple Postman collection chunks into one unified collection.
 */
function mergeCollections(
  chunks: Array<{ chunk: BlueprintChunk; json: string }>
): PostmanCollection {
  const allFolders: PostmanFolder[] = [];

  for (const { chunk, json } of chunks) {
    const col = parseCollectionSafe(json);
    if (!col) continue;

    if (Array.isArray(col.item)) {
      for (const folder of col.item) {
        // Check if a folder with this domain already exists
        const existingIdx = allFolders.findIndex(
          (f) => f.name.toLowerCase() === folder.name.toLowerCase()
        );
        if (existingIdx >= 0) {
          // Merge requests into existing folder
          allFolders[existingIdx].item.push(
            ...(folder.item ?? [])
          );
        } else {
          allFolders.push(folder as PostmanFolder);
        }
      }
    } else {
      // No folders — wrap all items in a domain folder
      allFolders.push({
        name: chunk.domain,
        item: (col.item as PostmanRequest[]) ?? [],
      });
    }
  }

  // Determine collection name from first available chunk
  const firstChunk = chunks[0]?.chunk;
  const collectionName = firstChunk
    ? `${firstChunk.domain} Smoke Tests`
    : "Smoke Tests";

  // Detect token response path from auth config (passed via caller in writePostmanOutput)
  // Default to "accessToken" — the most common JWT field name
  const tokenPath = "accessToken";

  return {
    info: {
      name: collectionName,
      schema: POSTMAN_V21_SCHEMA,
    },
    variable: mergeVariables([]),
    item: fixTokenExtractionInLoginScripts(hoistLoginRequest(allFolders), tokenPath),
  };
}

// ─── Environment file ─────────────────────────────────────────────────────────

/**
 * After merge, walk every Login request and ensure its test script sets the
 * token on BOTH pm.environment AND pm.collectionVariables.
 * This is a post-generation safety net: if the LLM used collectionVariables.set
 * we upgrade it here so Newman env-scope picks it up.
 */
function fixTokenExtractionInLoginScripts(
  folders: PostmanFolder[],
  tokenResponsePath: string
): PostmanFolder[] {
  return folders.map((folder) => ({
    ...folder,
    item: folder.item.map((item) => {
      // Recurse into nested folders
      if ("item" in item && Array.isArray((item as PostmanFolder).item)) {
        return fixTokenExtractionInLoginScripts([item as PostmanFolder], tokenResponsePath)[0];
      }
      if (!/login|signin|sign.in/i.test((item as PostmanRequest).name ?? "")) return item;
      const req = item as PostmanRequest;
      const events: PostmanEvent[] = req.event ?? [];
      const testEvent = events.find((e) => e.listen === "test");
      if (!testEvent) return item;

      // Replace or inject token extraction lines
      const exec: string[] = testEvent.script?.exec ?? [];
      const cleaned = exec.filter(
        (line: string) =>
          !line.includes("collectionVariables.set") &&
          !line.includes("environment.set") &&
          !/^const token\s*=/.test(line.trim())
      );
      const tokenLines = [
        `const token = pm.response.json().${tokenResponsePath};`,
        `if (token) {`,
        `  pm.environment.set("AUTH_TOKEN", token);`,
        `  pm.collectionVariables.set("AUTH_TOKEN", token);`,
        `}`,
        `const refreshToken = pm.response.json().refreshToken;`,
        `if (refreshToken) {`,
        `  pm.environment.set("REFRESH_TOKEN", refreshToken);`,
        `  pm.collectionVariables.set("REFRESH_TOKEN", refreshToken);`,
        `}`,
      ];
      return {
        ...req,
        event: events.map((e) =>
          e.listen === "test"
            ? { ...e, script: { ...e.script, exec: [...cleaned, ...tokenLines] } }
            : e
        ),
      };
    }),
  }));
}

function buildEnvironmentFile(auth: AuthConfig | null, baseUrl = "http://localhost:3000"): string {
  return JSON.stringify(
    {
      name: "Smoke Test Environment",
      _postman_variable_scope: "environment",
      values: [
        { key: "BASE_URL", value: baseUrl, enabled: true },
        // AUTH_TOKEN intentionally NOT here — set dynamically by Login test script
        // so it doesn't override pm.environment.set() called in the test script
        { key: "SMOKE_TEST_EMAIL", value: auth?.credentialsFields?.emailEnvVar ? "smoketest@example.com" : "smoketest@example.com", enabled: true },
        { key: "SMOKE_TEST_PASSWORD", value: "SmokeTest123!", enabled: true },
      ],
    },
    null,
    2
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function writePostmanOutput(
  generatedCollections: Array<{ chunk: BlueprintChunk; json: string }>,
  outputDir: string,
  auth: AuthConfig | null,
  baseUrl = "http://localhost:3000"
): Promise<void> {
  const postmanDir = path.join(outputDir, "postman");
  await ensureDir(postmanDir);

  // 1. Merge all chunk collections into one
  const merged = mergeCollections(generatedCollections);
  const mergedJson = JSON.stringify(merged, null, 2);

  // 2. Validate merged collection before writing
  const validation = validatePostman(mergedJson);
  if (!validation.valid) {
    // Log validation errors but still write — caller can decide how to handle
    for (const err of validation.errors) {
      process.stderr.write(`[smokeforge] postman validation warning: ${err}\n`);
    }
  }

  // 3. Write merged collection
  writeFile(
    path.join(postmanDir, "smoke-tests.postman_collection.json"),
    mergedJson
  );

  // 4. Write environment file (AUTH_TOKEN intentionally absent — set by Login script)
  writeFile(
    path.join(postmanDir, "smoke-env.postman_environment.json"),
    buildEnvironmentFile(auth, baseUrl)
  );
}
