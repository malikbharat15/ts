import * as path from "path";
import type {
  ExtractedEndpoint,
  ExtractedLocator,
  TestBlueprint,
} from "../blueprint/types";
import { writeFile } from "../utils/file-utils";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface ReportItem {
  id: string;
  type: "endpoint" | "page";
  method?: string;
  path?: string;
  route?: string;
  confidence: number;
  schemaSource: string | null;
  authDetected: boolean;
  generatedTestFile: string;
  flags: string[];
  warnings: string[];
}

export interface LocatorRecommendation {
  file: string;
  element: string;
  issue: string;
  recommendation: string;
}

export interface SmokeForgeReport {
  summary: {
    totalEndpoints: number;
    totalPages: number;
    highConfidence: number; // >= 0.80
    mediumConfidence: number; // 0.60–0.79
    lowConfidence: number; // 0.40–0.59
    todos: number; // < 0.40
  };
  items: ReportItem[];
  locatorRecommendations: LocatorRecommendation[];
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

/**
 * Calculates endpoint confidence using exact deduction table from spec.
 * Starts at 1.0 and applies deductions per flag / schema source.
 */
export function scoreEndpoint(endpoint: ExtractedEndpoint): number {
  let score = 1.0;

  if (endpoint.flags.includes("UNRESOLVED_PREFIX")) score -= 0.20;
  if (endpoint.flags.includes("DYNAMIC_PATH")) score -= 0.15;
  if (endpoint.flags.includes("CONDITIONAL_ROUTE")) score -= 0.10;

  if (!endpoint.requestBody) {
    score -= 0.25;
  } else {
    if (endpoint.requestBody.source === "inferred") score -= 0.15;
    if (endpoint.requestBody.source === "typescript") score -= 0.10;
  }

  if (endpoint.authType === null && endpoint.authRequired) {
    // Auth required but type unknown → ambiguous
    score -= 0.10;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Calculates locator confidence using the strategy base and flag deductions.
 */
export function scoreLocator(locator: ExtractedLocator): number {
  // Base score by strategy
  const BASE: Record<ExtractedLocator["strategy"], number> = {
    testId: 1.00,
    role: 0.85,
    label: 0.80,
    placeholder: 0.70,
    altText: 0.75,
    text: 0.70,
    css: 0.50,
  };

  let score = BASE[locator.strategy] ?? 0.50;

  if (locator.flags.includes("CONDITIONAL_ELEMENT")) score -= 0.15;
  if (locator.flags.includes("DYNAMIC_TESTID")) score -= 0.20;

  return Math.max(0, Math.min(1, score));
}

// ─── Confidence bucket helper ─────────────────────────────────────────────────

function bucket(confidence: number): "high" | "medium" | "low" | "todo" {
  if (confidence >= 0.80) return "high";
  if (confidence >= 0.60) return "medium";
  if (confidence >= 0.40) return "low";
  return "todo";
}

// ─── Locator recommendations ──────────────────────────────────────────────────

function buildLocatorRecommendations(
  blueprint: TestBlueprint
): LocatorRecommendation[] {
  const recommendations: LocatorRecommendation[] = [];

  for (const page of blueprint.pages) {
    for (const locator of page.locators) {
      if (locator.strategy === "css" || locator.flags.includes("BRITTLE")) {
        recommendations.push({
          file: page.filePath,
          element: locator.name,
          issue: "No data-testid attribute — using brittle CSS selector",
          recommendation: `Add data-testid='${locator.name
            .replace(/([A-Z])/g, "-$1")
            .toLowerCase()
            .replace(/^-/, "")}' to this element`,
        });
      }
      if (locator.flags.includes("DYNAMIC_TESTID")) {
        recommendations.push({
          file: page.filePath,
          element: locator.name,
          issue: "Dynamic testId — locator may be non-deterministic at test time",
          recommendation:
            "Consider using a static data-testid and passing index or role instead",
        });
      }
    }
  }

  return recommendations;
}

// ─── Domain → file name helper ────────────────────────────────────────────────

function domainFromPath(epPath: string): string {
  const segments = epPath.split("/").filter(Boolean);
  const noun = segments.find((s) => !/^(api|v\d+)$/.test(s));
  return noun ? noun.toLowerCase() : "unknown";
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateReport(
  blueprint: TestBlueprint,
  outputDir: string
): Promise<SmokeForgeReport> {
  const items: ReportItem[] = [];

  // ── Endpoint items ──────────────────────────────────────────────────────────
  for (const ep of blueprint.endpoints) {
    const confidence = scoreEndpoint(ep);
    const b = bucket(confidence);
    const domain = domainFromPath(ep.path);

    const warnings: string[] = [];
    if (b === "medium") warnings.push("Medium confidence — review before committing");
    if (b === "low") warnings.push("Low confidence — manual review recommended");
    if (b === "todo") warnings.push("Insufficient extraction data — manual test needed");

    items.push({
      id: ep.id,
      type: "endpoint",
      method: ep.method,
      path: ep.path,
      confidence,
      schemaSource: ep.requestBody?.source ?? null,
      authDetected: ep.authRequired,
      generatedTestFile: `${domain}.api.spec.ts`,
      flags: ep.flags,
      warnings,
    });
  }

  // ── Page items ──────────────────────────────────────────────────────────────
  for (const pg of blueprint.pages) {
    const confidence = pg.confidence;
    const b = bucket(confidence);

    const warnings: string[] = [];
    if (pg.locators.length === 0)
      warnings.push("No locators extracted — page test will be navigation-only");
    if (b === "low") warnings.push("Low confidence — manual review recommended");
    if (b === "todo") warnings.push("Insufficient extraction data — manual test needed");

    const domain = pg.route
      .split("/")
      .filter(Boolean)
      .find((s) => !/^\[.*\]$/.test(s)) ?? "unknown";

    items.push({
      id: pg.id,
      type: "page",
      route: pg.route,
      confidence,
      schemaSource: null,
      authDetected: pg.authRequired,
      generatedTestFile: `${domain.toLowerCase()}.page.spec.ts`,
      flags: pg.locators.flatMap((l) => l.flags),
      warnings,
    });
  }

  // ── Summary buckets ─────────────────────────────────────────────────────────
  const endpointItems = items.filter((i) => i.type === "endpoint");
  const pageItems = items.filter((i) => i.type === "page");
  const allItems = [...endpointItems, ...pageItems];

  const summary = {
    totalEndpoints: endpointItems.length,
    totalPages: pageItems.length,
    highConfidence: allItems.filter((i) => bucket(i.confidence) === "high").length,
    mediumConfidence: allItems.filter((i) => bucket(i.confidence) === "medium").length,
    lowConfidence: allItems.filter((i) => bucket(i.confidence) === "low").length,
    todos: allItems.filter((i) => bucket(i.confidence) === "todo").length,
  };

  const locatorRecommendations = buildLocatorRecommendations(blueprint);

  const report: SmokeForgeReport = { summary, items, locatorRecommendations };

  // ── Write report JSON ───────────────────────────────────────────────────────
  const reportPath = path.join(outputDir, "smokeforge-report.json");
  writeFile(reportPath, JSON.stringify(report, null, 2));

  return report;
}
