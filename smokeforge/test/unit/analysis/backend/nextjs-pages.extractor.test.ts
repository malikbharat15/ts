// test/unit/analysis/backend/nextjs-pages.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { nextjsPagesExtractor } from '../../../../src/analysis/backend/nextjs-pages.extractor';
import { createFixtureFiles, createFixtureFilesWithDir, mockNextjsDetection } from '../../../helpers/fixture-helpers';

const detection = mockNextjsDetection();

describe('NextJSPagesExtractor — canHandle', () => {
  it('handles nextjs detection', () => {
    const { tmpDir } = createFixtureFilesWithDir({
      'pages/api/test.ts': `export default function handler(req: any, res: any) { res.json({}); }`,
    });
    expect(nextjsPagesExtractor.canHandle({ ...mockNextjsDetection(), rootPath: tmpDir })).toBe(true);
  });
});

describe('NextJSPagesExtractor — File convention detection', () => {
  it('detects pages/api/users.ts as /api/users', async () => {
    const files = createFixtureFiles({
      'pages/api/users.ts': `
        import { NextApiRequest, NextApiResponse } from 'next';
        export default function handler(req: NextApiRequest, res: NextApiResponse) {
          if (req.method === 'GET') {
            res.json([]);
          } else if (req.method === 'POST') {
            res.status(201).json({});
          }
        }
      `,
    });
    const result = await nextjsPagesExtractor.extract(files, detection);
    expect(result.some(r => r.path.includes('/api/users'))).toBe(true);
  });

  it('detects pages/api/users/[id].ts as /api/users/:id', async () => {
    const files = createFixtureFiles({
      'pages/api/users/[id].ts': `
        import { NextApiRequest, NextApiResponse } from 'next';
        export default function handler(req: NextApiRequest, res: NextApiResponse) {
          if (req.method === 'GET') {
            res.json({ id: req.query.id });
          }
        }
      `,
    });
    const result = await nextjsPagesExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes(':id'));
    expect(route).toBeDefined();
  });

  it('handles catch-all: pages/api/[...slug].ts → /api/*', async () => {
    const files = createFixtureFiles({
      'pages/api/[...slug].ts': `
        import { NextApiRequest, NextApiResponse } from 'next';
        export default function handler(req: NextApiRequest, res: NextApiResponse) {
          res.json({ slug: req.query.slug });
        }
      `,
    });
    const result = await nextjsPagesExtractor.extract(files, detection);
    expect(result.some(r => r.path.includes('*') || r.path.includes('slug'))).toBe(true);
  });
});

describe('NextJSPagesExtractor — HTTP method detection', () => {
  it('extracts GET from req.method === "GET" check', async () => {
    const files = createFixtureFiles({
      'pages/api/items.ts': `
        import { NextApiRequest, NextApiResponse } from 'next';
        export default function handler(req: NextApiRequest, res: NextApiResponse) {
          if (req.method === 'GET') {
            res.json([]);
          }
        }
      `,
    });
    const result = await nextjsPagesExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'GET')).toBe(true);
  });

  it('extracts POST from req.method === "POST" check', async () => {
    const files = createFixtureFiles({
      'pages/api/items.ts': `
        import { NextApiRequest, NextApiResponse } from 'next';
        export default function handler(req: NextApiRequest, res: NextApiResponse) {
          if (req.method === 'POST') {
            res.status(201).json({});
          }
        }
      `,
    });
    const result = await nextjsPagesExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'POST')).toBe(true);
  });

  it('does not pick up non-API page files', async () => {
    const files = createFixtureFiles({
      'pages/index.tsx': `
        export default function HomePage() { return null; }
      `,
      'pages/about.tsx': `
        export default function AboutPage() { return null; }
      `,
    });
    const result = await nextjsPagesExtractor.extract(files, detection);
    expect(result).toHaveLength(0);
  });
});

describe('NextJSPagesExtractor — Index files', () => {
  it('handles pages/api/users/index.ts → /api/users', async () => {
    const files = createFixtureFiles({
      'pages/api/users/index.ts': `
        import { NextApiRequest, NextApiResponse } from 'next';
        export default function handler(req: NextApiRequest, res: NextApiResponse) {
          res.json([]);
        }
      `,
    });
    const result = await nextjsPagesExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('/api/users'));
    expect(route).toBeDefined();
    // Should not have double /users/users
    expect(route!.path).not.toMatch(/users\/users/);
  });
});

describe('NextJSPagesExtractor — Edge cases', () => {
  it('returns empty array when no pages/api files present', async () => {
    const files = createFixtureFiles({
      'src/components/Button.tsx': `export default function Button() { return null; }`,
    });
    const result = await nextjsPagesExtractor.extract(files, detection);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('sets framework to nextjs on all extracted endpoints', async () => {
    const files = createFixtureFiles({
      'pages/api/test.ts': `
        import { NextApiRequest, NextApiResponse } from 'next';
        export default function handler(req: NextApiRequest, res: NextApiResponse) {
          res.json({});
        }
      `,
    });
    const result = await nextjsPagesExtractor.extract(files, detection);
    result.forEach(ep => expect(ep.framework).toBe('nextjs'));
  });
});
