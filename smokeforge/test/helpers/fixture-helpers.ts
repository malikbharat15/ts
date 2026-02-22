// test/helpers/fixture-helpers.ts
// CRITICAL: Used by EVERY unit test. Tests real AST parsing on real code strings.

import { afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { parseFile, type ParsedFile } from '../../src/analysis/parser';
import type {
  PackageDetection,
  BackendFramework,
  FrontendFramework,
  SchemaLibrary,
  AuthLibrary,
  RouterLibrary,
} from '../../src/ingestion/detector';

// The system tmpdir (e.g. /tmp on macOS/Linux).
// All fixture files are written under tmpdir()/smokeforge-test-xxx/ so any
// extractor that checks `filePath.startsWith(detection.rootPath)` will pass
// when we default rootPath to tmpdir().
const SYSTEM_TMPDIR = tmpdir();

/**
 * Creates ParsedFile objects from in-memory code strings.
 * Writes them to a temp directory, parses them, returns ParsedFile[].
 * No mocking — real AST parsing on real files.
 */
export function createFixtureFiles(
  files: Record<string, string>  // { 'relative/path.ts': 'code string' }
): ParsedFile[] {
  return createFixtureFilesWithDir(files).parsedFiles;
}

/**
 * Same as createFixtureFiles, but also returns the temp directory path.
 * Use this when the test needs detection.rootPath to match the tmpDir.
 */
export function createFixtureFilesWithDir(
  files: Record<string, string>
): { parsedFiles: ParsedFile[]; tmpDir: string } {
  const tmpDir = join(tmpdir(), `smokeforge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  const parsedFiles: ParsedFile[] = [];

  for (const [relativePath, code] of Object.entries(files)) {
    const fullPath = join(tmpDir, relativePath);
    // Ensure parent directory exists
    const parentDir = join(fullPath, '..');
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(fullPath, code, 'utf-8');

    const parsed = parseFile(fullPath);
    if (parsed) {
      parsedFiles.push(parsed);
    } else {
      // For non-TS files (e.g. .vue, .svelte), parseFile returns null.
      // Include them with a null AST so extractors that read file.filePath or
      // file.code (e.g. vue.extractor, sveltekit.extractor) can still find them.
      parsedFiles.push({ filePath: fullPath, code, ast: null as never });
    }
  }

  // Register cleanup after each test
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  return { parsedFiles, tmpDir };
}

/**
 * Creates a single ParsedFile from a code string. Shorthand for a single-file fixture.
 */
export function createFixtureFile(
  relativePath: string,
  code: string
): ParsedFile | null {
  const files = createFixtureFiles({ [relativePath]: code });
  return files[0] ?? null;
}

/**
 * Creates a mock PackageDetection for a given framework configuration.
 */
export function mockDetection(
  overrides: Partial<PackageDetection> & { framework?: BackendFramework }
): PackageDetection {
  const backendFrameworks: BackendFramework[] = overrides.backendFrameworks ??
    (overrides.framework ? [overrides.framework] : []);

  return {
    rootPath: SYSTEM_TMPDIR,
    name: 'test-app',
    backendFrameworks,
    frontendFrameworks: overrides.frontendFrameworks ?? ([] as FrontendFramework[]),
    routerLibraries: overrides.routerLibraries ?? ([] as RouterLibrary[]),
    schemaLibraries: overrides.schemaLibraries ?? (['zod'] as SchemaLibrary[]),
    authLibraries: overrides.authLibraries ?? (['jsonwebtoken'] as AuthLibrary[]),
    isFullStack: overrides.isFullStack ?? false,
    nodeVersion: overrides.nodeVersion ?? '20.0.0',
    hasTypeScript: overrides.hasTypeScript ?? true,
    packageJson: overrides.packageJson ?? {},
  };
}

/**
 * Creates a mock PackageDetection for Express with Zod.
 */
export function mockExpressDetection(): PackageDetection {
  return mockDetection({ framework: 'express', schemaLibraries: ['zod'] });
}

/**
 * Creates a mock PackageDetection for NestJS with class-validator.
 */
export function mockNestjsDetection(): PackageDetection {
  return mockDetection({ framework: 'nestjs', schemaLibraries: ['class-validator'] });
}

/**
 * Creates a mock PackageDetection for Next.js.
 */
export function mockNextjsDetection(): PackageDetection {
  return mockDetection({ framework: 'nextjs', schemaLibraries: ['zod'] });
}

/**
 * Creates a mock PackageDetection for Fastify with Zod.
 */
export function mockFastifyDetection(): PackageDetection {
  return mockDetection({ framework: 'fastify', schemaLibraries: ['zod'] });
}

/**
 * Creates a mock PackageDetection for tRPC with Zod.
 */
export function mockTrpcDetection(): PackageDetection {
  return mockDetection({ framework: 'trpc', schemaLibraries: ['zod'] });
}

/**
 * Creates a mock PackageDetection for Remix.
 */
export function mockRemixDetection(): PackageDetection {
  return mockDetection({ framework: 'remix' });
}

/**
 * Creates a mock PackageDetection for Koa.
 */
export function mockKoaDetection(): PackageDetection {
  return mockDetection({ framework: 'koa' });
}

/**
 * Creates a mock PackageDetection for Hapi with Joi.
 */
export function mockHapiDetection(): PackageDetection {
  return mockDetection({ framework: 'hapi', schemaLibraries: ['joi'] });
}

/**
 * Creates a mock PackageDetection for Hono with Zod.
 */
export function mockHonoDetection(): PackageDetection {
  return mockDetection({ framework: 'hono', schemaLibraries: ['zod'] });
}

/**
 * Creates a mock PackageDetection for SvelteKit.
 */
export function mockSveltekitDetection(): PackageDetection {
  return mockDetection({ framework: 'sveltekit' });
}
