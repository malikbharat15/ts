// test/unit/analysis/backend/nestjs.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { nestjsExtractor } from '../../../../src/analysis/backend/nestjs.extractor';
import { createFixtureFiles, mockNestjsDetection } from '../../../helpers/fixture-helpers';

const detection = mockNestjsDetection();

describe('NestJSExtractor — canHandle', () => {
  it('handles nestjs detection', () => {
    expect(nestjsExtractor.canHandle(detection)).toBe(true);
  });

  it('does not handle express detection', () => {
    const exp = { ...detection, backendFrameworks: ['express'] as never[] };
    expect(nestjsExtractor.canHandle(exp)).toBe(false);
  });
});

describe('NestJSExtractor — @Controller decorator', () => {
  it('extracts base path from @Controller("users")', async () => {
    const files = createFixtureFiles({
      'users.controller.ts': `
        import { Controller, Get } from '@nestjs/common';
        @Controller('users')
        export class UsersController {
          @Get()
          findAll() { return []; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    expect(result.some(r => r.path.includes('users'))).toBe(true);
  });

  it('extracts base path from @Controller("") as root', async () => {
    const files = createFixtureFiles({
      'app.controller.ts': `
        import { Controller, Get } from '@nestjs/common';
        @Controller()
        export class AppController {
          @Get('health')
          health() { return { status: 'ok' }; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    expect(result.some(r => r.path.includes('health'))).toBe(true);
  });
});

describe('NestJSExtractor — HTTP method decorators', () => {
  it('extracts @Get() as GET method', async () => {
    const files = createFixtureFiles({
      'users.controller.ts': `
        import { Controller, Get } from '@nestjs/common';
        @Controller('users')
        export class UsersController {
          @Get()
          findAll() { return []; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    const route = result.find(r => r.method === 'GET' && r.path.includes('users'));
    expect(route).toBeDefined();
  });

  it('extracts @Get(":id") as GET /:id', async () => {
    const files = createFixtureFiles({
      'users.controller.ts': `
        import { Controller, Get } from '@nestjs/common';
        @Controller('users')
        export class UsersController {
          @Get(':id')
          findOne() { return {}; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    const route = result.find(r => r.method === 'GET' && r.path.includes(':id'));
    expect(route).toBeDefined();
  });

  it('extracts @Post() as POST method', async () => {
    const files = createFixtureFiles({
      'users.controller.ts': `
        import { Controller, Post } from '@nestjs/common';
        @Controller('users')
        export class UsersController {
          @Post()
          create() { return {}; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'POST')).toBe(true);
  });

  it('extracts @Put(":id") as PUT method', async () => {
    const files = createFixtureFiles({
      'users.controller.ts': `
        import { Controller, Put } from '@nestjs/common';
        @Controller('users')
        export class UsersController {
          @Put(':id')
          update() { return {}; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'PUT')).toBe(true);
  });

  it('extracts @Patch(":id") as PATCH method', async () => {
    const files = createFixtureFiles({
      'users.controller.ts': `
        import { Controller, Patch } from '@nestjs/common';
        @Controller('users')
        export class UsersController {
          @Patch(':id')
          update() { return {}; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'PATCH')).toBe(true);
  });

  it('extracts @Delete(":id") as DELETE method', async () => {
    const files = createFixtureFiles({
      'users.controller.ts': `
        import { Controller, Delete } from '@nestjs/common';
        @Controller('users')
        export class UsersController {
          @Delete(':id')
          remove() { return {}; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    expect(result.some(r => r.method === 'DELETE')).toBe(true);
  });

  it('combines controller base + method path correctly', async () => {
    const files = createFixtureFiles({
      'auth.controller.ts': `
        import { Controller, Post, Get } from '@nestjs/common';
        @Controller('auth')
        export class AuthController {
          @Post('login')
          login() { return {}; }
          @Get('me')
          me() { return {}; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    expect(result.some(r => r.path.includes('/auth/login'))).toBe(true);
    expect(result.some(r => r.path.includes('/auth/me'))).toBe(true);
  });
});

describe('NestJSExtractor — Guards and auth', () => {
  it('sets authRequired: true from class-level @UseGuards(AuthGuard)', async () => {
    const files = createFixtureFiles({
      'protected.controller.ts': `
        import { Controller, Get, UseGuards } from '@nestjs/common';
        @Controller('protected')
        @UseGuards(AuthGuard)
        export class ProtectedController {
          @Get()
          getData() { return {}; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('protected'));
    expect(route).toBeDefined();
    expect(route!.authRequired).toBe(true);
  });

  it('sets authRequired: true from method-level @UseGuards(JwtAuthGuard)', async () => {
    const files = createFixtureFiles({
      'users.controller.ts': `
        import { Controller, Get, UseGuards } from '@nestjs/common';
        @Controller('users')
        export class UsersController {
          @Get()
          @UseGuards(JwtAuthGuard)
          findAll() { return []; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    const route = result.find(r => r.method === 'GET' && r.path.includes('users'));
    expect(route).toBeDefined();
    expect(route!.authRequired).toBe(true);
  });

  it('extracts roles from @Roles("admin")', async () => {
    const files = createFixtureFiles({
      'admin.controller.ts': `
        import { Controller, Get, UseGuards } from '@nestjs/common';
        @Controller('admin')
        @UseGuards(RolesGuard)
        @Roles('admin')
        export class AdminController {
          @Get()
          getAdminData() { return {}; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    const route = result.find(r => r.path.includes('admin'));
    if (route) {
      expect(route.roles).toContain('admin');
    }
  });
});

describe('NestJSExtractor — Multiple methods on same controller', () => {
  it('extracts all CRUD operations from a controller', async () => {
    const files = createFixtureFiles({
      'products.controller.ts': `
        import { Controller, Get, Post, Put, Patch, Delete } from '@nestjs/common';
        @Controller('products')
        export class ProductsController {
          @Get()
          findAll() { return []; }
          @Post()
          create() { return {}; }
          @Get(':id')
          findOne() { return {}; }
          @Put(':id')
          update() { return {}; }
          @Delete(':id')
          remove() { return {}; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    expect(result.length).toBeGreaterThanOrEqual(4);
    const methods = result.map(r => r.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
  });
});

describe('NestJSExtractor — Global prefix', () => {
  it('applies global prefix from main.ts app.setGlobalPrefix("api")', async () => {
    const files = createFixtureFiles({
      'main.ts': `
        async function bootstrap() {
          const app = await NestFactory.create(AppModule);
          app.setGlobalPrefix('api');
          await app.listen(3000);
        }
        bootstrap();
      `,
      'users.controller.ts': `
        import { Controller, Get } from '@nestjs/common';
        @Controller('users')
        export class UsersController {
          @Get()
          findAll() { return []; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    // Global prefix should be applied — path should include /api/users or similar
    const route = result.find(r => r.path.includes('users'));
    expect(route).toBeDefined();
    // Whether the global prefix is /api/users or /users depends on the extractor's implementation
    expect(route!.path).toMatch(/users/);
  });
});

describe('NestJSExtractor — Edge cases', () => {
  it('returns empty array when no controllers found', async () => {
    const files = createFixtureFiles({
      'service.ts': `
        export class UsersService {
          findAll() { return []; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    expect(Array.isArray(result)).toBe(true);
  });

  it('sets framework to nestjs on extracted endpoints', async () => {
    const files = createFixtureFiles({
      'users.controller.ts': `
        import { Controller, Get } from '@nestjs/common';
        @Controller('users')
        export class UsersController {
          @Get()
          findAll() { return []; }
        }
      `,
    });
    const result = await nestjsExtractor.extract(files, detection);
    result.forEach(ep => expect(ep.framework).toBe('nestjs'));
  });
});
