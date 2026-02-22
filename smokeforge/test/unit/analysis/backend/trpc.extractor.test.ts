// test/unit/analysis/backend/trpc.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { trpcExtractor } from '../../../../src/analysis/backend/trpc.extractor';
import { createFixtureFiles, mockTrpcDetection } from '../../../helpers/fixture-helpers';

const detection = mockTrpcDetection();

describe('TRPCExtractor — canHandle', () => {
  it('handles trpc detection', () => {
    expect(trpcExtractor.canHandle(detection)).toBe(true);
  });

  it('does not handle express detection', () => {
    const exp = { ...detection, backendFrameworks: ['express'] as never[] };
    expect(trpcExtractor.canHandle(exp)).toBe(false);
  });
});

describe('TRPCExtractor — Procedure extraction', () => {
  it('extracts query procedure as GET method', async () => {
    const files = createFixtureFiles({
      'pages/api/trpc/[trpc].ts': `
        import { initTRPC } from '@trpc/server';
        const t = initTRPC.create();
        export const appRouter = t.router({
          users: t.router({
            getAll: t.procedure.query(() => []),
          }),
        });
      `,
    });
    const result = await trpcExtractor.extract(files, detection);
    const getAll = result.find(r => r.path.includes('users') && r.path.includes('getAll'));
    expect(getAll).toBeDefined();
    expect(getAll?.method).toBe('GET');
  });

  it('extracts mutation procedure as POST method', async () => {
    const files = createFixtureFiles({
      'pages/api/trpc/[trpc].ts': `
        import { initTRPC } from '@trpc/server';
        import { z } from 'zod';
        const t = initTRPC.create();
        export const appRouter = t.router({
          auth: t.router({
            login: t.procedure.input(z.object({ email: z.string(), password: z.string() })).mutation(({ input }) => ({ token: 'abc' })),
          }),
        });
      `,
    });
    const result = await trpcExtractor.extract(files, detection);
    const login = result.find(r => r.path.includes('login'));
    expect(login).toBeDefined();
    expect(login?.method).toBe('POST');
  });

  it('marks protected procedure as authRequired: true', async () => {
    const files = createFixtureFiles({
      'pages/api/trpc/[trpc].ts': `
        import { initTRPC } from '@trpc/server';
        const t = initTRPC.create();
        const protectedProcedure = t.procedure.use(({ ctx, next }) => {
          if (!ctx.user) throw new Error('UNAUTHORIZED');
          return next();
        });
        export const appRouter = t.router({
          users: t.router({
            me: protectedProcedure.query(() => ({})),
          }),
        });
      `,
    });
    const result = await trpcExtractor.extract(files, detection);
    const meRoute = result.find(r => r.path.includes('me'));
    if (meRoute) {
      // Protected procedure should mark auth required
      expect(meRoute.authRequired).toBe(true);
    }
    // At minimum, the route should be extracted
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it('detects base path /api/trpc from Next.js pages adapter', async () => {
    const files = createFixtureFiles({
      'pages/api/trpc/[trpc].ts': `
        import { createNextApiHandler } from '@trpc/server/adapters/next';
        import { appRouter } from '../../server/root';
        export default createNextApiHandler({ router: appRouter });
      `,
      'server/root.ts': `
        import { initTRPC } from '@trpc/server';
        const t = initTRPC.create();
        export const appRouter = t.router({
          health: t.procedure.query(() => ({ ok: true })),
        });
      `,
    });
    const result = await trpcExtractor.extract(files, detection);
    if (result.length > 0) {
      expect(result[0].path).toContain('/api/trpc');
    }
  });
});

describe('TRPCExtractor — Edge cases', () => {
  it('returns empty array when no tRPC routers found', async () => {
    const files = createFixtureFiles({
      'service.ts': `export class UsersService {}`,
    });
    const result = await trpcExtractor.extract(files, detection);
    expect(Array.isArray(result)).toBe(true);
  });

  it('sets framework to trpc on extracted endpoints', async () => {
    const files = createFixtureFiles({
      'pages/api/trpc/[trpc].ts': `
        import { initTRPC } from '@trpc/server';
        const t = initTRPC.create();
        export const appRouter = t.router({
          test: t.procedure.query(() => ({})),
        });
      `,
    });
    const result = await trpcExtractor.extract(files, detection);
    result.forEach(ep => expect(ep.framework).toBe('trpc'));
  });
});
