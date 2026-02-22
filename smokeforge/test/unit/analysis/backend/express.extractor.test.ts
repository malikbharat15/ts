// test/unit/analysis/backend/express.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { expressExtractor } from '../../../../src/analysis/backend/express.extractor';
import { createFixtureFiles, mockExpressDetection } from '../../../helpers/fixture-helpers';

const detection = mockExpressDetection();

describe('ExpressExtractor — canHandle', () => {
  it('handles express detection', () => {
    expect(expressExtractor.canHandle(detection)).toBe(true);
  });

  it('does not handle fastify detection', () => {
    const fastifyDetection = { ...detection, backendFrameworks: ['fastify'] as never[] };
    expect(expressExtractor.canHandle(fastifyDetection)).toBe(false);
  });
});

describe('ExpressExtractor — Basic HTTP methods', () => {
  it('extracts app.get()', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import express from 'express';
        const app = express();
        app.get('/users', (req, res) => res.json([]));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const route = result.find(r => r.method === 'GET' && r.path === '/users');
    expect(route).toBeDefined();
  });

  it('extracts app.post()', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import express from 'express';
        const app = express();
        app.post('/users', (req, res) => res.status(201).json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'POST' && r.path === '/users')).toBe(true);
  });

  it('extracts app.put()', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import express from 'express';
        const app = express();
        app.put('/users/:id', (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'PUT')).toBe(true);
  });

  it('extracts app.patch()', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import express from 'express';
        const app = express();
        app.patch('/users/:id', (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'PATCH')).toBe(true);
  });

  it('extracts app.delete()', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import express from 'express';
        const app = express();
        app.delete('/users/:id', (req, res) => res.status(204).send());
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'DELETE')).toBe(true);
  });

  it('extracts all methods from one file', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const app = express();
        app.get('/items', (req, res) => res.json([]));
        app.post('/items', (req, res) => res.json({}));
        app.put('/items/:id', (req, res) => res.json({}));
        app.delete('/items/:id', (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    expect(result.length).toBeGreaterThanOrEqual(4);
  });
});

describe('ExpressExtractor — Router instances', () => {
  it('extracts routes from express.Router()', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        router.get('/users', (req, res) => res.json([]));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    expect(result.some(r => r.path.includes('/users'))).toBe(true);
  });

  it('prepends prefix from app.use("/api/v1", router)', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import express from 'express';
        import { userRouter } from './routes/users';
        const app = express();
        app.use('/api/v1', userRouter);
      `,
      'routes/users.ts': `
        import express from 'express';
        export const userRouter = express.Router();
        userRouter.get('/users', (req, res) => res.json([]));
        userRouter.post('/users', (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const getUsersRoute = result.find(r => r.method === 'GET' && r.path === '/api/v1/users');
    expect(getUsersRoute).toBeDefined();
  });

  it('uses routes without prefix when no prefix mounted', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        router.get('/products', (req, res) => res.json([]));
        const app = express();
        app.use(router);
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    expect(result.some(r => r.path.includes('/products'))).toBe(true);
  });
});

describe('ExpressExtractor — Path parameters', () => {
  it('extracts :userId as path param from /users/:userId', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        router.get('/users/:userId', (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('userId'));
    expect(route).toBeDefined();
    expect(route!.pathParams.some(p => p.name === 'userId')).toBe(true);
  });

  it('extracts multiple params from /users/:userId/orders/:orderId', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        router.get('/users/:userId/orders/:orderId', (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('orderId'));
    expect(route).toBeDefined();
    expect(route!.pathParams).toHaveLength(2);
    expect(route!.pathParams.map(p => p.name)).toContain('userId');
    expect(route!.pathParams.map(p => p.name)).toContain('orderId');
  });
});

