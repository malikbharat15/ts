// test/helpers/mock-blueprints.ts
// Mock data builders for blueprint tests

import type {
  ExtractedEndpoint,
  ExtractedPage,
  ExtractedLocator,
  AuthConfig,
  TestBlueprint,
  TestDataHints,
  FormFlow,
} from '../../src/blueprint/types';
import type { BlueprintChunk } from '../../src/blueprint/chunker';

// ─── Mock endpoint builders ────────────────────────────────────────────────────

export function mockEndpoint(overrides: Partial<ExtractedEndpoint> = {}): ExtractedEndpoint {
  return {
    id: overrides.id ?? 'ep_001',
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/api/users',
    pathParams: overrides.pathParams ?? [],
    queryParams: overrides.queryParams ?? [],
    requestBody: overrides.requestBody ?? null,
    responseSchema: overrides.responseSchema ?? null,
    authRequired: overrides.authRequired ?? false,
    authType: overrides.authType ?? null,
    roles: overrides.roles ?? [],
    sourceFile: overrides.sourceFile ?? '/tmp/test/routes.ts',
    sourceLine: overrides.sourceLine ?? 1,
    framework: overrides.framework ?? 'express',
    confidence: overrides.confidence ?? 1.0,
    flags: overrides.flags ?? [],
  };
}

export function mockPostEndpoint(path: string = '/api/users'): ExtractedEndpoint {
  return mockEndpoint({
    id: 'ep_post_001',
    method: 'POST',
    path,
    requestBody: {
      source: 'zod',
      fields: [
        { name: 'email', type: 'string', required: true, validators: ['email'], example: 'smoketest@example.com' },
        { name: 'password', type: 'string', required: true, validators: ['min'], example: 'SmokeTest123!' },
      ],
      rawSchemaRef: 'CreateUserSchema',
    },
    authRequired: false,
    confidence: 0.95,
  });
}

export function mockAuthEndpoint(): ExtractedEndpoint {
  return mockEndpoint({
    id: 'ep_auth_001',
    method: 'POST',
    path: '/api/auth/login',
    requestBody: {
      source: 'zod',
      fields: [
        { name: 'email', type: 'string', required: true, validators: ['email'], example: 'smoketest@example.com' },
        { name: 'password', type: 'string', required: true, validators: [], example: 'SmokeTest123!' },
      ],
      rawSchemaRef: 'LoginSchema',
    },
    confidence: 1.0,
    authRequired: false,
  });
}

export function mockEndpointWithFlags(flags: ExtractedEndpoint['flags']): ExtractedEndpoint {
  return mockEndpoint({ flags, confidence: 0.6 });
}

// ─── Mock page builders ────────────────────────────────────────────────────────

export function mockLocator(overrides: Partial<ExtractedLocator> = {}): ExtractedLocator {
  return {
    id: overrides.id ?? 'loc_001',
    name: overrides.name ?? 'submitButton',
    playwrightCode: overrides.playwrightCode ?? `page.getByTestId('submit-btn')`,
    strategy: overrides.strategy ?? 'testId',
    elementType: overrides.elementType ?? 'button',
    isInteractive: overrides.isInteractive ?? true,
    isConditional: overrides.isConditional ?? false,
    isDynamic: overrides.isDynamic ?? false,
    confidence: overrides.confidence ?? 1.0,
    flags: overrides.flags ?? [],
  };
}

export function mockPage(overrides: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    id: overrides.id ?? 'page_001',
    route: overrides.route ?? '/users',
    normalizedRoute: overrides.normalizedRoute ?? '/users',
    title: overrides.title ?? 'Users',
    filePath: overrides.filePath ?? '/tmp/test/UsersPage.tsx',
    authRequired: overrides.authRequired ?? false,
    roles: overrides.roles ?? [],
    isDynamic: overrides.isDynamic ?? false,
    routeParams: overrides.routeParams ?? [],
    locators: overrides.locators ?? [mockLocator()],
    formFlows: overrides.formFlows ?? [],
    navigationLinks: overrides.navigationLinks ?? [],
    linkedEndpoints: overrides.linkedEndpoints ?? [],
    confidence: overrides.confidence ?? 0.85,
  };
}

// ─── Mock auth config ─────────────────────────────────────────────────────────

