// test/unit/analysis/backend/nextjs-app.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { nextjsAppExtractor } from '../../../../src/analysis/backend/nextjs-app.extractor';
import { createFixtureFilesWithDir, mockNextjsDetection } from '../../../helpers/fixture-helpers';

function makeDetection(rootPath: string) {
  return { ...mockNextjsDetection(), rootPath };
}

describe('NextJSAppExtractor — canHandle', () => {
  it('handles nextjs detection', () => {
    const { tmpDir } = createFixtureFilesWithDir({
      'app/api/health/route.ts': `
        import { NextResponse } from 'next/server';
        export async function GET() { return NextResponse.json({ status: 'ok' }); }
      `,
    });
    expect(nextjsAppExtractor.canHandle(makeDetection(tmpDir))).toBe(true);
  });
});

describe('NextJSAppExtractor — File convention detection', () => {
  it('detects /app/api/users/route.ts as /api/users', async () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/api/users/route.ts': `
        import { NextResponse } from 'next/server';
        export async function GET() {
          return NextResponse.json([]);
        }
        export async function POST(request: Request) {
          const body = await request.json();
          return NextResponse.json(body, { status: 201 });
        }
      `,
    });
    const result = await nextjsAppExtractor.extract(parsedFiles, makeDetection(tmpDir));
    const getRoute = result.find(r => r.method === 'GET' && r.path.includes('/api/users'));
    expect(getRoute).toBeDefined();
  });

  it('detects [userId] as dynamic segment /api/users/:userId', async () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/api/users/[userId]/route.ts': `
        import { NextResponse } from 'next/server';
        export async function GET(request: Request, { params }: { params: { userId: string } }) {
          return NextResponse.json({ id: params.userId });
        }
      `,
    });
    const result = await nextjsAppExtractor.extract(parsedFiles, makeDetection(tmpDir));
    const route = result.find(r => r.method === 'GET' && r.path.includes('userId'));
    expect(route).toBeDefined();
  });

  it('strips route groups from path: /app/(dashboard)/users/route.ts => /users', async () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/(dashboard)/users/route.ts': `
        import { NextResponse } from 'next/server';
        export async function GET() {
          return NextResponse.json([]);
        }
      `,
    });
    const result = await nextjsAppExtractor.extract(parsedFiles, makeDetection(tmpDir));
    const route = result.find(r => r.method === 'GET');
    expect(route).toBeDefined();
    // Path should not contain the group segment
    expect(route!.path).not.toContain('dashboard');
    expect(route!.path).toContain('users');
  });

  it('ignores layout.tsx, loading.tsx, page.tsx', async () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/dashboard/layout.tsx': `export default function Layout({ children }) { return children; }`,
      'app/dashboard/loading.tsx': `export default function Loading() { return null; }`,
      'app/dashboard/page.tsx': `export default function Page() { return null; }`,
      'app/dashboard/error.tsx': `export default function Error() { return null; }`,
    });
    const result = await nextjsAppExtractor.extract(parsedFiles, makeDetection(tmpDir));
    // None of these are route handlers
    expect(result).toHaveLength(0);
  });
});

describe('NextJSAppExtractor — Named export method detection', () => {
  it('registers GET when export async function GET() present', async () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/api/health/route.ts': `
        import { NextResponse } from 'next/server';
        export async function GET() {
          return NextResponse.json({ status: 'ok' });
        }
      `,
    });
    const result = await nextjsAppExtractor.extract(parsedFiles, makeDetection(tmpDir));
    expect(result.some(r => r.method === 'GET')).toBe(true);
  });

  it('registers POST when export async function POST() present', async () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/api/users/route.ts': `
        import { NextResponse } from 'next/server';
        export async function POST(request: Request) {
          return NextResponse.json({}, { status: 201 });
        }
      `,
    });
    const result = await nextjsAppExtractor.extract(parsedFiles, makeDetection(tmpDir));
    expect(result.some(r => r.method === 'POST')).toBe(true);
  });

  it('registers multiple methods from same route file', async () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/api/posts/route.ts': `
        import { NextResponse } from 'next/server';
        export async function GET() { return NextResponse.json([]); }
        export async function POST(req: Request) { return NextResponse.json({}); }
        export async function DELETE(req: Request) { return new Response(null, { status: 204 }); }
      `,
    });
    const result = await nextjsAppExtractor.extract(parsedFiles, makeDetection(tmpDir));
    const methods = result.map(r => r.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });
});

describe('NextJSAppExtractor — Nested dynamic routes', () => {
  it('handles nested dynamic segments', async () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/api/users/[userId]/orders/[orderId]/route.ts': `
        import { NextResponse } from 'next/server';
        export async function GET(req: Request, { params }: { params: { userId: string; orderId: string }}) {
          return NextResponse.json({ userId: params.userId, orderId: params.orderId });
        }
      `,
    });
    const result = await nextjsAppExtractor.extract(parsedFiles, makeDetection(tmpDir));
    const route = result.find(r => r.path.includes('userId') && r.path.includes('orderId'));
    expect(route).toBeDefined();
  });
});

describe('NextJSAppExtractor — Edge cases', () => {
  it('returns empty array when no route.ts files found', async () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/components/Button.tsx': `export function Button() { return null; }`,
    });
    const result = await nextjsAppExtractor.extract(parsedFiles, makeDetection(tmpDir));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('sets framework to nextjs on all extracted endpoints', async () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/api/test/route.ts': `
        import { NextResponse } from 'next/server';
        export async function GET() { return NextResponse.json({}); }
      `,
    });
    const result = await nextjsAppExtractor.extract(parsedFiles, makeDetection(tmpDir));
    result.forEach(ep => expect(ep.framework).toBe('nextjs'));
  });
});
