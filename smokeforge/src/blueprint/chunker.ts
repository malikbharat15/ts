import type {
  TestBlueprint,
  ExtractedEndpoint,
  ExtractedPage,
  AuthConfig,
  TestDataHints,
} from "./types";

// ─── Public interface ─────────────────────────────────────────────────────────

export interface BlueprintChunk {
  domain: string;
  hasPages: boolean;
  endpoints: ExtractedEndpoint[];
  pages: ExtractedPage[];
  auth: AuthConfig | null;
  testDataHints: TestDataHints;
  outputFileName: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ENDPOINTS_PER_CHUNK = 5; // Postman items with pre-request FK scripts are ~1800 chars each; 5×1800=9KB ≈ 2300 tokens, safely under 8192
const MAX_PAGES_PER_CHUNK = 10;

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
