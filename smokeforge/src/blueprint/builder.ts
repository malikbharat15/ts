import type { DetectionResult } from "../ingestion/detector";
import type { HarvestedConfigs } from "../ingestion/config-harvester";
import type {
  ExtractedEndpoint,
  ExtractedPage,
  AuthConfig,
  TestBlueprint,
  TestDataHints,
  PathParam,
  BodyField,
} from "./types";

// ─── Test data generation ─────────────────────────────────────────────────────

const UUID_EXAMPLE = "11111111-2222-3333-4444-555555555555";

function generateFieldExample(field: BodyField): string {
  const validators = field.validators.map((v) => v.toLowerCase());
  if (validators.includes("email")) return "${SMOKE_TEST_EMAIL}";
  if (validators.includes("uuid")) return UUID_EXAMPLE;
  if (validators.includes("url")) return "https://example.com/test";

  // Field-name heuristics: match common semantic names to sensible examples
  const name = field.name.toLowerCase();
  if (/^(date_?of_?birth|dob|birth_?date)$/.test(name)) return "1990-01-01";
  if (/date/.test(name) && /birth|dob/.test(name)) return "1990-01-01";
  if (/^(date|created_?at|updated_?at|expires_?at|due_?date|start_?date|end_?date)$/.test(name)) return "2025-01-01";
  if (/^(phone|mobile|cell|telephone|tel|fax)(_?number)?$/.test(name)) return "555-0100";
  if (/^(zip|zip_?code|postal_?code)$/.test(name)) return "90210";
  if (/^(mrn|patient_?number|record_?number)$/.test(name)) return "MRN-001";
  if (/^(first_?name|given_?name)$/.test(name)) return "Smoke";
  if (/^(last_?name|family_?name|surname)$/.test(name)) return "Test";
  if (name === "name" || name === "fullname" || name === "full_name") return "Smoke Test";
  if (/title/.test(name)) return "Smoke Test Title";
  if (/description|content|notes?|instructions?|summary|message|body/.test(name)) return "Smoke test content.";
  if (/^(dosage)$/.test(name)) return "10mg";
  if (/^(frequency)$/.test(name)) return "Once daily";
  if (/^(medication|drug)_?name$/.test(name)) return "Ibuprofen";
  if (/^(role)$/.test(name)) return "user";
  if (/^(status)$/.test(name) && validators.some(v => v.startsWith("enum:"))) {
    const enumVals = validators.find(v => v.startsWith("enum:"));
    if (enumVals) return enumVals.replace("enum:", "").split(",")[0];
  }
  if (/^(gender)$/.test(name)) return "male";
  if (/^(blood_?type)$/.test(name)) return "O+";

  switch (field.type.toLowerCase()) {
    case "number":
    case "integer":
    case "int":
      return "1";
    case "boolean":
      return "true";
    case "enum":
      return field.example ?? "smoke-test";
    default:
      return field.example ?? "smoke-test";
  }
}

function generateParamExample(param: PathParam): string {
  switch (param.type) {
    case "uuid":
      return UUID_EXAMPLE;
    case "number":
      return "1";
    default:
      return param.example || "example";
  }
}

// ─── Endpoint deduplication ───────────────────────────────────────────────────

function normalizeEndpointPath(path: string): string {
  return path.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

function endpointKey(e: ExtractedEndpoint): string {
  return `${e.method}::${normalizeEndpointPath(e.path)}`;
}

function mergeEndpoints(endpoints: ExtractedEndpoint[]): ExtractedEndpoint[] {
  const map = new Map<string, ExtractedEndpoint>();

  for (const ep of endpoints) {
    const key = endpointKey(ep);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, ep);
    } else {
      // Keep highest confidence; merge auth info (union wins)
      const merged: ExtractedEndpoint = {
        ...existing,
        confidence: Math.max(existing.confidence, ep.confidence),
        authRequired: existing.authRequired || ep.authRequired,
        authType: existing.authType ?? ep.authType,
        roles: Array.from(new Set([...existing.roles, ...ep.roles])),
        requestBody: existing.requestBody ?? ep.requestBody,
        responseSchema: existing.responseSchema ?? ep.responseSchema,
        flags: Array.from(new Set([...existing.flags, ...ep.flags])),
      };
      map.set(key, merged);
    }
  }

  return Array.from(map.values());
}

