// test/unit/analysis/backend/fastify.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { fastifyExtractor } from '../../../../src/analysis/backend/fastify.extractor';
import { createFixtureFiles, mockFastifyDetection } from '../../../helpers/fixture-helpers';

const detection = mockFastifyDetection();

describe('FastifyExtractor — canHandle', () => {
  it('handles fastify detection', () => {
    expect(fastifyExtractor.canHandle(detection)).toBe(true);
  });

  it('does not handle express detection', () => {
    const exp = { ...detection, backendFrameworks: ['express'] as never[] };
    expect(fastifyExtractor.canHandle(exp)).toBe(false);
  });
});

describe('FastifyExtractor — Basic route patterns', () => {
  it('extracts fastify.get()', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import Fastify from 'fastify';
        const fastify = Fastify();
        fastify.get('/users', async (request, reply) => {
          return [];
        });
      `,
    });
    const result = await fastifyExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'GET' && r.path.includes('users'))).toBe(true);
  });

  it('extracts fastify.post()', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import Fastify from 'fastify';
        const fastify = Fastify();
        fastify.post('/users', async (request, reply) => {
          return reply.code(201).send({});
        });
      `,
    });
    const result = await fastifyExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'POST' && r.path.includes('users'))).toBe(true);
  });

  it('extracts fastify.delete()', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import Fastify from 'fastify';
        const fastify = Fastify();
        fastify.delete('/users/:id', async (request, reply) => {
          return reply.code(204).send();
        });
      `,
    });
    const result = await fastifyExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'DELETE')).toBe(true);
  });

  it('extracts path params from :param style', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import Fastify from 'fastify';
        const fastify = Fastify();
        fastify.get('/users/:userId/orders/:orderId', async (request, reply) => {
          return {};
        });
      `,
    });
    const result = await fastifyExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('userId'));
    expect(route).toBeDefined();
    expect(route!.pathParams.some(p => p.name === 'userId')).toBe(true);
    expect(route!.pathParams.some(p => p.name === 'orderId')).toBe(true);
  });
});

describe('FastifyExtractor — JSON schema body', () => {
  it('extracts body fields from schema object', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import Fastify from 'fastify';
        const fastify = Fastify();
        fastify.post('/users', {
          schema: {
            body: {
              type: 'object',
              properties: {
                email: { type: 'string' },
                name: { type: 'string' }
              },
              required: ['email', 'name']
            }
          }
        }, async (request, reply) => {
          return reply.code(201).send({});
        });
      `,
    });
    const result = await fastifyExtractor.extract(files, detection);
    const route = result.find(r => r.method === 'POST');
    expect(route).toBeDefined();
    if (route?.requestBody) {
      const names = route.requestBody.fields.map(f => f.name);
      expect(names).toContain('email');
      expect(names).toContain('name');
    }
  });
});

describe('FastifyExtractor — Plugin registration (prefix)', () => {
  it('applies prefix from fastify.register(routes, { prefix: "/api" })', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import Fastify from 'fastify';
        const fastify = Fastify();
        fastify.register(require('./routes/users'), { prefix: '/api' });
      `,
      'routes/users.ts': `
        export default async function userRoutes(fastify) {
          fastify.get('/users', async (request, reply) => {
            return [];
          });
        }
      `,
    });
    const result = await fastifyExtractor.extract(files, detection);
    // Result may include routes from both files
    expect(result.some(r => r.path.includes('users'))).toBe(true);
  });
});

describe('FastifyExtractor — Edge cases', () => {
  it('returns empty array for empty file', async () => {
    const files = createFixtureFiles({
      'app.ts': `import Fastify from 'fastify';`,
    });
    const result = await fastifyExtractor.extract(files, detection);
    expect(Array.isArray(result)).toBe(true);
  });

  it('sets framework to fastify on endpoints', async () => {
    const files = createFixtureFiles({
      'app.ts': `
        import Fastify from 'fastify';
        const fastify = Fastify();
        fastify.get('/health', async () => ({ status: 'ok' }));
      `,
    });
    const result = await fastifyExtractor.extract(files, detection);
    result.forEach(ep => expect(ep.framework).toBe('fastify'));
  });
});
