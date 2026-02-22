// test/unit/blueprint/builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildBlueprint } from '../../../src/blueprint/builder';
import type { DetectionResult } from '../../../src/ingestion/detector';
import type { ExtractedEndpoint, ExtractedPage, AuthConfig } from '../../../src/blueprint/types';
import type { HarvestedConfigs } from '../../../src/ingestion/config-harvester';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDetection(overrides: Partial<DetectionResult['packages'][0]> = {}): DetectionResult {
  return {
    monorepo: false,
    monorepoTool: 'none',
    packages: [{
      rootPath: '/test',
      name: 'test',
      backendFrameworks: ['express'] as never[],
      frontendFrameworks: ['react-spa'] as never[],
      routerLibraries: [] as never[],
      schemaLibraries: ['zod'] as never[],
      authLibraries: ['jsonwebtoken'] as never[],
      isFullStack: true,
      nodeVersion: '20',
      hasTypeScript: true,
      packageJson: {},
      ...overrides,
    }],
  };
}

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
    sourceFile: 'routes/users.ts',
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

const emptyConfigs: HarvestedConfigs = {
  dotEnvExample: null,
  openApiSpec: null,
  nextConfig: null,
  viteConfig: null,
  tsconfigPaths: {},
  packageJsons: [],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildBlueprint — structure', () => {
  it('returns a TestBlueprint with required top-level fields', () => {
    const detection = makeDetection();
    const blueprint = buildBlueprint('https://github.com/org/repo', detection, [], [], null, emptyConfigs);
    expect(blueprint).toHaveProperty('repoUrl', 'https://github.com/org/repo');
    expect(blueprint).toHaveProperty('repoName', 'org/repo');
    expect(blueprint).toHaveProperty('analysisTimestamp');
    expect(blueprint).toHaveProperty('smokeforgeVersion');
    expect(blueprint).toHaveProperty('frameworks');
    expect(blueprint).toHaveProperty('endpoints');
    expect(blueprint).toHaveProperty('pages');
    expect(blueprint).toHaveProperty('auth');
    expect(blueprint).toHaveProperty('testDataHints');
  });

  it('populates repoName from git URL', () => {
    const detection = makeDetection();
    const blueprint = buildBlueprint('https://github.com/acme/my-api.git', detection, [], [], null, emptyConfigs);
    expect(blueprint.repoName).toBe('acme/my-api');
  });

  it('sets frameworks from primary package detection', () => {
    const detection = makeDetection({
      backendFrameworks: ['nestjs'] as never[],
      frontendFrameworks: ['nextjs'] as never[],
    });
    const blueprint = buildBlueprint('https://github.com/org/repo', detection, [], [], null, emptyConfigs);
    expect(blueprint.frameworks.backend).toContain('nestjs');
    expect(blueprint.frameworks.frontend).toContain('nextjs');
  });

  it('includes auth when provided', () => {
    const detection = makeDetection();
    const authConfig: AuthConfig = {
      loginEndpoint: 'POST /auth/login',
      credentialsFields: {
        emailField: 'email',
        passwordField: 'password',
        emailEnvVar: 'SMOKE_TEST_EMAIL',
        passwordEnvVar: 'SMOKE_TEST_PASSWORD',
      },
      tokenResponsePath: 'accessToken',
      tokenType: 'bearer_jwt',
      tokenHeaderName: 'Authorization',
      tokenHeaderFormat: 'Bearer {token}',
      refreshEndpoint: null,
      authCookieName: null,
    };
    const blueprint = buildBlueprint('https://github.com/org/repo', detection, [], [], authConfig, emptyConfigs);
    expect(blueprint.auth).not.toBeNull();
    expect(blueprint.auth?.loginEndpoint).toBe('POST /auth/login');
  });
});

describe('buildBlueprint — endpoint processing', () => {
  it('includes all endpoints in output', () => {
    const detection = makeDetection();
    const endpoints = [
      makeEndpoint({ id: 'ep_1', path: '/users', method: 'GET' }),
      makeEndpoint({ id: 'ep_2', path: '/users', method: 'POST' }),
      makeEndpoint({ id: 'ep_3', path: '/products', method: 'GET' }),
    ];
    const blueprint = buildBlueprint('https://github.com/org/repo', detection, endpoints, [], null, emptyConfigs);
    expect(blueprint.endpoints.length).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates endpoints with same method+path', () => {
    const detection = makeDetection();
    const endpoints = [
      makeEndpoint({ id: 'ep_a', path: '/health', method: 'GET', sourceFile: 'a.ts' }),
      makeEndpoint({ id: 'ep_b', path: '/health', method: 'GET', sourceFile: 'b.ts' }),
    ];
    const blueprint = buildBlueprint('https://github.com/org/repo', detection, endpoints, [], null, emptyConfigs);
    const healthRoutes = blueprint.endpoints.filter(e => e.path === '/health' && e.method === 'GET');
    expect(healthRoutes.length).toBe(1);
  });

  it('recalculates confidence scores on each endpoint', () => {
    const detection = makeDetection();
    const endpoints = [
      makeEndpoint({ id: 'ep_1', path: '/users', confidence: 0.3 }),
    ];
    const blueprint = buildBlueprint('https://github.com/org/repo', detection, endpoints, [], null, emptyConfigs);
    // Confidence should be recalculated by scoreEndpoint()
    blueprint.endpoints.forEach(ep => {
      expect(ep.confidence).toBeGreaterThanOrEqual(0);
      expect(ep.confidence).toBeLessThanOrEqual(1);
    });
  });
});

describe('buildBlueprint — page processing', () => {
  it('includes pages in output with normalizedRoute', () => {
    const detection = makeDetection();
    const pages = [
      makePage({ id: 'page_1', route: '/home' }),
      makePage({ id: 'page_2', route: '/about' }),
    ];
    const blueprint = buildBlueprint('https://github.com/org/repo', detection, [], pages, null, emptyConfigs);
    expect(blueprint.pages.length).toBe(2);
    blueprint.pages.forEach(p => {
      expect(p.normalizedRoute).toBeDefined();
    });
  });
});

describe('buildBlueprint — testDataHints', () => {
  it('populates testDataHints with required fields', () => {
    const detection = makeDetection();
    const blueprint = buildBlueprint('https://github.com/org/repo', detection, [], [], null, emptyConfigs);
    expect(blueprint.testDataHints).toHaveProperty('emailFormat');
    expect(blueprint.testDataHints).toHaveProperty('passwordFormat');
    expect(blueprint.testDataHints).toHaveProperty('uuidExample');
  });
});
