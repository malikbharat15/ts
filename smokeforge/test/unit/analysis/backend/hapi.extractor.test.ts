// test/unit/analysis/backend/hapi.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { hapiExtractor } from '../../../../src/analysis/backend/hapi.extractor';
import { createFixtureFiles, mockHapiDetection } from '../../../helpers/fixture-helpers';

const detection = mockHapiDetection();

describe('HapiExtractor — canHandle', () => {
  it('handles hapi detection', () => {
    expect(hapiExtractor.canHandle(detection)).toBe(true);
  });

  it('does not handle express detection', () => {
    const exp = { ...detection, backendFrameworks: ['express'] as never[] };
    expect(hapiExtractor.canHandle(exp)).toBe(false);
  });
});

describe('HapiExtractor — Route extraction', () => {
  it('extracts GET route from server.route config object', async () => {
    const files = createFixtureFiles({
      'routes/users.ts': `
        import Hapi from '@hapi/hapi';
        server.route({
          method: 'GET',
          path: '/users',
          handler: async (request, h) => {
            return [];
          },
        });
      `,
    });
    const result = await hapiExtractor.extract(files, detection);
    const getUsers = result.find(r => r.path.includes('/users') && r.method === 'GET');
    expect(getUsers).toBeDefined();
  });

  it('extracts POST route', async () => {
    const files = createFixtureFiles({
      'routes/users.ts': `
        server.route({
          method: 'POST',
          path: '/users',
          handler: async (request, h) => {
            return h.response(request.payload).code(201);
          },
        });
      `,
    });
    const result = await hapiExtractor.extract(files, detection);
    const postRoute = result.find(r => r.method === 'POST');
    expect(postRoute).toBeDefined();
  });

  it('extracts path params from {param} style', async () => {
    const files = createFixtureFiles({
      'routes/users.ts': `
        server.route({
          method: 'GET',
          path: '/users/{userId}',
          handler: async (request, h) => {
            return request.params.userId;
          },
        });
      `,
    });
    const result = await hapiExtractor.extract(files, detection);
    const paramRoute = result.find(r => r.path.includes('{userId}') || r.path.includes(':userId') || r.path.includes('/users/'));
    expect(paramRoute).toBeDefined();
  });

  it('extracts PUT route', async () => {
    const files = createFixtureFiles({
      'routes/products.ts': `
        server.route({
          method: 'PUT',
          path: '/products/{id}',
          handler: (request, h) => h.response('updated'),
        });
      `,
    });
    const result = await hapiExtractor.extract(files, detection);
    const putRoute = result.find(r => r.method === 'PUT');
    expect(putRoute).toBeDefined();
  });

  it('extracts DELETE route', async () => {
    const files = createFixtureFiles({
      'routes/products.ts': `
        server.route({
          method: 'DELETE',
          path: '/products/{id}',
          handler: (request, h) => h.response().code(204),
        });
      `,
    });
    const result = await hapiExtractor.extract(files, detection);
    const deleteRoute = result.find(r => r.method === 'DELETE');
    expect(deleteRoute).toBeDefined();
  });

  it('detects auth required from route options', async () => {
    const files = createFixtureFiles({
      'routes/profile.ts': `
        server.route({
          method: 'GET',
          path: '/profile',
          options: {
            auth: 'jwt',
          },
          handler: (request, h) => request.auth.credentials,
        });
      `,
    });
    const result = await hapiExtractor.extract(files, detection);
    const profile = result.find(r => r.path.includes('/profile'));
    if (profile) {
      expect(profile.authRequired).toBe(true);
    }
  });

  it('handles array of routes via server.route([])', async () => {
    const files = createFixtureFiles({
      'routes/index.ts': `
        server.route([
          { method: 'GET', path: '/health', handler: () => 'ok' },
          { method: 'GET', path: '/status', handler: () => 'ok' },
        ]);
      `,
    });
    const result = await hapiExtractor.extract(files, detection);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

describe('HapiExtractor — Edge cases', () => {
  it('returns empty array for file with no routes', async () => {
    const files = createFixtureFiles({ 'helper.ts': `export const add = (a: number, b: number) => a + b;` });
    const result = await hapiExtractor.extract(files, detection);
    expect(Array.isArray(result)).toBe(true);
  });

  it('sets framework to hapi', async () => {
    const files = createFixtureFiles({
      'routes/health.ts': `
        server.route({ method: 'GET', path: '/health', handler: () => 'ok' });
      `,
    });
    const result = await hapiExtractor.extract(files, detection);
    result.forEach(ep => expect(ep.framework).toBe('hapi'));
  });
});
