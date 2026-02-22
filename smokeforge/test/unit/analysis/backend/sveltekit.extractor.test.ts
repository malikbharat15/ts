// test/unit/analysis/backend/sveltekit.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { sveltekitExtractor } from '../../../../src/analysis/backend/sveltekit.extractor';
import { createFixtureFiles, mockSveltekitDetection } from '../../../helpers/fixture-helpers';

const detection = mockSveltekitDetection();

describe('SvelteKitExtractor — canHandle', () => {
  it('handles sveltekit backend detection', () => {
    expect(sveltekitExtractor.canHandle(detection)).toBe(true);
  });

  it('handles sveltekit in frontendFrameworks', () => {
    const d = { ...detection, backendFrameworks: [] as never[], frontendFrameworks: ['sveltekit'] as never[] };
    expect(sveltekitExtractor.canHandle(d)).toBe(true);
  });

  it('does not handle express detection', () => {
    const exp = { ...detection, backendFrameworks: ['express'] as never[], frontendFrameworks: [] as never[] };
    expect(sveltekitExtractor.canHandle(exp)).toBe(false);
  });
});

describe('SvelteKitExtractor — +server.ts API endpoints', () => {
  it('extracts GET from named export in +server.ts', async () => {
    const files = createFixtureFiles({
      'src/routes/api/users/+server.ts': `
        import { json } from '@sveltejs/kit';
        import type { RequestHandler } from './$types';

        export const GET: RequestHandler = async ({ params }) => {
          return json([]);
        };
      `,
    });
    const result = await sveltekitExtractor.extract(files, detection);
    const getRoute = result.find(r => r.method === 'GET');
    expect(getRoute).toBeDefined();
    expect(getRoute?.path).toContain('/api/users');
  });

  it('extracts POST from named export in +server.ts', async () => {
    const files = createFixtureFiles({
      'src/routes/api/users/+server.ts': `
        import { json } from '@sveltejs/kit';
        import type { RequestHandler } from './$types';

        export const POST: RequestHandler = async ({ request }) => {
          const body = await request.json();
          return json(body, { status: 201 });
        };
      `,
    });
    const result = await sveltekitExtractor.extract(files, detection);
    const postRoute = result.find(r => r.method === 'POST');
    expect(postRoute).toBeDefined();
  });

  it('extracts multiple methods from same +server.ts file', async () => {
    const files = createFixtureFiles({
      'src/routes/api/items/+server.ts': `
        import { json } from '@sveltejs/kit';
        export const GET = async () => json([]);
        export const POST = async ({ request }) => json({}, { status: 201 });
        export const DELETE = async () => new Response(null, { status: 204 });
      `,
    });
    const result = await sveltekitExtractor.extract(files, detection);
    expect(result.find(r => r.method === 'GET')).toBeDefined();
    expect(result.find(r => r.method === 'POST')).toBeDefined();
    expect(result.find(r => r.method === 'DELETE')).toBeDefined();
  });

  it('converts [userId] dynamic segment to :userId', async () => {
    const files = createFixtureFiles({
      'src/routes/api/users/[userId]/+server.ts': `
        import { json } from '@sveltejs/kit';
        export const GET = async ({ params }) => json({ id: params.userId });
      `,
    });
    const result = await sveltekitExtractor.extract(files, detection);
    const paramRoute = result.find(r => r.path.includes(':userId') || r.path.includes('userId'));
    expect(paramRoute).toBeDefined();
  });
});

describe('SvelteKitExtractor — +page.server.ts', () => {
  it('extracts GET from load() function', async () => {
    const files = createFixtureFiles({
      'src/routes/about/+page.server.ts': `
        import type { PageServerLoad } from './$types';
        export const load: PageServerLoad = async ({ params }) => {
          return { content: 'About page' };
        };
      `,
    });
    const result = await sveltekitExtractor.extract(files, detection);
    const getRoute = result.find(r => r.method === 'GET');
    expect(getRoute).toBeDefined();
    expect(getRoute?.path).toContain('/about');
  });

  it('extracts POST from actions in +page.server.ts', async () => {
    const files = createFixtureFiles({
      'src/routes/contact/+page.server.ts': `
        import type { Actions } from './$types';
        export const actions: Actions = {
          default: async ({ request }) => {
            const form = await request.formData();
            return { success: true };
          },
        };
      `,
    });
    const result = await sveltekitExtractor.extract(files, detection);
    const postRoute = result.find(r => r.method === 'POST');
    expect(postRoute).toBeDefined();
  });
});

describe('SvelteKitExtractor — Edge cases', () => {
  it('ignores +page.svelte files', async () => {
    const files = createFixtureFiles({
      'src/routes/+page.svelte': `<script>let name = 'World';</script><h1>Hello {name}!</h1>`,
    });
    const result = await sveltekitExtractor.extract(files, detection);
    expect(result).toHaveLength(0);
  });

  it('ignores +layout.ts files', async () => {
    const files = createFixtureFiles({
      'src/routes/+layout.ts': `export const prerender = true;`,
    });
    const result = await sveltekitExtractor.extract(files, detection);
    expect(result).toHaveLength(0);
  });

  it('sets framework to sveltekit', async () => {
    const files = createFixtureFiles({
      'src/routes/api/health/+server.ts': `
        import { json } from '@sveltejs/kit';
        export const GET = async () => json({ ok: true });
      `,
    });
    const result = await sveltekitExtractor.extract(files, detection);
    result.forEach(ep => expect(ep.framework).toBe('sveltekit'));
  });
});
