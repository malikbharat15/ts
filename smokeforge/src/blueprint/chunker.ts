import type {
  TestBlueprint,
  ExtractedEndpoint,
  ExtractedPage,
  AuthConfig,
  AuthType,
  TestDataHints,
} from "./types";

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * How this chunk should authenticate during test execution.
 *
 * - `storageState`   — browser-session auth (session_cookie, next_auth, OAuth/SSO, Clerk, etc.)
 *                      A shared `auth.setup.ts` Playwright global-setup should be emitted once.
 *                      Each spec file should declare `use: { storageState: './auth.state.json' }`.
 * - `bearer_inline`  — stateless API-token auth (JWT, API key, basic_auth).
 *                      Each spec file does a single `beforeAll` HTTP POST to the login endpoint
 *                      and attaches the token to subsequent requests.  No shared setup file needed.
 * - `none`           — the app has no authentication; all routes are publicly accessible.
 */
export type AuthStrategy = "storageState" | "bearer_inline" | "none";

export interface BlueprintChunk {
  domain: string;
  hasPages: boolean;
  endpoints: ExtractedEndpoint[];
  pages: ExtractedPage[];
  auth: AuthConfig | null;
  /** Resolved authentication strategy for this chunk — drives code generation. */
  authStrategy: AuthStrategy;
  testDataHints: TestDataHints;
  outputFileName: string;
}

// ─── Auth setup info ──────────────────────────────────────────────────────────

/**
 * Metadata needed to generate a shared Playwright `auth.setup.ts` file.
 * Present only when `authStrategy === "storageState"` for at least one chunk.
 */