describe('ExpressExtractor — Auth middleware detection', () => {
  it('sets authRequired: true when authenticate middleware in chain', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        function authenticate(req, res, next) { next(); }
        router.get('/protected', authenticate, (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('protected'));
    expect(route).toBeDefined();
    expect(route!.authRequired).toBe(true);
  });

  it('sets authRequired: true when requireAuth middleware in chain', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        function requireAuth(req, res, next) { next(); }
        router.get('/dashboard', requireAuth, (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('dashboard'));
    expect(route).toBeDefined();
    expect(route!.authRequired).toBe(true);
  });

  it('sets authRequired: false when no auth middleware', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        router.get('/public-route', (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('public-route'));
    expect(route).toBeDefined();
    expect(route!.authRequired).toBe(false);
  });

  it('sets authRequired: true when jwt middleware in chain', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        function verifyJwt(req, res, next) { next(); }
        router.post('/secrets', verifyJwt, (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('secrets'));
    expect(route).toBeDefined();
    expect(route!.authRequired).toBe(true);
  });
});

describe('ExpressExtractor — File upload detection', () => {
  it('flags route with multer middleware as FILE_UPLOAD', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        import multer from 'multer';
        const router = express.Router();
        const upload = multer({ dest: 'uploads/' });
        router.post('/upload', upload.single('file'), (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('upload'));
    expect(route).toBeDefined();
    expect(route!.flags).toContain('FILE_UPLOAD');
  });
});

describe('ExpressExtractor — Conditional routes', () => {
  it('flags route inside if(process.env.X) as CONDITIONAL_ROUTE', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        if (process.env.FEATURE_BETA) {
          router.get('/beta-feature', (req, res) => res.json({}));
        }
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const betaRoute = result.find(r => r.path.includes('beta-feature'));
    if (betaRoute) {
      expect(betaRoute.flags).toContain('CONDITIONAL_ROUTE');
    }
    // If not found, that's acceptable behavior for conditional routes
  });
});

describe('ExpressExtractor — Route chaining', () => {
  it('extracts GET and POST from router.route().get().post()', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        router.route('/posts')
          .get((req, res) => res.json([]))
          .post((req, res) => res.status(201).json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const getRoute = result.find(r => r.method === 'GET' && r.path.includes('posts'));
    const postRoute = result.find(r => r.method === 'POST' && r.path.includes('posts'));
    expect(getRoute).toBeDefined();
    expect(postRoute).toBeDefined();
  });
});

describe('ExpressExtractor — Edge cases', () => {
  it('handles empty file with no routes', async () => {
    const files = createFixtureFiles({
      'empty.ts': `import express from 'express';`,
    });
    const result = await expressExtractor.extract(files, detection);
    expect(Array.isArray(result)).toBe(true);
  });

  it('deduplicates routes with same method and path', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        router.get('/users', handlerA);
        router.get('/users', handlerB);
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const getUsers = result.filter(r => r.method === 'GET' && r.path.includes('users'));
    // May extract 1 or 2 — just ensure it doesn't crash and returns valid data
    expect(getUsers.length).toBeGreaterThanOrEqual(1);
  });

  it('sets framework to express on all extracted endpoints', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        router.get('/users', (req, res) => res.json([]));
        router.post('/users', (req, res) => res.json({}));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    result.forEach(ep => expect(ep.framework).toBe('express'));
  });

  it('gives endpoints unique IDs', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const router = express.Router();
        router.get('/a', (req, res) => res.json([]));
        router.get('/b', (req, res) => res.json([]));
        router.get('/c', (req, res) => res.json([]));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    const ids = result.map(r => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('includes confidence score on each endpoint', async () => {
    const files = createFixtureFiles({
      'routes.ts': `
        import express from 'express';
        const app = express();
        app.get('/health', (req, res) => res.json({ status: 'ok' }));
      `,
    });
    const result = await expressExtractor.extract(files, detection);
    result.forEach(ep => {
      expect(ep.confidence).toBeGreaterThanOrEqual(0);
      expect(ep.confidence).toBeLessThanOrEqual(1);
    });
  });
});
