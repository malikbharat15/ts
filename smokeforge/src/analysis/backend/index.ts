import type { ParsedFile } from "../parser";
import type { BackendFramework, DetectionResult, PackageDetection } from "../../ingestion/detector";
import { expressExtractor } from "./express.extractor";
import { nestjsExtractor } from "./nestjs.extractor";
import { nextjsPagesExtractor } from "./nextjs-pages.extractor";
import { nextjsAppExtractor } from "./nextjs-app.extractor";
import { fastifyExtractor } from "./fastify.extractor";
import { trpcExtractor } from "./trpc.extractor";
import { remixExtractor } from "./remix.extractor";
import { koaExtractor } from "./koa.extractor";
import { hapiExtractor } from "./hapi.extractor";
import { honoExtractor } from "./hono.extractor";
import { sveltekitExtractor } from "./sveltekit.extractor";
import type {
  ExtractedEndpoint,
  PathParam,
  QueryParam,
  RequestBodySchema,
  BodyField,
  ResponseSchema,
  ExtractorFlag,
  AuthType,
} from "../../blueprint/types";

// Re-export all endpoint-related types so consumers can import from this module
export type {
  ExtractedEndpoint,
  PathParam,
  QueryParam,
  RequestBodySchema,
  BodyField,
  ResponseSchema,
  ExtractorFlag,
  AuthType,
};

// ─── Extractor Interface ──────────────────────────────────────────────────────

export interface IFrameworkExtractor {
  readonly framework: BackendFramework;
  canHandle(detection: PackageDetection): boolean;
  extract(files: ParsedFile[], detection: PackageDetection): Promise<ExtractedEndpoint[]>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

// Extractors are registered here as they are built (Steps 12, 25-30).
const EXTRACTOR_REGISTRY: IFrameworkExtractor[] = [
  expressExtractor,
  nestjsExtractor,
  nextjsPagesExtractor,
  nextjsAppExtractor,
  fastifyExtractor,
  trpcExtractor,
  remixExtractor,
  koaExtractor,
  hapiExtractor,
  honoExtractor,
  sveltekitExtractor,
];

export function getExtractors(detection: DetectionResult): IFrameworkExtractor[] {
  const allDetections = detection.packages;
  const matched: IFrameworkExtractor[] = [];

  for (const extractor of EXTRACTOR_REGISTRY) {
    const handles = allDetections.some((pkg) => extractor.canHandle(pkg));
    if (handles) {
      matched.push(extractor);
    }
  }

  return matched;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runExtractors(
  files: ParsedFile[],
  detection: DetectionResult
): Promise<ExtractedEndpoint[]> {
  const extractors = getExtractors(detection);

  // Run all matching extractors concurrently — one per detected package
  const resultsPerExtractor = await Promise.all(
    extractors.flatMap((extractor) =>
      detection.packages
        .filter((pkg) => extractor.canHandle(pkg))
        .map((pkg) => extractor.extract(files, pkg))
    )
  );

  const all = resultsPerExtractor.flat();

  // Deduplicate by method + normalized path — keep highest confidence
  const seen = new Map<string, ExtractedEndpoint>();
  for (const ep of all) {
    const key = `${ep.method}:${ep.path}`;
    const existing = seen.get(key);
    if (!existing || ep.confidence > existing.confidence) {
      seen.set(key, ep);
    }
  }

  return Array.from(seen.values());
}
