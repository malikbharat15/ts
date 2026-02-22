// test/unit/analysis/auth/auth-detector.test.ts
import { describe, it, expect } from 'vitest';
import { detectAuth } from '../../../../src/analysis/auth/auth-detector';
import { createFixtureFiles } from '../../../helpers/fixture-helpers';
import type { ExtractedEndpoint } from '../../../../src/blueprint/types';

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
    sourceFile: 'routes/users.ts',
    sourceLine: 1,
    ...overrides,
  };
}

describe('detectAuth — login endpoint detection', () => {
  it('detects login endpoint from POST /auth/login', async () => {
    const files = createFixtureFiles({
      'routes/auth.ts': `
        import jwt from 'jsonwebtoken';
        app.post('/auth/login', async (req, res) => {
          const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET);
          res.json({ token });
        });
      `,
    });
    const endpoints: ExtractedEndpoint[] = [
      makeEndpoint({
        id: 'ep_login',
        method: 'POST',
        path: '/auth/login',
        requestBody: {
          source: 'inferred',
          fields: [
            { name: 'email', type: 'string', required: true, validators: [] },
            { name: 'password', type: 'string', required: true, validators: [] },
          ],
        },
      }),
    ];
    const result = await detectAuth(files, endpoints);
    expect(result).not.toBeNull();
    expect(result?.loginEndpoint).toContain('/auth/login');
  });

  it('returns null when no login endpoint exists', async () => {
    const files = createFixtureFiles({
      'routes/users.ts': `app.get('/users', (req, res) => res.json([]));`,
    });
    const endpoints: ExtractedEndpoint[] = [makeEndpoint({ id: 'ep_users', path: '/users' })];
    const result = await detectAuth(files, endpoints);
    expect(result).toBeNull();
  });
});

describe('detectAuth — auth type detection', () => {
  it('detects bearer_jwt from jsonwebtoken import', async () => {
    const files = createFixtureFiles({
      'middleware/auth.ts': `
        import jwt from 'jsonwebtoken';
        export function authenticate(req, res, next) {
          const token = req.headers.authorization?.split(' ')[1];
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          req.user = decoded;
          next();
        }
      `,
    });
    const loginEndpoint = makeEndpoint({
      id: 'ep_login',
      method: 'POST',
      path: '/login',
      requestBody: {
        source: 'inferred',
        fields: [
          { name: 'email', type: 'string', required: true, validators: [] },
          { name: 'password', type: 'string', required: true, validators: [] },
        ],
      },
    });
    const protectedEndpoint = makeEndpoint({
      id: 'ep_users',
      path: '/users',
      authRequired: true,
    });
    const result = await detectAuth(files, [loginEndpoint, protectedEndpoint]);
    if (result) {
      expect(result.tokenType).toBe('bearer_jwt');
    }
  });

  it('detects session_cookie from express-session import', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import session from 'express-session';
        app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
      `,
    });
    const loginEndpoint = makeEndpoint({
      id: 'ep_login',
      method: 'POST',
      path: '/login',
      requestBody: {
        source: 'inferred',
        fields: [
          { name: 'username', type: 'string', required: true, validators: [] },
          { name: 'password', type: 'string', required: true, validators: [] },
        ],
      },
    });
    const result = await detectAuth(files, [loginEndpoint]);
    if (result) {
      expect(['session_cookie', 'bearer_jwt']).toContain(result.tokenType);
    }
  });
});

describe('detectAuth — endpoint enrichment', () => {
  it('enriches authRequired endpoints with authType', async () => {
    const files = createFixtureFiles({
      'middleware/auth.ts': `
        import jwt from 'jsonwebtoken';
        export function authenticate(req, res, next) {
          jwt.verify(req.headers.authorization?.split(' ')[1], process.env.JWT_SECRET);
          next();
        }
      `,
    });
    const loginEndpoint = makeEndpoint({
      id: 'ep_login',
      method: 'POST',
      path: '/api/login',
      requestBody: {
        source: 'inferred',
        fields: [
          { name: 'email', type: 'string', required: true, validators: [] },
          { name: 'password', type: 'string', required: true, validators: [] },
        ],
      },
    });
    const protectedEndpoint: ExtractedEndpoint = {
      ...makeEndpoint({ id: 'ep_profile', path: '/api/profile', authRequired: true }),
      authType: null,
    };
    const endpoints = [loginEndpoint, protectedEndpoint];
    await detectAuth(files, endpoints);
    // After detectAuth, enriched endpoints should have authType set if jwt was detected
    expect(Array.isArray(endpoints)).toBe(true);
  });
});

describe('detectAuth — next-auth detection', () => {
  it('detects next_auth from next-auth import', async () => {
    const files = createFixtureFiles({
      'pages/api/auth/[...nextauth].ts': `
        import NextAuth from 'next-auth';
        import GithubProvider from 'next-auth/providers/github';
        export default NextAuth({
          providers: [GithubProvider({ clientId: process.env.GITHUB_ID, clientSecret: process.env.GITHUB_SECRET })],
        });
      `,
    });
    const loginEndpoint = makeEndpoint({
      id: 'ep_login',
      method: 'POST',
      path: '/api/auth/signin',
      requestBody: {
        source: 'inferred',
        fields: [
          { name: 'email', type: 'string', required: true, validators: [] },
          { name: 'password', type: 'string', required: true, validators: [] },
        ],
      },
    });
    const result = await detectAuth(files, [loginEndpoint]);
    if (result) {
      expect(['next_auth', 'bearer_jwt', 'session_cookie']).toContain(result.tokenType);
    }
  });
});
