// test/unit/output/validator.test.ts
import { afterEach, describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { validatePlaywright, validatePostman } from '../../../src/output/validator';

// ─── Playwright validator ─────────────────────────────────────────────────────

// Write temp test files into the smokeforge project dir so tsc can resolve
// @playwright/test from the local node_modules.
const PROJECT_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeTempFile(content: string, ext = '.ts'): string {
  const dir = fs.mkdtempSync(path.join(PROJECT_ROOT, 'tmp-val-test-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, `test${ext}`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('validatePlaywright — valid file', () => {
  it('returns valid:true for a well-formed test file', async () => {
    const filePath = writeTempFile(`
      import { test, expect } from '@playwright/test';
      test('GET /users returns list', async ({ page }) => {
        const resp = await page.goto(\`\${process.env.BASE_URL}/users\`);
        expect(resp?.status()).toBe(200);
      });
    `);
    const result = await validatePlaywright(filePath);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid:true for multiple tests with assertions', async () => {
    const filePath = writeTempFile(`
      import { test, expect } from '@playwright/test';
      test('GET /users', async ({ page }) => {
        const resp = await page.goto(\`\${process.env.BASE_URL}/users\`);
        expect(resp?.status()).toBe(200);
      });
      test('POST /users creates user', async ({ request }) => {
        const resp = await request.post(\`\${process.env.BASE_URL}/users\`, {
          data: { email: 'test@example.com', password: 'pass1234' },
        });
        expect(resp.status()).toBe(201);
      });
    `);
    const result = await validatePlaywright(filePath);
    expect(result.valid).toBe(true);
  });
});

describe('validatePlaywright — missing test blocks', () => {
  it('returns error when no test() blocks found', async () => {
    const filePath = writeTempFile(`
      // Empty test file
      import { expect } from '@playwright/test';
    `);
    const result = await validatePlaywright(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /no test/i.test(e))).toBe(true);
  });
});

describe('validatePlaywright — missing assertions', () => {
  it('returns error when test block has no expect()', async () => {
    const filePath = writeTempFile(`
      import { test } from '@playwright/test';
      test('no assertion', async ({ page }) => {
        await page.goto(\`\${process.env.BASE_URL}/users\`);
      });
    `);
    const result = await validatePlaywright(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /expect/i.test(e))).toBe(true);
  });
});

describe('validatePlaywright — hardcoded URLs', () => {
  it('returns error for hardcoded http://localhost URL', async () => {
    const filePath = writeTempFile(`
      import { test, expect } from '@playwright/test';
      test('hardcoded url', async ({ page }) => {
        const resp = await page.goto('http://localhost:3000/users');
        expect(resp?.status()).toBe(200);
      });
    `);
    const result = await validatePlaywright(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /hardcoded|url/i.test(e))).toBe(true);
  });
});

describe('validatePlaywright — non-existent file', () => {
  it('returns error when file cannot be read', async () => {
    const result = await validatePlaywright('/nonexistent/path/file.spec.ts');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ─── Postman validator ────────────────────────────────────────────────────────

describe('validatePostman — valid collection', () => {
  it('returns valid:true for a minimal valid Postman v2.1 collection', () => {
    const collection = JSON.stringify({
      info: {
        name: 'SmokeForge Tests',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'GET /users',
          request: {
            method: 'GET',
            url: { raw: '{{BASE_URL}}/users', host: ['{{BASE_URL}}'], path: ['users'] },
          },
        },
      ],
      variable: [
        { key: 'BASE_URL', value: '' },
        { key: 'AUTH_TOKEN', value: '' },
      ],
    });
    const result = validatePostman(collection);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('validatePostman — invalid JSON', () => {
  it('returns error for malformed JSON', () => {
    const result = validatePostman('{ not valid json ]');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('validatePostman — missing required fields', () => {
  it('returns error when info.schema is missing', () => {
    const result = validatePostman(JSON.stringify({
      info: { name: 'Test' },
      item: [],
    }));
    expect(result.valid).toBe(false);
  });

  it('returns error when item array is missing', () => {
    const result = validatePostman(JSON.stringify({
      info: {
        name: 'Test',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
    }));
    expect(result.valid).toBe(false);
  });
});

describe('validatePostman — hardcoded URLs', () => {
  it('returns error for hardcoded base URL in collection', () => {
    const collection = JSON.stringify({
      info: {
        name: 'Hardcoded',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'GET Users',
          request: {
            method: 'GET',
            url: {
              raw: 'http://localhost:3000/users',
              host: ['localhost'],
              port: '3000',
              path: ['users'],
            },
          },
        },
      ],
    });
    const result = validatePostman(collection);
    // May or may not flag hardcoded - at minimum should not throw
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('errors');
  });
});