export function mockAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    loginEndpoint: overrides.loginEndpoint ?? 'POST /api/auth/login',
    credentialsFields: overrides.credentialsFields ?? {
      emailField: 'email',
      passwordField: 'password',
      emailEnvVar: 'SMOKE_TEST_EMAIL',
      passwordEnvVar: 'SMOKE_TEST_PASSWORD',
    },
    tokenResponsePath: overrides.tokenResponsePath ?? 'accessToken',
    tokenType: overrides.tokenType ?? 'bearer_jwt',
    tokenHeaderName: overrides.tokenHeaderName ?? 'Authorization',
    tokenHeaderFormat: overrides.tokenHeaderFormat ?? 'Bearer {token}',
    refreshEndpoint: overrides.refreshEndpoint ?? null,
    authCookieName: overrides.authCookieName ?? null,
  };
}

// ─── Mock test data hints ────────────────────────────────────────────────────

export function mockTestDataHints(): TestDataHints {
  return {
    emailFormat: '${SMOKE_TEST_EMAIL}',
    passwordFormat: '${SMOKE_TEST_PASSWORD}',
    uuidExample: '11111111-2222-3333-4444-555555555555',
    numberExample: 1,
    stringExample: 'smoke-test',
  };
}

// ─── Mock blueprint builders ──────────────────────────────────────────────────

export function mockBlueprint(overrides: Partial<TestBlueprint> = {}): TestBlueprint {
  return {
    repoUrl: overrides.repoUrl ?? 'https://github.com/owner/test-repo',
    repoName: overrides.repoName ?? 'owner/test-repo',
    analysisTimestamp: overrides.analysisTimestamp ?? new Date().toISOString(),
    smokeforgeVersion: overrides.smokeforgeVersion ?? '1.0.0',
    frameworks: overrides.frameworks ?? {
      backend: ['express'],
      frontend: [],
      schemas: ['zod'],
      auth: ['jsonwebtoken'],
      router: [],
    },
    auth: overrides.auth !== undefined ? overrides.auth : mockAuthConfig(),
    endpoints: overrides.endpoints ?? [mockEndpoint(), mockPostEndpoint(), mockAuthEndpoint()],
    pages: overrides.pages ?? [mockPage()],
    baseUrlEnvVar: overrides.baseUrlEnvVar ?? 'BASE_URL',
    testDataHints: overrides.testDataHints ?? mockTestDataHints(),
  };
}

// ─── Mock chunk builders ──────────────────────────────────────────────────────

export function mockAuthChunk(): BlueprintChunk {
  return {
    domain: 'auth',
    hasPages: false,
    endpoints: [mockAuthEndpoint()],
    pages: [],
    auth: mockAuthConfig(),
    testDataHints: mockTestDataHints(),
    outputFileName: 'auth.api.spec.ts',
  };
}

export function mockUsersChunk(endpointCount = 3): BlueprintChunk {
  const endpoints: ExtractedEndpoint[] = [
    mockEndpoint({ id: 'ep_u1', method: 'GET', path: '/api/users' }),
    mockPostEndpoint('/api/users'),
    mockEndpoint({ id: 'ep_u3', method: 'GET', path: '/api/users/:userId', pathParams: [{ name: 'userId', type: 'uuid', example: '11111111-2222-3333-4444-555555555555' }] }),
    mockEndpoint({ id: 'ep_u4', method: 'PATCH', path: '/api/users/:userId' }),
    mockEndpoint({ id: 'ep_u5', method: 'DELETE', path: '/api/users/:userId' }),
  ].slice(0, endpointCount);

  return {
    domain: 'users',
    hasPages: false,
    endpoints,
    pages: [],
    auth: mockAuthConfig(),
    testDataHints: mockTestDataHints(),
    outputFileName: 'users.api.spec.ts',
  };
}

// ─── Mock form flow ─────────────────────────────────────────────────────────

export function mockFormFlow(overrides: Partial<FormFlow> = {}): FormFlow {
  return {
    id: overrides.id ?? 'ff_001',
    name: overrides.name ?? 'Login Form',
    testId: overrides.testId ?? 'login-form',
    steps: overrides.steps ?? [
      { order: 1, action: 'fill', locatorCode: `page.getByLabel('Email')`, testValue: 'smoketest@example.com', fieldType: 'email' },
      { order: 2, action: 'fill', locatorCode: `page.getByLabel('Password')`, testValue: 'SmokeTest123!', fieldType: 'password' },
      { order: 3, action: 'click', locatorCode: `page.getByRole('button', { name: 'Login' })`, testValue: null, fieldType: 'submit' },
    ],
    linkedEndpointId: overrides.linkedEndpointId ?? null,
    successRedirectHint: overrides.successRedirectHint ?? '/dashboard',
  };
}