export interface AuthSetupInfo {
  /** The auth strategy that requires shared browser state. */
  strategy: "storageState";
  /** Auth config extracted from the blueprint. */
  auth: AuthConfig;
  /** Suggested output file name for the global auth setup. */
  setupFileName: "auth.setup.ts";
  /** Path to the state file that specs will reference. */
  storageStateFile: "./auth.state.json";
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ENDPOINTS_PER_CHUNK = 5; // Postman items with pre-request FK scripts are ~1800 chars each; 5×1800=9KB ≈ 2300 tokens, safely under 8192
const MAX_PAGES_PER_CHUNK = 10;

// ─── Auth strategy classification ────────────────────────────────────────────

/**
 * Auth types that require a real browser session (cookies / OAuth redirects).
 * These cannot be obtained via a simple API call, so we emit a shared
 * `auth.setup.ts` Playwright globalSetup and store the session in a file.
 */
const STORAGE_STATE_AUTH_TYPES = new Set<AuthType>([
  "session_cookie",
  "next_auth",
  "oauth_sso",
  "firebase",
  "supabase",
  "clerk",
]);

/**
 * Classifies the auth config into an `AuthStrategy` value.
 *
 * @param auth - The auth config from the blueprint, or `null` for public apps.
 * @returns The resolved strategy for test code generation.
 */
export function classifyAuthStrategy(auth: AuthConfig | null): AuthStrategy {
  if (auth === null) return "none";
  if (STORAGE_STATE_AUTH_TYPES.has(auth.tokenType)) return "storageState";
  return "bearer_inline";
}

/**
 * Returns the shared auth-setup metadata when the blueprint requires browser-session auth,
 * or `null` when no shared setup file is needed (bearer_inline / no auth).
 *
 * Usage: call once per blueprint before emitting output files.
 * If non-null, emit an `auth.setup.ts` Playwright global-setup file in addition to the spec files.
 *
 * @param blueprint - The fully-assembled test blueprint.
 * @returns `AuthSetupInfo` when `storageState` is needed, otherwise `null`.
 */
export function getAuthSetupInfo(blueprint: TestBlueprint): AuthSetupInfo | null {
  if (classifyAuthStrategy(blueprint.auth) !== "storageState") return null;
  // auth is guaranteed non-null when strategy is storageState
  return {
    strategy: "storageState",
    auth: blueprint.auth!,
    setupFileName: "auth.setup.ts",
    storageStateFile: "./auth.state.json",
  };
}

// ─── Domain extraction ────────────────────────────────────────────────────────

/**
 * Extracts a domain label from a route path.
 * Strategy: take the 3rd non-empty segment, ignoring common API prefixes.
 *   /api/v1/users/profile  → "users"
 *   /api/auth/login        → "auth"
 *   /users                 → "users"
 *   /                      → "root"
 */
function extractDomain(path: string): string {
  const segments = path.split("/").filter(Boolean);

  // Strip leading "api" and "v{n}" segments
  const meaningful = segments.filter((s) => !/^(api|v\d+)$/.test(s));

  if (meaningful.length === 0) return "root";

  // First meaningful segment is the domain
  const raw = meaningful[0].toLowerCase();

  // Strip dynamic parameter markers → normalize [userId] or :userId to the noun
  return raw.replace(/^\[(.+)\]$/, "$1").replace(/^:/, "");
}

/**
 * Generates a filename-safe domain label from a raw domain string.
 */
function safeDomainName(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

// ─── Endpoint grouping ────────────────────────────────────────────────────────

function groupEndpointsByDomain(
  endpoints: ExtractedEndpoint[]
): Map<string, ExtractedEndpoint[]> {
  const map = new Map<string, ExtractedEndpoint[]>();

  for (const ep of endpoints) {
    const domain = safeDomainName(extractDomain(ep.path));
    const list = map.get(domain) ?? [];
    list.push(ep);
    map.set(domain, list);
  }

  return map;
}

// ─── Page grouping ────────────────────────────────────────────────────────────

function groupPagesByDomain(
  pages: ExtractedPage[]
): Map<string, ExtractedPage[]> {
  const map = new Map<string, ExtractedPage[]>();

  for (const page of pages) {
    const domain = safeDomainName(extractDomain(page.route));
    const list = map.get(domain) ?? [];
    list.push(page);
    map.set(domain, list);
  }

  return map;
}

// ─── Chunk splitting ──────────────────────────────────────────────────────────

/**
 * Splits a list of endpoints into sub-chunks of at most MAX_ENDPOINTS_PER_CHUNK.
 * If there are >15 in one domain, splits alphabetically by path: domain-1, domain-2, …
 */
function splitEndpointChunks(
  domain: string,
  endpoints: ExtractedEndpoint[]
): Array<{ label: string; endpoints: ExtractedEndpoint[] }> {
  if (endpoints.length <= MAX_ENDPOINTS_PER_CHUNK) {
    return [{ label: domain, endpoints }];
  }

  // Sort alphabetically by path for deterministic splitting
  const sorted = [...endpoints].sort((a, b) => a.path.localeCompare(b.path));
  const result: Array<{ label: string; endpoints: ExtractedEndpoint[] }> = [];
  let partIndex = 1;

  for (let i = 0; i < sorted.length; i += MAX_ENDPOINTS_PER_CHUNK) {
    result.push({
      label: `${domain}-${partIndex}`,
      endpoints: sorted.slice(i, i + MAX_ENDPOINTS_PER_CHUNK),
    });
    partIndex++;
  }

  return result;
}

/**
 * Splits a list of pages into sub-chunks of at most MAX_PAGES_PER_CHUNK.
 */
function splitPageChunks(
  domain: string,
  pages: ExtractedPage[]
): Array<{ label: string; pages: ExtractedPage[] }> {
  if (pages.length <= MAX_PAGES_PER_CHUNK) {
    return [{ label: domain, pages }];
  }

  const sorted = [...pages].sort((a, b) => a.route.localeCompare(b.route));
  const result: Array<{ label: string; pages: ExtractedPage[] }> = [];
  let partIndex = 1;

  for (let i = 0; i < sorted.length; i += MAX_PAGES_PER_CHUNK) {
    result.push({
      label: `${domain}-${partIndex}`,
      pages: sorted.slice(i, i + MAX_PAGES_PER_CHUNK),
    });
    partIndex++;
  }

  return result;
}

// ─── Chunk assembly ───────────────────────────────────────────────────────────

function makeChunk(
  domain: string,
  endpoints: ExtractedEndpoint[],
  pages: ExtractedPage[],
  auth: AuthConfig | null,
  testDataHints: TestDataHints
): BlueprintChunk {
  // A chunk needs page/browser support if it has explicit UI pages OR
  // any endpoint that returns HTML (isPageRoute) — these need { page } fixtures
  const hasPages = pages.length > 0 || endpoints.some((e) => e.isPageRoute);
  const outputFileName = hasPages
    ? `${domain}.page.spec.ts`
    : `${domain}.api.spec.ts`;

  return {
    domain,
    hasPages,
    endpoints,
    pages,
    auth,
    authStrategy: classifyAuthStrategy(auth),
    testDataHints,
    outputFileName,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function chunkBlueprint(blueprint: TestBlueprint): BlueprintChunk[] {
  const { endpoints, pages, auth, testDataHints } = blueprint;
  const chunks: BlueprintChunk[] = [];

  // Group endpoints and pages by domain
  const endpointGroups = groupEndpointsByDomain(endpoints);
  const pageGroups = groupPagesByDomain(pages);

  // Collect all domains across both groups
  const allDomains = new Set<string>([
    ...endpointGroups.keys(),
    ...pageGroups.keys(),
  ]);

  for (const domain of Array.from(allDomains).sort()) {
    const domainEndpoints = endpointGroups.get(domain) ?? [];
    const domainPages = pageGroups.get(domain) ?? [];

    // Split endpoints into sub-chunks if needed
    const endpointSubChunks = splitEndpointChunks(domain, domainEndpoints);

    // Split pages into sub-chunks if needed
    const pageSubChunks = splitPageChunks(domain, domainPages);

    // The maximum number of sub-chunks across endpoints and pages
    const subChunkCount = Math.max(endpointSubChunks.length, pageSubChunks.length);

    for (let i = 0; i < subChunkCount; i++) {
      const epSlice = endpointSubChunks[i];
      const pgSlice = pageSubChunks[i];

      const label = epSlice?.label ?? pgSlice?.label ?? domain;
      const chunkEndpoints = epSlice?.endpoints ?? [];
      const chunkPages = pgSlice?.pages ?? [];

      // Only emit chunk if it has something in it
      if (chunkEndpoints.length > 0 || chunkPages.length > 0) {
        chunks.push(makeChunk(label, chunkEndpoints, chunkPages, auth, testDataHints));
      }
    }
  }

  // Edge case: if no domains at all, return empty array
  return chunks;
}
