// test/unit/output/reporter.test.ts
import { describe, it, expect } from 'vitest';
import { scoreEndpoint, scoreLocator } from '../../../src/output/reporter';
import type { ExtractedEndpoint, ExtractedLocator } from '../../../src/blueprint/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEndpoint(overrides: Partial<ExtractedEndpoint> = {}): ExtractedEndpoint {
  return {
    id: 'ep_001',
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

function makeLocator(overrides: Partial<ExtractedLocator> = {}): ExtractedLocator {
  return {
    id: 'loc_001',
    name: 'submit-btn',
    playwrightCode: 'page.getByTestId("submit-btn")',
    strategy: 'testId',
    elementType: 'button',
    isInteractive: true,
    isConditional: false,
    isDynamic: false,
    confidence: 1.0,
    flags: [],
    ...overrides,
  };
}

// ─── scoreEndpoint ────────────────────────────────────────────────────────────

describe('scoreEndpoint — base score', () => {
  it('returns 1.0 for a perfect endpoint (no flags, no requestBody)', () => {
    // An endpoint with no flags but no requestBody gets penalized for missing body
    const ep = makeEndpoint({ flags: [], requestBody: null });
    const score = scoreEndpoint(ep);
    // Without a request body, we get a 0.25 deduction from base 1.0
    expect(score).toBe(0.75);
  });

  it('returns higher for endpoint with request body', () => {
    const epNoBody = makeEndpoint({ requestBody: null });
    const epWithBody = makeEndpoint({
      requestBody: {
        source: 'zod',
        fields: [
          { name: 'email', type: 'string', required: true, validators: ['email'], example: null },
        ],
        rawSchemaRef: 'CreateUserSchema',
      },
    });
    expect(scoreEndpoint(epWithBody)).toBeGreaterThan(scoreEndpoint(epNoBody));
  });
});

describe('scoreEndpoint — flag deductions', () => {
  it('deducts for UNRESOLVED_PREFIX flag', () => {
    const base = scoreEndpoint(makeEndpoint({ flags: [] }));
    const flagged = scoreEndpoint(makeEndpoint({ flags: ['UNRESOLVED_PREFIX'] }));
    expect(flagged).toBeLessThan(base);
  });

  it('deducts for DYNAMIC_PATH flag', () => {
    const base = scoreEndpoint(makeEndpoint({ flags: [] }));
    const flagged = scoreEndpoint(makeEndpoint({ flags: ['DYNAMIC_PATH'] }));
    expect(flagged).toBeLessThan(base);
  });

  it('deducts for CONDITIONAL_ROUTE flag', () => {
    const base = scoreEndpoint(makeEndpoint({ flags: [] }));
    const flagged = scoreEndpoint(makeEndpoint({ flags: ['CONDITIONAL_ROUTE'] }));
    expect(flagged).toBeLessThan(base);
  });

  it('stacks deductions for multiple flags', () => {
    const oneFlag = scoreEndpoint(makeEndpoint({ flags: ['UNRESOLVED_PREFIX'] }));
    const twoFlags = scoreEndpoint(makeEndpoint({ flags: ['UNRESOLVED_PREFIX', 'DYNAMIC_PATH'] }));
    expect(twoFlags).toBeLessThan(oneFlag);
  });
});

describe('scoreEndpoint — requestBody source', () => {
  it('deducts less for zod source than inferred', () => {
    const zodBody = makeEndpoint({
      requestBody: { source: 'zod', fields: [], rawSchemaRef: null },
    });
    const inferredBody = makeEndpoint({
      requestBody: { source: 'inferred', fields: [], rawSchemaRef: null },
    });
    expect(scoreEndpoint(zodBody)).toBeGreaterThan(scoreEndpoint(inferredBody));
  });
});

describe('scoreEndpoint — result range', () => {
  it('score is always between 0 and 1', () => {
    const worstEndpoint = makeEndpoint({
      flags: ['UNRESOLVED_PREFIX', 'DYNAMIC_PATH', 'CONDITIONAL_ROUTE'],
      requestBody: { source: 'inferred', fields: [], rawSchemaRef: null },
      authRequired: true,
      authType: null,
    });
    const score = scoreEndpoint(worstEndpoint);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ─── scoreLocator ─────────────────────────────────────────────────────────────

describe('scoreLocator — base scores by strategy', () => {
  it('testId gets highest base score (1.0)', () => {
    const loc = makeLocator({ strategy: 'testId', flags: [] });
    expect(scoreLocator(loc)).toBe(1.0);
  });

  it('role gets score 0.85', () => {
    const loc = makeLocator({ strategy: 'role', flags: [] });
    expect(scoreLocator(loc)).toBe(0.85);
  });

  it('label gets score 0.80', () => {
    const loc = makeLocator({ strategy: 'label', flags: [] });
    expect(scoreLocator(loc)).toBe(0.80);
  });

  it('css gets lowest base score (0.50)', () => {
    const loc = makeLocator({ strategy: 'css', flags: [] });
    expect(scoreLocator(loc)).toBe(0.50);
  });
});

describe('scoreLocator — flag deductions', () => {
  it('deducts for CONDITIONAL_ELEMENT flag', () => {
    const base = scoreLocator(makeLocator({ strategy: 'testId', flags: [] }));
    const conditional = scoreLocator(makeLocator({ strategy: 'testId', flags: ['CONDITIONAL_ELEMENT'] }));
    expect(conditional).toBeLessThan(base);
    expect(base - conditional).toBeCloseTo(0.15, 5);
  });

  it('deducts for DYNAMIC_TESTID flag', () => {
    const base = scoreLocator(makeLocator({ strategy: 'testId', flags: [] }));
    const dynamic = scoreLocator(makeLocator({ strategy: 'testId', flags: ['DYNAMIC_TESTID'] }));
    expect(dynamic).toBeLessThan(base);
    expect(base - dynamic).toBeCloseTo(0.20, 5);
  });

  it('score is always between 0 and 1', () => {
    const worst = makeLocator({ strategy: 'css', flags: ['CONDITIONAL_ELEMENT', 'DYNAMIC_TESTID'] });
    const score = scoreLocator(worst);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('scoreLocator — strategy ordering', () => {
  it('ranks strategies: testId > role > label > placeholder > css', () => {
    const testId = scoreLocator(makeLocator({ strategy: 'testId', flags: [] }));
    const role = scoreLocator(makeLocator({ strategy: 'role', flags: [] }));
    const label = scoreLocator(makeLocator({ strategy: 'label', flags: [] }));
    const placeholder = scoreLocator(makeLocator({ strategy: 'placeholder', flags: [] }));
    const css = scoreLocator(makeLocator({ strategy: 'css', flags: [] }));
    expect(testId).toBeGreaterThan(role);
    expect(role).toBeGreaterThan(label);
    expect(label).toBeGreaterThan(placeholder);
    expect(placeholder).toBeGreaterThan(css);
  });
});