// ─── Page normalizedRoute generation ─────────────────────────────────────────

function generateNormalizedRoute(page: ExtractedPage): string {
  let route = page.route;
  for (const param of page.routeParams) {
    const exampleVal = param.example || UUID_EXAMPLE;
    route = route.replace(`:${param.name}`, exampleVal);
    // Also handle [param] style (Next.js)
    route = route.replace(`[${param.name}]`, exampleVal);
  }
  return route;
}

// ─── Endpoint → page linking ──────────────────────────────────────────────────

const FETCH_CALL_RE = /(?:fetch|axios\.(?:get|post|put|patch|delete))\s*\(\s*['"`]([^'"`]+)['"`]/g;
const AXIOS_CREATE_RE = /\.(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;

function extractUrlsFromSource(code: string): string[] {
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  const re1 = new RegExp(FETCH_CALL_RE.source, "g");
  while ((m = re1.exec(code)) !== null) urls.push(m[1]);
  const re2 = new RegExp(AXIOS_CREATE_RE.source, "g");
  while ((m = re2.exec(code)) !== null) urls.push(m[1]);
  return urls;
}

function endpointMatchesUrl(endpoint: ExtractedEndpoint, url: string): boolean {
  const normUrl = normalizeEndpointPath(url.split("?")[0]);
  const normEp = normalizeEndpointPath(endpoint.path);

  if (normUrl === normEp) return true;

  // Param-aware: replace :param or [param] segments with wildcard match
  const epPattern = normEp
    .replace(/:[^/]+/g, "[^/]+")
    .replace(/\[[^\]]+\]/g, "[^/]+");
  return new RegExp(`^${epPattern}$`).test(normUrl);
}

function buildConventionMapping(endpoints: ExtractedEndpoint[]): Map<string, string[]> {
  // Map page base path → list of endpoint ids
  const mapping = new Map<string, string[]>();
  for (const ep of endpoints) {
    // e.g. /api/users → key "users"
    const segments = ep.path.split("/").filter(Boolean);
    // Remove "api", "v1", "v2" prefixes to get domain noun
    const noun = segments.find((s) => !/^(api|v\d+)$/.test(s));
    if (noun) {
      const list = mapping.get(noun) ?? [];
      list.push(ep.id);
      mapping.set(noun, list);
    }
  }
  return mapping;
}

function linkEndpointsToPages(
  endpoints: ExtractedEndpoint[],
  pages: ExtractedPage[],
  pageSourceCache: Map<string, string>
): ExtractedPage[] {
  const conventionMap = buildConventionMapping(endpoints);

  return pages.map((page) => {
    const linkedSet = new Set<string>(page.linkedEndpoints);

    // (a) scan fetch/axios calls in page source
    const src = pageSourceCache.get(page.filePath) ?? "";
    if (src) {
      const urls = extractUrlsFromSource(src);
      for (const url of urls) {
        for (const ep of endpoints) {
          if (endpointMatchesUrl(ep, url)) linkedSet.add(ep.id);
        }
      }
    }

    // (b) convention matching: page route "/users" → endpoints noun "users"
    const pageNoun = page.route
      .split("/")
      .filter(Boolean)
      .find((s) => !/^(app|pages|dashboard|\[.*\])$/.test(s));
    if (pageNoun) {
      const conventionIds = conventionMap.get(pageNoun) ?? [];
      for (const id of conventionIds) linkedSet.add(id);
    }

    // (c) form flow → linked endpoint
    for (const form of page.formFlows) {
      if (form.linkedEndpointId) linkedSet.add(form.linkedEndpointId);
    }

    return { ...page, linkedEndpoints: Array.from(linkedSet) };
  });
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

function scoreEndpoint(endpoint: ExtractedEndpoint): number {
  let score = endpoint.confidence;
  if (endpoint.flags.includes("DYNAMIC_PATH")) score -= 0.1;
  if (endpoint.flags.includes("CONDITIONAL_ROUTE")) score -= 0.1;
  if (endpoint.flags.includes("UNRESOLVED_PREFIX")) score -= 0.15;
  return Math.max(0, Math.min(1, score));
}

function scorePage(page: ExtractedPage): number {
  let score = page.confidence;
  if (page.isDynamic) score -= 0.05;
  if (page.locators.length === 0) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

// ─── Test data hints ──────────────────────────────────────────────────────────

function buildTestDataHints(): TestDataHints {
  return {
    emailFormat: "${SMOKE_TEST_EMAIL}",
    passwordFormat: "${SMOKE_TEST_PASSWORD}",
    uuidExample: UUID_EXAMPLE,
    numberExample: 1,
    stringExample: "smoke-test",
  };
}

// ─── Body field example population ───────────────────────────────────────────

function populateFieldExamples(endpoints: ExtractedEndpoint[]): ExtractedEndpoint[] {
  return endpoints.map((ep) => {
    if (!ep.requestBody) return ep;
    const fields: BodyField[] = ep.requestBody.fields.map((f) => ({
      ...f,
      example: f.example ?? generateFieldExample(f),
    }));
    return { ...ep, requestBody: { ...ep.requestBody, fields } };
  });
}

// ─── Path param example population ───────────────────────────────────────────

function populatePathParamExamples(endpoints: ExtractedEndpoint[]): ExtractedEndpoint[] {
  return endpoints.map((ep) => ({
    ...ep,
    pathParams: ep.pathParams.map((p: PathParam) => ({
      ...p,
      example: p.example || generateParamExample(p),
    })),
  }));
}

// ─── React SPA: merge component pages into router pages ──────────────────────

/**
 * For React SPA repos, two extractors produce pages:
 *
 *   - router-extractor (IDs: "page_XXX"):   React Router <Route path="/login"> → correct routes, 0 locators
 *   - react.extractor  (IDs: "react_page_"): src/pages/LoginPage.tsx         → locators present, route /LoginPage (wrong)
 *
 * Strategy:
 *   1. For each router page that has 0 locators, look for a component page
 *      whose normalised title matches the route's last non-param segment.
 *      e.g. route "/login" → look for title "Login" or "LoginPage".
 *   2. Copy locators + formFlows from the matching component page to the router page.
 *   3. Drop component pages that were consumed or whose route looks like a
 *      PascalCase component name (phantom routes).
 *
 * If no router pages exist, the pages array is returned unchanged.
 */
function mergeComponentPagesIntoRouterPages(pages: ExtractedPage[]): ExtractedPage[] {
  const routerPages    = pages.filter(p => p.id.startsWith("page_"));
  const componentPages = pages.filter(p => p.id.startsWith("react_page_"));
  const otherPages     = pages.filter(p => !p.id.startsWith("page_") && !p.id.startsWith("react_page_"));

  // Nothing to do if there are no router-defined pages
  if (routerPages.length === 0) return pages;

  // Normalise a title for matching: "LoginPage" → "login", "Dashboard" → "dashboard"
  const normalise = (s: string) => s.toLowerCase().replace(/page$/, "").replace(/[-_\s]/g, "");

  // Build lookup:  "login" → component page
  const byNormTitle = new Map<string, ExtractedPage>();
  for (const cp of componentPages) {
    byNormTitle.set(normalise(cp.title), cp);
  }

  const consumedIds = new Set<string>();

  const merged = routerPages.map(rp => {
    if (rp.locators.length > 0) return rp;  // already has locators — nothing to do

    // Derive lookup key from the route's last non-param segment
    //   /customers/:id → "customers"   /login → "login"   / → ""
    const key = rp.route
      .split("/")
      .filter(seg => seg && !seg.startsWith(":"))
      .pop()
      ?.toLowerCase()
      .replace(/[-_\s]/g, "") ?? "";

    const cp = byNormTitle.get(key);
    if (!cp) return rp;

    consumedIds.add(cp.id);
    return {
      ...rp,
      locators: cp.locators,
      formFlows:       cp.formFlows.length  > 0 ? cp.formFlows  : rp.formFlows,
      linkedEndpoints: Array.from(new Set([...rp.linkedEndpoints, ...cp.linkedEndpoints])),
      confidence:      Math.max(rp.confidence, cp.confidence),
    };
  });

  // Keep component pages that were NOT consumed AND whose route is NOT a
  // phantom PascalCase component-name route (e.g. /LoginPage).
  const remaining = componentPages.filter(cp => {
    if (consumedIds.has(cp.id)) return false;   // consumed → drop
    const segs = cp.route.split("/").filter(Boolean);
    const isPseudoRoute = segs.some(s => /^[A-Z][a-z]/.test(s));
    return !isPseudoRoute;
  });

  return [...merged, ...remaining, ...otherPages];
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildBlueprint(
  repoUrl: string,
  detection: DetectionResult,
  endpoints: ExtractedEndpoint[],
  pages: ExtractedPage[],
  auth: AuthConfig | null,
  _configs: HarvestedConfigs
): TestBlueprint {
  // Step 1: Merge & deduplicate endpoints
  let mergedEndpoints = mergeEndpoints(endpoints);

  // Step 2: Populate examples
  mergedEndpoints = populateFieldExamples(mergedEndpoints);
  mergedEndpoints = populatePathParamExamples(mergedEndpoints);

  // Step 3: Recalculate confidence scores
  mergedEndpoints = mergedEndpoints.map((ep) => ({
    ...ep,
    confidence: scoreEndpoint(ep),
  }));

  // Step 4: Merge React SPA component pages into router pages (locator grafting)
  const mergedComponentPages = mergeComponentPagesIntoRouterPages(pages);

  // Step 5: Link endpoints to pages (page source not available at this layer — pass empty map)
  const linkedPages = linkEndpointsToPages(mergedEndpoints, mergedComponentPages, new Map());

  // Step 6: Generate normalizedRoute and recalculate page confidence
  const processedPages: ExtractedPage[] = linkedPages.map((page) => ({
    ...page,
    normalizedRoute: generateNormalizedRoute(page),
    confidence: scorePage(page),
  }));

  // Step 6: Extract repo name from URL
  const repoName = repoUrl
    .replace(/\.git$/, "")
    .split("/")
    .slice(-2)
    .join("/");

  // Step 7: Build TestDataHints
  const testDataHints = buildTestDataHints();

  // Step 8: Determine primary package detection
  const primaryPkg = detection.packages[0];

  return {
    repoUrl,
    repoName,
    analysisTimestamp: new Date().toISOString(),
    smokeforgeVersion: "1.0.0",
    frameworks: {
      backend: primaryPkg?.backendFrameworks ?? [],
      frontend: primaryPkg?.frontendFrameworks ?? [],
      schemas: primaryPkg?.schemaLibraries ?? [],
      auth: primaryPkg?.authLibraries ?? [],
      router: primaryPkg?.routerLibraries ?? [],
    },
    auth,
    endpoints: mergedEndpoints,
    pages: processedPages,
    baseUrlEnvVar: "BASE_URL",
    testDataHints,
  };
}

// ─── Re-export helpers used by downstream modules ─────────────────────────────
export { UUID_EXAMPLE, generateFieldExample, generateParamExample };
