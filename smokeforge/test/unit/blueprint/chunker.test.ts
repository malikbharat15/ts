// test/unit/blueprint/chunker.test.ts
import { describe, it, expect } from 'vitest';
import { chunkBlueprint } from '../../../src/blueprint/chunker';
import { buildBlueprint } from '../../../src/blueprint/builder';
import type { TestBlueprint, ExtractedEndpoint, ExtractedPage } from '../../../src/blueprint/types';
import type { DetectionResult } from '../../../src/ingestion/detector';
import type { HarvestedConfigs } from '../../../src/ingestion/config-harvester';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDetection(): DetectionResult {
  return {
    monorepo: false,
    monorepoTool: 'none',
    packages: [{
      rootPath: '/test',
      name: 'test',
      backendFrameworks: ['express'] as never[],
      frontendFrameworks: ['react-spa'] as never[],
      routerLibraries: [] as never[],
      schemaLibraries: [] as never[],
      authLibraries: [] as never[],
      isFullStack: false,
      nodeVersion: null,
      hasTypeScript: true,
      packageJson: {},
    }],
  };
}

const emptyConfigs: HarvestedConfigs = {
  dotEnvExample: null,
  openApiSpec: null,
  nextConfig: null,
  viteConfig: null,
  tsconfigPaths: {},
  packageJsons: [],
};

function makeEndpoint(overrides: Partial<ExtractedEndpoint> = {}): ExtractedEndpoint {
  return {
    id: `ep_${Math.random().toString(36).slice(2, 8)}`,
    method: 'GET' as const,
    path: '/users',
    framework: 'express' as const,
    authRequired: false,
    authType: null,
    flags: [],
    pathParams: [],
    queryParams: [],
    requestBody: null,
    responseSchema: null,
    roles: [],
    confidence: 0.9,
    sourceFile: 'routes.ts',
    sourceLine: 1,
    ...overrides,
  };
}

function makePage(overrides: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    id: `page_${Math.random().toString(36).slice(2, 8)}`,
    route: '/home',
    normalizedRoute: '/home',
    title: 'Home',
    filePath: 'src/pages/Home.tsx',
    authRequired: false,
    roles: [],
    isDynamic: false,
    routeParams: [],
    locators: [],
    formFlows: [],
    navigationLinks: [],
    linkedEndpoints: [],
    confidence: 0.8,
    ...overrides,
  };
}

function buildTestBlueprint(
  endpoints: ExtractedEndpoint[],
  pages: ExtractedPage[]
): TestBlueprint {
  return buildBlueprint('https://github.com/org/repo', makeDetection(), endpoints, pages, null, emptyConfigs);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('chunkBlueprint — basic structure', () => {
  it('returns an array of chunks', () => {
    const blueprint = buildTestBlueprint([], []);
    const chunks = chunkBlueprint(blueprint);
    expect(Array.isArray(chunks)).toBe(true);
  });

  it('returns empty array for empty blueprint', () => {
    const blueprint = buildTestBlueprint([], []);
    const chunks = chunkBlueprint(blueprint);
    expect(chunks).toHaveLength(0);
  });

  it('each chunk has required fields', () => {
    const blueprint = buildTestBlueprint([
      makeEndpoint({ id: 'ep_1', path: '/users', method: 'GET' }),
    ], []);
    const chunks = chunkBlueprint(blueprint);
    chunks.forEach(chunk => {
      expect(chunk).toHaveProperty('domain');
      expect(chunk).toHaveProperty('hasPages');
      expect(chunk).toHaveProperty('endpoints');
      expect(chunk).toHaveProperty('pages');
      expect(chunk).toHaveProperty('auth');
      expect(chunk).toHaveProperty('testDataHints');
      expect(chunk).toHaveProperty('outputFileName');
    });
  });
});

describe('chunkBlueprint — domain extraction', () => {
  it('groups /users/* endpoints into "users" domain', () => {
    const endpoints = [
      makeEndpoint({ id: 'ep_1', path: '/users', method: 'GET' }),
      makeEndpoint({ id: 'ep_2', path: '/users/:id', method: 'GET' }),
      makeEndpoint({ id: 'ep_3', path: '/users', method: 'POST' }),
    ];
    const blueprint = buildTestBlueprint(endpoints, []);
    const chunks = chunkBlueprint(blueprint);
    const usersChunk = chunks.find(c => c.domain === 'users');
    expect(usersChunk).toBeDefined();
    expect(usersChunk!.endpoints.length).toBeGreaterThanOrEqual(1);
  });

  it('groups /api/v1/products/* into "products" domain', () => {
    const blueprint = buildTestBlueprint([
      makeEndpoint({ id: 'ep_1', path: '/api/v1/products', method: 'GET' }),
    ], []);
    const chunks = chunkBlueprint(blueprint);
    const productChunk = chunks.find(c => c.domain === 'products');
    expect(productChunk).toBeDefined();
  });

  it('separates endpoints in different domains into separate chunks', () => {
    const blueprint = buildTestBlueprint([
      makeEndpoint({ id: 'ep_1', path: '/users', method: 'GET' }),
      makeEndpoint({ id: 'ep_2', path: '/products', method: 'GET' }),
    ], []);
    const chunks = chunkBlueprint(blueprint);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('chunkBlueprint — file naming', () => {
  it('generates .api.spec.ts when chunk has no pages', () => {
    const blueprint = buildTestBlueprint([
      makeEndpoint({ id: 'ep_1', path: '/users', method: 'GET' }),
    ], []);
    const chunks = chunkBlueprint(blueprint);
    const usersChunk = chunks.find(c => c.domain === 'users');
    if (usersChunk) {
      expect(usersChunk.outputFileName).toBe('users.api.spec.ts');
      expect(usersChunk.hasPages).toBe(false);
    }
  });

  it('generates .page.spec.ts when chunk has pages', () => {
    const blueprint = buildTestBlueprint([], [
      makePage({ id: 'page_1', route: '/home' }),
    ]);
    const chunks = chunkBlueprint(blueprint);
    const homeChunk = chunks.find(c => c.domain === 'home' || c.pages.length > 0);
    if (homeChunk) {
      expect(homeChunk.outputFileName).toContain('.page.spec.ts');
      expect(homeChunk.hasPages).toBe(true);
    }
  });
});

describe('chunkBlueprint — size limits', () => {
  it('splits domain with >15 endpoints into sub-chunks', () => {
    const manyEndpoints = Array.from({ length: 20 }, (_, i) =>
      makeEndpoint({ id: `ep_${i}`, path: `/users/action${i}`, method: 'GET' })
    );
    const blueprint = buildTestBlueprint(manyEndpoints, []);
    const chunks = chunkBlueprint(blueprint);
    // Each chunk should have at most 15 endpoints
    const maxPerChunk = Math.max(...chunks.map(c => c.endpoints.length));
    expect(maxPerChunk).toBeLessThanOrEqual(15);
  });

  it('splits domain with >10 pages into sub-chunks', () => {
    const manyPages = Array.from({ length: 15 }, (_, i) =>
      makePage({ id: `page_${i}`, route: `/dashboard/view${i}` })
    );
    const blueprint = buildTestBlueprint([], manyPages);
    const chunks = chunkBlueprint(blueprint);
    const maxPages = Math.max(...chunks.map(c => c.pages.length));
    expect(maxPages).toBeLessThanOrEqual(10);
  });
});
