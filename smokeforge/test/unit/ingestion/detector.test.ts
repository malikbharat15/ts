// test/unit/ingestion/detector.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { detect } from '../../../src/ingestion/detector';

// ─── Helpers ────────────────────────────────────────────────────────────────

let testDir = '';

beforeEach(() => {
  testDir = join(tmpdir(), `smokeforge-detector-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function writePkg(dir: string, deps: Record<string, string>, devDeps: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'test-app',
      version: '1.0.0',
      dependencies: deps,
      devDependencies: devDeps,
      ...extra,
    }, null, 2)
  );
}

describe('detect() — backend framework detection', () => {
  it('detects express from dependencies', async () => {
    writePkg(testDir, { express: '^4.18.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toContain('express');
  });

  it('detects fastify from dependencies', async () => {
    writePkg(testDir, { fastify: '^4.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toContain('fastify');
  });

  it('detects nestjs from @nestjs/core', async () => {
    writePkg(testDir, { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toContain('nestjs');
  });

  it('detects koa from dependencies', async () => {
    writePkg(testDir, { koa: '^2.14.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toContain('koa');
  });

  it('detects hapi from @hapi/hapi', async () => {
    writePkg(testDir, { '@hapi/hapi': '^21.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toContain('hapi');
  });

  it('detects hono from dependencies', async () => {
    writePkg(testDir, { hono: '^4.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toContain('hono');
  });

  it('detects trpc from @trpc/server', async () => {
    writePkg(testDir, { '@trpc/server': '^11.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toContain('trpc');
  });

  it('detects nextjs from next', async () => {
    writePkg(testDir, { next: '^14.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toContain('nextjs');
  });

  it('detects remix from @remix-run/node', async () => {
    writePkg(testDir, { '@remix-run/node': '^2.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toContain('remix');
  });

  it('detects sveltekit from @sveltejs/kit', async () => {
    writePkg(testDir, { '@sveltejs/kit': '^2.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toContain('sveltekit');
  });

  it('detects multiple frameworks in one project', async () => {
    writePkg(testDir, { express: '^4.0.0', '@trpc/server': '^11.0.0' });
    const result = await detect(testDir);
    const { backendFrameworks } = result.packages[0];
    expect(backendFrameworks).toContain('express');
    expect(backendFrameworks).toContain('trpc');
  });

  it('returns empty backendFrameworks for unknown project', async () => {
    writePkg(testDir, { lodash: '^4.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].backendFrameworks).toHaveLength(0);
  });
});

describe('detect() — frontend framework detection', () => {
  it('detects react-spa from react + react-dom', async () => {
    writePkg(testDir, { react: '^18.0.0', 'react-dom': '^18.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].frontendFrameworks).toContain('react-spa');
  });

  it('detects angular from @angular/core', async () => {
    writePkg(testDir, { '@angular/core': '^17.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].frontendFrameworks).toContain('angular');
  });

  it('detects vue-spa from vue', async () => {
    writePkg(testDir, { vue: '^3.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].frontendFrameworks).toContain('vue-spa');
  });
});

describe('detect() — schema library detection', () => {
  it('detects zod', async () => {
    writePkg(testDir, { zod: '^3.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].schemaLibraries).toContain('zod');
  });

  it('detects joi', async () => {
    writePkg(testDir, { joi: '^17.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].schemaLibraries).toContain('joi');
  });

  it('detects class-validator', async () => {
    writePkg(testDir, { 'class-validator': '^0.14.0' });
    const result = await detect(testDir);
    expect(result.packages[0].schemaLibraries).toContain('class-validator');
  });

  it('detects yup', async () => {
    writePkg(testDir, { yup: '^1.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].schemaLibraries).toContain('yup');
  });
});

describe('detect() — auth library detection', () => {
  it('detects jsonwebtoken', async () => {
    writePkg(testDir, { jsonwebtoken: '^9.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].authLibraries).toContain('jsonwebtoken');
  });

  it('detects passport', async () => {
    writePkg(testDir, { passport: '^0.7.0' });
    const result = await detect(testDir);
    expect(result.packages[0].authLibraries).toContain('passport');
  });

  it('detects next-auth', async () => {
    writePkg(testDir, { 'next-auth': '^4.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].authLibraries).toContain('next-auth');
  });
});

describe('detect() — TypeScript detection', () => {
  it('detects hasTypeScript when tsconfig.json exists', async () => {
    writePkg(testDir, { typescript: '^5.0.0' });
    writeFileSync(join(testDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
    const result = await detect(testDir);
    expect(result.packages[0].hasTypeScript).toBe(true);
  });

  it('detects isFullStack when both react and express present', async () => {
    writePkg(testDir, { express: '^4.0.0', react: '^18.0.0', 'react-dom': '^18.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].isFullStack).toBe(true);
  });
});

describe('detect() — monorepo detection', () => {
  it('detects turbo monorepo from turbo.json', async () => {
    writePkg(testDir, {});
    writeFileSync(join(testDir, 'turbo.json'), JSON.stringify({}));
    // Add a real package
    const pkgDir = join(testDir, 'packages', 'api');
    writePkg(pkgDir, { express: '^4.0.0' }, {}, { scripts: { dev: 'ts-node src/index.ts' } });

    const result = await detect(testDir);
    expect(result.monorepo).toBe(true);
    expect(result.monorepoTool).toBe('turbo');
  });

  it('detects nx monorepo from nx.json', async () => {
    writePkg(testDir, {});
    writeFileSync(join(testDir, 'nx.json'), JSON.stringify({}));
    const pkgDir = join(testDir, 'apps', 'api');
    writePkg(pkgDir, { nestjs: '^10.0.0' }, {}, { scripts: { dev: 'ts-node src/main.ts' } });

    const result = await detect(testDir);
    expect(result.monorepo).toBe(true);
    expect(result.monorepoTool).toBe('nx');
  });

  it('returns monorepo: false for single-package project', async () => {
    writePkg(testDir, { express: '^4.0.0' });
    const result = await detect(testDir);
    expect(result.monorepo).toBe(false);
    expect(result.monorepoTool).toBe('none');
  });
});

describe('detect() — result structure', () => {
  it('always returns at least one package entry', async () => {
    writePkg(testDir, {});
    const result = await detect(testDir);
    expect(result.packages.length).toBeGreaterThanOrEqual(1);
  });

  it('returns correct rootPath in package detection', async () => {
    writePkg(testDir, { express: '^4.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].rootPath).toBe(testDir);
  });

  it('returns correct package name', async () => {
    writePkg(testDir, { express: '^4.0.0' });
    const result = await detect(testDir);
    expect(result.packages[0].name).toBe('test-app');
  });

  it('handles missing package.json gracefully', async () => {
    // No package.json — just an empty dir
    const result = await detect(testDir);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].backendFrameworks).toHaveLength(0);
  });
});
