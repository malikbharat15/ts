import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { ExtractedEndpoint, ExtractedPage, AuthConfig } from "./types";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface RankedSurface {
  type: "api" | "page";
  // api surfaces
  method?: string;
  path?: string;
  // page surfaces
  route?: string;
  title?: string;
  // shared
  rank: number;
  reason: string;
  authRequired: boolean;
}

export interface RankerResult {
  /** Filtered endpoints that the LLM deemed critical */
  endpoints: ExtractedEndpoint[];
  /** Filtered pages that the LLM deemed critical */
  pages: ExtractedPage[];
  /** Full ranked selections as returned by the LLM */
  rankedSurfaces: RankedSurface[];
  /** The full prompt sent to the LLM (for debug logging) */
  promptSent: string;
  /** The raw LLM response text (for debug logging) */
  rawResponse: string;
  /** App type inferred before ranking */
  appType: "api-only" | "ui-only" | "full-stack";
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-6";

function getAnthropicClient(): Anthropic {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

function inferAppType(
  endpoints: ExtractedEndpoint[],
  pages: ExtractedPage[]
): "api-only" | "ui-only" | "full-stack" {
  const hasApi = endpoints.length > 0;
  const hasUi  = pages.length > 0;
  if (hasApi && hasUi)  return "full-stack";
  if (hasUi && !hasApi) return "ui-only";
  return "api-only"; // includes CLI/API/batch repos
}

/**
 * Returns a compact, token-efficient representation of all surfaces
 * so the LLM can make a holistic decision.
 */
function buildSurfaceManifest(
  endpoints: ExtractedEndpoint[],
  pages: ExtractedPage[]
): string {
  const lines: string[] = [];

  if (endpoints.length > 0) {
    lines.push("=== API ENDPOINTS ===");
    for (const ep of endpoints) {
      const auth = ep.authRequired ? "🔒 auth-required" : "🔓 public";
      const body = ep.requestBody?.fields.length
        ? `  body=[${ep.requestBody.fields.map(f => `${f.name}${f.required ? "*" : ""}`).join(", ")}]`
        : "";
      lines.push(`  ${ep.method.padEnd(6)} ${ep.path}  (${auth})${body}`);
    }
  }

  if (pages.length > 0) {
    lines.push("");
    lines.push("=== UI PAGES ===");
    for (const pg of pages) {
      const auth = pg.authRequired ? "🔒 auth-required" : "🔓 public";
      const locCount = pg.locators?.length ?? 0;
      lines.push(`  PAGE  ${pg.route}  title="${pg.title}"  (${auth}, ${locCount} locators)`);
    }
  }

  return lines.join("\n");
}

/**
 * Build the system prompt for the criticality ranker.
 */
const RANKER_SYSTEM_PROMPT = `You are a senior QA engineer deciding what surfaces to smoke-test.

## Smoke testing philosophy
- A smoke test is a MINIMAL confidence check: "Is the app alive and working at the basic level?"
- Target < 3 minutes total runtime
- Select 5–10 surfaces MAXIMUM
- Prefer breadth (different domains/features) over depth (many variants of same feature)
- Happy-path only — no error cases

## Selection rules by app type

### API-only app
- Always include the auth login endpoint (if any) — nothing else works without it
- Pick 1 GET list endpoint per major business domain
- Pick 1 POST (create) endpoint for the most important resource
- Include health/status endpoint if present
- Include logout if present

### UI-only app  
- Pick the most important pages a user visits in a normal session
- Login page is mandatory if auth exists
- Dashboard / home page after login is mandatory
- Pick 1–2 pages per major feature area
- Prefer pages with known locators (more testable)

### Full-stack app (both UI pages AND API endpoints)
- NEVER test the same business function twice (once via UI, once via API)
- For each major domain: pick EITHER the UI page OR the API endpoint — not both
- Use page tests for flows where the UI adds unique value (login form, dashboard view, data tables)
- Use API tests for pure data operations with no distinctive UI (batch operations, secondary CRUD)
- Auth: test login via the UI page if one exists; otherwise test the API endpoint
- Always include at least 1 page test AND at least 1 API test if the app has both

## Output format
Return ONLY a JSON array — no markdown, no explanation, no text before or after the array.
Each element must be exactly:
{
  "type": "api" | "page",
  "method": "GET|POST|PUT|PATCH|DELETE",   // only for type=api
  "path": "/exact/path",                    // only for type=api
  "route": "/exact/route",                  // only for type=page
  "title": "Page title",                    // only for type=page
  "rank": 1,                               // 1 = highest priority
  "reason": "one sentence why this is critical",
  "authRequired": true | false
}`;

/**
 * Build the user message for the criticality ranker.
 */
function buildRankerUserMessage(
  appType: "api-only" | "ui-only" | "full-stack",
  manifest: string,
  auth: AuthConfig | null
): string {
  const authSummary = auth
    ? `Auth type: ${auth.tokenType}\nLogin endpoint: ${auth.loginEndpoint}`
    : "No authentication detected — all surfaces are public";

  const typeInstruction: Record<typeof appType, string> = {
    "api-only":    "This is an API-ONLY application (no UI pages). Select critical API endpoints.",
    "ui-only":     "This is a UI-ONLY application (no backend API). Select critical UI pages.",
    "full-stack":  "This is a FULL-STACK application with BOTH UI pages and API endpoints. You MUST include a mix of page tests and API tests. Do NOT test the same business function via both page and API.",
  };

  return `## APP TYPE
${typeInstruction[appType]}

## AUTH CONFIGURATION
${authSummary}

## FULL SURFACE AREA
${manifest}

## TASK
Select the 5–10 MOST CRITICAL surfaces to smoke-test, following the rules in the system prompt.
Return ONLY the JSON array — no explanation, no markdown.`;
}

/**
 * Parse the LLM JSON response into RankedSurface[].
 * Tries to extract a JSON array even if the LLM wrapped it in markdown fences.
 */
function parseRankedSurfaces(raw: string): RankedSurface[] {
  // Strip markdown fences
  let cleaned = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  // Sometimes the LLM puts text before/after the array — extract just the array
  const arrayMatch = cleaned.match(/(\[[\s\S]*\])/);
  if (arrayMatch) {
    cleaned = arrayMatch[1];
  }

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error("LLM response is not a JSON array");
  }
  return parsed as RankedSurface[];
}

/**
 * Match ranked API surfaces back to the original ExtractedEndpoint objects.
 * Uses path + method exact match, with fuzzy fallback on path-only.
 */
function matchEndpoints(
  ranked: RankedSurface[],
  allEndpoints: ExtractedEndpoint[]
): ExtractedEndpoint[] {
  const selected: ExtractedEndpoint[] = [];
  const usedIds = new Set<string>();

  const apiSurfaces = ranked.filter(r => r.type === "api");

  for (const surface of apiSurfaces) {
    const surfacePath   = (surface.path   ?? "").toLowerCase().trim();
    const surfaceMethod = (surface.method ?? "").toUpperCase().trim();

    // Exact match first
    let match = allEndpoints.find(ep =>
      ep.path.toLowerCase() === surfacePath &&
      ep.method === surfaceMethod &&
      !usedIds.has(ep.id)
    );

    // Fuzzy: same path, any method
    if (!match) {
      match = allEndpoints.find(ep =>
        ep.path.toLowerCase() === surfacePath &&
        !usedIds.has(ep.id)
      );
    }

    // Fuzzy: path contains the surface path (for minor trailing-slash differences)
    if (!match) {
      match = allEndpoints.find(ep =>
        ep.path.toLowerCase().replace(/\/$/, "") === surfacePath.replace(/\/$/, "") &&
        !usedIds.has(ep.id)
      );
    }

    if (match) {
      selected.push(match);
      usedIds.add(match.id);
    }
  }

  return selected;
}

/**
 * Match ranked page surfaces back to the original ExtractedPage objects.
 */
function matchPages(
  ranked: RankedSurface[],
  allPages: ExtractedPage[]
): ExtractedPage[] {
  const selected: ExtractedPage[] = [];
  const usedIds = new Set<string>();

  const pageSurfaces = ranked.filter(r => r.type === "page");

  for (const surface of pageSurfaces) {
    const surfaceRoute = (surface.route ?? "").toLowerCase().trim();

    // Exact route match
    let match = allPages.find(pg =>
      pg.route.toLowerCase() === surfaceRoute &&
      !usedIds.has(pg.id)
    );

    // Fuzzy: trailing slash normalisation
    if (!match) {
      match = allPages.find(pg =>
        pg.route.toLowerCase().replace(/\/$/, "") === surfaceRoute.replace(/\/$/, "") &&
        !usedIds.has(pg.id)
      );
    }

    if (match) {
      selected.push(match);
      usedIds.add(match.id);
    }
  }

  return selected;
}

// ─── Dry-run fallback ─────────────────────────────────────────────────────────

/**
 * When running in dry-run mode (no LLM), use a simple heuristic ranker.
 * This ensures the dry-run path still exercises the downstream filter logic.
 */
function heuristicRank(
  appType: "api-only" | "ui-only" | "full-stack",
  endpoints: ExtractedEndpoint[],
  pages: ExtractedPage[]
): RankedSurface[] {
  const surfaces: RankedSurface[] = [];
  let rank = 1;

  // --- Auth endpoints first ---
  const authEps = endpoints.filter(ep =>
    /login|signin|sign-in|auth/i.test(ep.path) && ep.method === "POST"
  );
  for (const ep of authEps.slice(0, 1)) {
    surfaces.push({ type: "api", method: ep.method, path: ep.path, rank: rank++, reason: "Auth gateway — required for all protected surfaces", authRequired: ep.authRequired });
  }

  // --- Auth pages (login page) ---
  if (appType !== "api-only") {
    const loginPages = pages.filter(pg => /login|signin|sign-in/i.test(pg.route));
    for (const pg of loginPages.slice(0, 1)) {
      surfaces.push({ type: "page", route: pg.route, title: pg.title, rank: rank++, reason: "Login page — entry point for authenticated flows", authRequired: pg.authRequired });
    }
  }

  // --- Dashboard / home page ---
  if (appType !== "api-only") {
    const dashPages = pages.filter(pg =>
      /dashboard|home|index|overview/i.test(pg.route) &&
      !surfaces.some(s => s.route === pg.route)
    );
    for (const pg of dashPages.slice(0, 1)) {
      surfaces.push({ type: "page", route: pg.route, title: pg.title, rank: rank++, reason: "Dashboard / home — proves session and main UI loads", authRequired: pg.authRequired });
    }
  }

  // --- Health endpoint ---
  const healthEps = endpoints.filter(ep => /health|status|ping/i.test(ep.path) && ep.method === "GET");
  for (const ep of healthEps.slice(0, 1)) {
    surfaces.push({ type: "api", method: ep.method, path: ep.path, rank: rank++, reason: "Health / status check", authRequired: ep.authRequired });
  }

  // --- Primary business entity pages (full-stack: prefer pages for main domains) ---
  if (appType !== "api-only") {
    const remainingPages = pages.filter(pg =>
      !pg.isDynamic &&
      !surfaces.some(s => s.route === pg.route) &&
      !/login|signin|logout|auth/i.test(pg.route)
    );
    for (const pg of remainingPages.slice(0, 2)) {
      surfaces.push({ type: "page", route: pg.route, title: pg.title, rank: rank++, reason: `Primary page — core domain surface`, authRequired: pg.authRequired });
    }
  }

  // --- Primary business entity APIs (for API-only or full-stack gap-filling) ---
  const remainingApis = endpoints.filter(ep =>
    ep.method === "GET" &&
    !surfaces.some(s => s.path === ep.path) &&
    !/login|signin|logout|auth|health|status|ping/i.test(ep.path)
  );
  const targetApiCount = appType === "api-only" ? 5 : 2;
  for (const ep of remainingApis.slice(0, targetApiCount)) {
    surfaces.push({ type: "api", method: ep.method, path: ep.path, rank: rank++, reason: "Core read endpoint for primary domain", authRequired: ep.authRequired });
  }

  return surfaces.sort((a, b) => a.rank - b.rank).slice(0, 10);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Uses the LLM to rank and select the most critical smoke-test surfaces
 * from the full blueprint, then returns filtered endpoints + pages.
 *
 * @param endpoints    All endpoints extracted from the repo
 * @param pages        All UI pages extracted from the repo
 * @param auth         Auth config (or null)
 * @param outputDir    Where to write the ranker debug JSON
 * @param dryRun       If true, skip LLM call and use heuristic ranking
 */
export async function rankCriticalSurfaces(
  endpoints: ExtractedEndpoint[],
  pages: ExtractedPage[],
  auth: AuthConfig | null,
  outputDir: string,
  dryRun: boolean
): Promise<RankerResult> {
  const appType  = inferAppType(endpoints, pages);
  const manifest = buildSurfaceManifest(endpoints, pages);
  const userMsg  = buildRankerUserMessage(appType, manifest, auth);

  let rankedSurfaces: RankedSurface[];
  let rawResponse = "";

  if (dryRun) {
    // Skip LLM — use heuristic ranker
    rankedSurfaces = heuristicRank(appType, endpoints, pages);
    rawResponse = "[dry-run: heuristic ranking, no LLM call]";
  } else {
    // Single LLM call
    const client = getAnthropicClient();

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      temperature: 0.1,
      system: RANKER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const content = message.content[0];
    if (content.type !== "text") throw new Error("Non-text response from ranker LLM");
    rawResponse = content.text;
    rankedSurfaces = parseRankedSurfaces(rawResponse);
  }

  // Match ranked selections back to original objects
  const selectedEndpoints = matchEndpoints(rankedSurfaces, endpoints);
  const selectedPages      = matchPages(rankedSurfaces, pages);

  // ── Write debug output ────────────────────────────────────────────────────
  const debugDir = path.join(outputDir, "llm-debug");
  fs.mkdirSync(debugDir, { recursive: true });

  const debugPayload = {
    timestamp: new Date().toISOString(),
    appType,
    dryRun,
    totalEndpointsInput: endpoints.length,
    totalPagesInput: pages.length,
    selectedEndpointsCount: selectedEndpoints.length,
    selectedPagesCount: selectedPages.length,
    promptSent: {
      system: RANKER_SYSTEM_PROMPT,
      user: userMsg,
    },
    rawLlmResponse: rawResponse,
    rankedSurfaces,
    selectedEndpoints: selectedEndpoints.map(ep => ({ method: ep.method, path: ep.path, authRequired: ep.authRequired })),
    selectedPages:     selectedPages.map(pg => ({ route: pg.route, title: pg.title, authRequired: pg.authRequired })),
  };

  fs.writeFileSync(
    path.join(debugDir, "ranker-debug.json"),
    JSON.stringify(debugPayload, null, 2),
    "utf-8"
  );

  // Also write a human-readable markdown summary
  const md = buildRankerMarkdown(appType, endpoints, pages, rankedSurfaces, selectedEndpoints, selectedPages, userMsg, rawResponse, dryRun);
  fs.writeFileSync(
    path.join(debugDir, "ranker-debug.md"),
    md,
    "utf-8"
  );

  return {
    endpoints: selectedEndpoints,
    pages: selectedPages,
    rankedSurfaces,
    promptSent: userMsg,
    rawResponse,
    appType,
  };
}

// ─── Markdown report builder ──────────────────────────────────────────────────

function buildRankerMarkdown(
  appType: string,
  allEndpoints: ExtractedEndpoint[],
  allPages: ExtractedPage[],
  ranked: RankedSurface[],
  selectedEndpoints: ExtractedEndpoint[],
  selectedPages: ExtractedPage[],
  promptSent: string,
  rawResponse: string,
  dryRun: boolean
): string {
  const lines: string[] = [
    `# SmokeForge Criticality Ranker — Debug Report`,
    `**Timestamp:** ${new Date().toISOString()}`,
    `**App type:** ${appType}`,
    `**Mode:** ${dryRun ? "dry-run (heuristic)" : "LLM-ranked"}`,
    "",
    "---",
    "",
    `## 📥 Input Surface (sent to LLM)`,
    "",
    `| Type | Surface | Auth |`,
    `|------|---------|------|`,
  ];

  for (const ep of allEndpoints) {
    lines.push(`| API | \`${ep.method} ${ep.path}\` | ${ep.authRequired ? "🔒" : "🔓"} |`);
  }
  for (const pg of allPages) {
    lines.push(`| PAGE | \`${pg.route}\` (${pg.title}) | ${pg.authRequired ? "🔒" : "🔓"} |`);
  }

  lines.push(
    "",
    "---",
    "",
    `## 🧠 Full Prompt Sent to LLM`,
    "",
    "```",
    promptSent,
    "```",
    "",
    "---",
    "",
    `## 🤖 Raw LLM Response`,
    "",
    "```json",
    rawResponse,
    "```",
    "",
    "---",
    "",
    `## ✅ LLM Prioritized Selection (${ranked.length} surfaces)`,
    "",
    `| Rank | Type | Surface | Auth | Reason |`,
    `|------|------|---------|------|--------|`,
  );

  for (const r of ranked.sort((a, b) => a.rank - b.rank)) {
    const surface = r.type === "api"
      ? `\`${r.method} ${r.path}\``
      : `\`${r.route}\` (${r.title ?? ""})`;
    const auth = r.authRequired ? "🔒" : "🔓";
    lines.push(`| ${r.rank} | ${r.type.toUpperCase()} | ${surface} | ${auth} | ${r.reason} |`);
  }

  lines.push(
    "",
    "---",
    "",
    `## 📊 Coverage Delta`,
    "",
    `- Total endpoints in repo: **${allEndpoints.length}**`,
    `- Total pages in repo: **${allPages.length}**`,
    `- Selected for smoke testing: **${selectedEndpoints.length} endpoints + ${selectedPages.length} pages**`,
    `- Skipped (not critical): **${allEndpoints.length - selectedEndpoints.length} endpoints + ${allPages.length - selectedPages.length} pages**`,
    "",
  );

  return lines.join("\n");
}
