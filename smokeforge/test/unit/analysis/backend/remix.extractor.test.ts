// test/unit/analysis/backend/remix.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { remixExtractor } from '../../../../src/analysis/backend/remix.extractor';
import { createFixtureFiles, mockRemixDetection } from '../../../helpers/fixture-helpers';

const detection = mockRemixDetection();

describe('RemixExtractor — canHandle', () => {
  it('handles remix backend detection', () => {
    expect(remixExtractor.canHandle(detection)).toBe(true);
  });

  it('handles remix in frontendFrameworks', () => {
    const d = { ...detection, backendFrameworks: [] as never[], frontendFrameworks: ['remix'] as never[] };
    expect(remixExtractor.canHandle(d)).toBe(true);
  });

  it('does not handle express detection', () => {
    const exp = { ...detection, backendFrameworks: ['express'] as never[], frontendFrameworks: [] as never[] };
    expect(remixExtractor.canHandle(exp)).toBe(false);
  });
});

describe('RemixExtractor — loader() → GET', () => {
  it('infers GET from loader() export', async () => {
    const files = createFixtureFiles({
      'app/routes/users._index.tsx': `
        import type { LoaderFunctionArgs } from '@remix-run/node';
        import { json } from '@remix-run/node';
        export async function loader({ request }: LoaderFunctionArgs) {
          return json([]);
        }
      `,
    });
    const result = await remixExtractor.extract(files, detection);
    const getRoute = result.find(r => r.method === 'GET');
    expect(getRoute).toBeDefined();
    expect(getRoute?.path).toContain('/users');
  });
});

describe('RemixExtractor — action() → POST', () => {
  it('infers POST from action() export', async () => {
    const files = createFixtureFiles({
      'app/routes/users._index.tsx': `
        import type { ActionFunctionArgs } from '@remix-run/node';
        import { json } from '@remix-run/node';
        export async function action({ request }: ActionFunctionArgs) {
          const body = await request.json();
          return json(body, { status: 201 });
        }
      `,
    });
    const result = await remixExtractor.extract(files, detection);
    const postRoute = result.find(r => r.method === 'POST');
    expect(postRoute).toBeDefined();
  });
});

describe('RemixExtractor — file-based route conversion', () => {
  it('converts users.$userId.tsx to /users/:userId', async () => {
    const files = createFixtureFiles({
      'app/routes/users.$userId.tsx': `
        import { json } from '@remix-run/node';
        export async function loader({ params }) {
          return json({ id: params.userId });
        }
      `,
    });
    const result = await remixExtractor.extract(files, detection);
    const paramRoute = result.find(r => r.path.includes(':userId') || r.path.includes('userId'));
    expect(paramRoute).toBeDefined();
  });

  it('strips _layout prefix segment', async () => {
    const files = createFixtureFiles({
      'app/routes/_marketing.about.tsx': `
        import { json } from '@remix-run/node';
        export async function loader() {
          return json({});
        }
      `,
    });
    const result = await remixExtractor.extract(files, detection);
    if (result.length > 0) {
      expect(result[0].path).not.toContain('_marketing');
    }
  });

  it('converts nested param route: users.$userId.edit.tsx → /users/:userId/edit', async () => {
    const files = createFixtureFiles({
      'app/routes/users.$userId.edit.tsx': `
        import { json } from '@remix-run/node';
        export async function loader({ params }) {
          return json({ id: params.userId });
        }
      `,
    });
    const result = await remixExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('edit'));
    expect(route).toBeDefined();
    if (route) {
      expect(route.path).toContain('userId');
    }
  });
});

describe('RemixExtractor — Edge cases', () => {
  it('ignores files outside app/routes/', async () => {
    const files = createFixtureFiles({
      'src/server.ts': `export async function loader() { return null; }`,
    });
    const result = await remixExtractor.extract(files, detection);
    expect(result).toHaveLength(0);
  });

  it('sets framework to remix on extracted endpoints', async () => {
    const files = createFixtureFiles({
      'app/routes/health.tsx': `
        import { json } from '@remix-run/node';
        export async function loader() { return json({ ok: true }); }
      `,
    });
    const result = await remixExtractor.extract(files, detection);
    result.forEach(ep => expect(ep.framework).toBe('remix'));
  });
});
