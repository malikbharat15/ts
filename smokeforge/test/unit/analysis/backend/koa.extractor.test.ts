// test/unit/analysis/backend/koa.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { koaExtractor } from '../../../../src/analysis/backend/koa.extractor';
import { createFixtureFiles, mockKoaDetection } from '../../../helpers/fixture-helpers';

const detection = mockKoaDetection();

describe('KoaExtractor — canHandle', () => {
  it('handles koa detection', () => {
    expect(koaExtractor.canHandle(detection)).toBe(true);
  });

  it('does not handle express detection', () => {
    const exp = { ...detection, backendFrameworks: ['express'] as never[] };
    expect(koaExtractor.canHandle(exp)).toBe(false);
  });
});

describe('KoaExtractor — Route extraction', () => {
  it('extracts GET route', async () => {
    const files = createFixtureFiles({
      'routes/users.ts': `
        import Router from '@koa/router';
        const router = new Router();
        router.get('/users', async (ctx) => {
          ctx.body = [];
        });
        export default router;
      `,
    });
    const result = await koaExtractor.extract(files, detection);
    const getUsers = result.find(r => r.path.includes('/users') && r.method === 'GET');
    expect(getUsers).toBeDefined();
  });

  it('extracts POST route', async () => {
    const files = createFixtureFiles({
      'routes/users.ts': `
        import Router from 'koa-router';
        const router = new Router();
        router.post('/users', async (ctx) => {
          ctx.body = ctx.request.body;
        });
        export default router;
      `,
    });
    const result = await koaExtractor.extract(files, detection);
    const postUsers = result.find(r => r.path.includes('/users') && r.method === 'POST');
    expect(postUsers).toBeDefined();
  });

  it('extracts path params from :param style', async () => {
    const files = createFixtureFiles({
      'routes/users.ts': `
        import Router from '@koa/router';
        const router = new Router();
        router.get('/users/:id', async (ctx) => {
          ctx.body = ctx.params.id;
        });
        export default router;
      `,
    });
    const result = await koaExtractor.extract(files, detection);
    const paramRoute = result.find(r => r.path.includes(':id') || r.path.includes('{id}'));
    expect(paramRoute).toBeDefined();
  });

  it('extracts DELETE route', async () => {
    const files = createFixtureFiles({
      'routes/users.ts': `
        import Router from '@koa/router';
        const router = new Router();
        router.delete('/users/:id', async (ctx) => {
          ctx.status = 204;
        });
        export default router;
      `,
    });
    const result = await koaExtractor.extract(files, detection);
    const deleteRoute = result.find(r => r.method === 'DELETE');
    expect(deleteRoute).toBeDefined();
  });

  it('handles router prefix', async () => {
    const files = createFixtureFiles({
      'routes/api.ts': `
        import Router from '@koa/router';
        const router = new Router({ prefix: '/api/v1' });
        router.get('/items', async (ctx) => {
          ctx.body = [];
        });
        export default router;
      `,
    });
    const result = await koaExtractor.extract(files, detection);
    const prefixed = result.find(r => r.path.includes('/api/v1') || r.path.includes('/items'));
    expect(prefixed).toBeDefined();
  });
});

describe('KoaExtractor — Edge cases', () => {
  it('returns empty array for empty file', async () => {
    const files = createFixtureFiles({ 'empty.ts': '' });
    const result = await koaExtractor.extract(files, detection);
    expect(Array.isArray(result)).toBe(true);
  });

  it('sets framework to koa on all endpoints', async () => {
    const files = createFixtureFiles({
      'routes/health.ts': `
        import Router from '@koa/router';
        const router = new Router();
        router.get('/health', async (ctx) => { ctx.body = 'ok'; });
        export default router;
      `,
    });
    const result = await koaExtractor.extract(files, detection);
    result.forEach(ep => expect(ep.framework).toBe('koa'));
  });
});
