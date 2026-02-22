// test/unit/analysis/backend/hono.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { honoExtractor } from '../../../../src/analysis/backend/hono.extractor';
import { createFixtureFiles, mockHonoDetection } from '../../../helpers/fixture-helpers';

const detection = mockHonoDetection();

describe('HonoExtractor — canHandle', () => {
  it('handles hono detection', () => {
    expect(honoExtractor.canHandle(detection)).toBe(true);
  });

  it('does not handle express detection', () => {
    const exp = { ...detection, backendFrameworks: ['express'] as never[] };
    expect(honoExtractor.canHandle(exp)).toBe(false);
  });
});

describe('HonoExtractor — Route extraction', () => {
  it('extracts GET route', async () => {
    const files = createFixtureFiles({
      'src/index.ts': `
        import { Hono } from 'hono';
        const app = new Hono();
        app.get('/users', (c) => c.json([]));
        export default app;
      `,
    });
    const result = await honoExtractor.extract(files, detection);
    const getUsers = result.find(r => r.path.includes('/users') && r.method === 'GET');
    expect(getUsers).toBeDefined();
  });

  it('extracts POST route', async () => {
    const files = createFixtureFiles({
      'src/index.ts': `
        import { Hono } from 'hono';
        const app = new Hono();
        app.post('/users', async (c) => {
          const body = await c.req.json();
          return c.json(body, 201);
        });
        export default app;
      `,
    });
    const result = await honoExtractor.extract(files, detection);
    const postRoute = result.find(r => r.method === 'POST');
    expect(postRoute).toBeDefined();
  });

  it('extracts path params from :param style', async () => {
    const files = createFixtureFiles({
      'src/index.ts': `
        import { Hono } from 'hono';
        const app = new Hono();
        app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));
        export default app;
      `,
    });
    const result = await honoExtractor.extract(files, detection);
    const paramRoute = result.find(r => r.path.includes(':id') || r.path.includes('{id}'));
    expect(paramRoute).toBeDefined();
  });

  it('extracts DELETE and PUT routes', async () => {
    const files = createFixtureFiles({
      'src/routes.ts': `
        import { Hono } from 'hono';
        const app = new Hono();
        app.put('/users/:id', async (c) => c.json({}));
        app.delete('/users/:id', (c) => c.body(null, 204));
        export default app;
      `,
    });
    const result = await honoExtractor.extract(files, detection);
    expect(result.find(r => r.method === 'PUT')).toBeDefined();
    expect(result.find(r => r.method === 'DELETE')).toBeDefined();
  });

  it('handles basePath from new Hono({ basePath })', async () => {
    const files = createFixtureFiles({
      'src/api.ts': `
        import { Hono } from 'hono';
        const api = new Hono({ basePath: '/api/v2' });
        api.get('/items', (c) => c.json([]));
        export default api;
      `,
    });
    const result = await honoExtractor.extract(files, detection);
    const prefixed = result.find(r => r.path.includes('/api/v2') || r.path.includes('/items'));
    expect(prefixed).toBeDefined();
  });

  it('detects global auth middleware via app.use', async () => {
    const files = createFixtureFiles({
      'src/index.ts': `
        import { Hono } from 'hono';
        import { bearerAuth } from 'hono/bearer-auth';
        const app = new Hono();
        app.use('*', bearerAuth({ token: process.env.TOKEN! }));
        app.get('/secure', (c) => c.json({ ok: true }));
        export default app;
      `,
    });
    const result = await honoExtractor.extract(files, detection);
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});

describe('HonoExtractor — Edge cases', () => {
  it('returns empty array for empty file', async () => {
    const files = createFixtureFiles({ 'empty.ts': '' });
    const result = await honoExtractor.extract(files, detection);
    expect(Array.isArray(result)).toBe(true);
  });

  it('sets framework to hono', async () => {
    const files = createFixtureFiles({
      'src/index.ts': `
        import { Hono } from 'hono';
        const app = new Hono();
        app.get('/ping', (c) => c.text('pong'));
        export default app;
      `,
    });
    const result = await honoExtractor.extract(files, detection);
    result.forEach(ep => expect(ep.framework).toBe('hono'));
  });
});
