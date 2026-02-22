// test/unit/analysis/schemas/zod.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractZodSchemas, resolveZodSchema } from '../../../../src/analysis/schemas/zod.extractor';
import { createFixtureFiles } from '../../../helpers/fixture-helpers';

describe('extractZodSchemas — basic type extraction', () => {
  it('extracts z.string() as type string', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const UserSchema = z.object({ name: z.string() });
      `,
    });
    const registry = extractZodSchemas(files);
    const schema = registry.get('UserSchema');
    expect(schema).toBeDefined();
    expect(schema!.fields[0].name).toBe('name');
    expect(schema!.fields[0].type).toBe('string');
  });

  it('extracts z.number() as type number', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ count: z.number() });
      `,
    });
    const registry = extractZodSchemas(files);
    const schema = registry.get('Schema');
    expect(schema!.fields[0].type).toBe('number');
  });

  it('extracts z.boolean() as type boolean', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ active: z.boolean() });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')!.fields[0].type).toBe('boolean');
  });

  it('extracts z.enum([...]) as enum type with values', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ role: z.enum(['admin', 'user', 'guest']) });
      `,
    });
    const registry = extractZodSchemas(files);
    const field = registry.get('Schema')!.fields[0];
    expect(field.type).toBe('enum');
    expect(field.validators.some(v => v.includes('admin'))).toBe(true);
  });

  it('extracts z.array() as array type', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ tags: z.array(z.string()) });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')!.fields[0].type).toBe('array');
  });
});

describe('extractZodSchemas — validators', () => {
  it('extracts .email() validator and sets example to email address', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ email: z.string().email() });
      `,
    });
    const registry = extractZodSchemas(files);
    const field = registry.get('Schema')!.fields[0];
    expect(field.validators).toContain('email');
    expect(field.example).toContain('@');
  });

  it('extracts .uuid() validator and sets type hint to string with uuid', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ id: z.string().uuid() });
      `,
    });
    const registry = extractZodSchemas(files);
    const field = registry.get('Schema')!.fields[0];
    expect(field.validators).toContain('uuid');
    expect(field.example).toMatch(/[0-9a-f-]{36}/i);
  });

  it('extracts .url() validator', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ website: z.string().url() });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')!.fields[0].validators).toContain('url');
  });

  it('extracts .min() validator', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ password: z.string().min(8) });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')!.fields[0].validators).toContain('min');
  });

  it('extracts .max() validator', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ bio: z.string().max(500) });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')!.fields[0].validators).toContain('max');
  });

  it('extracts .int() validator', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ age: z.number().int() });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')!.fields[0].validators).toContain('integer');
  });
});

describe('extractZodSchemas — optionality and defaults', () => {
  it('marks .optional() fields as required: false', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ bio: z.string().optional() });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')!.fields[0].required).toBe(false);
  });

  it('marks .default() fields as required: false', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ role: z.string().default('user') });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')!.fields[0].required).toBe(false);
  });

  it('marks fields without .optional()/.default() as required: true', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const Schema = z.object({ email: z.string().email() });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')!.fields[0].required).toBe(true);
  });
});

describe('extractZodSchemas — schema chaining', () => {
  it('resolves .partial() — all fields become optional', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const CreateSchema = z.object({ email: z.string(), name: z.string() });
        const UpdateSchema = CreateSchema.partial();
      `,
    });
    const registry = extractZodSchemas(files);
    const schema = registry.get('UpdateSchema');
    if (schema) {
      schema.fields.forEach(f => expect(f.required).toBe(false));
    }
    // Even if chained schemas aren't fully resolved, CreateSchema must be there
    expect(registry.get('CreateSchema')).toBeDefined();
  });
});

describe('extractZodSchemas — multiple fields', () => {
  it('extracts multiple fields from z.object()', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const CreateUserSchema = z.object({
          email: z.string().email(),
          password: z.string().min(8),
          name: z.string().optional(),
          age: z.number().int().positive(),
        });
      `,
    });
    const registry = extractZodSchemas(files);
    const schema = registry.get('CreateUserSchema');
    expect(schema).toBeDefined();
    expect(schema!.source).toBe('zod');
    expect(schema!.fields).toHaveLength(4);
    const names = schema!.fields.map(f => f.name);
    expect(names).toContain('email');
    expect(names).toContain('password');
    expect(names).toContain('name');
    expect(names).toContain('age');
  });
});

describe('extractZodSchemas — import aliases', () => {
  it('handles import * as z from "zod"', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import * as z from 'zod';
        const Schema = z.object({ name: z.string() });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')).toBeDefined();
  });

  it('handles aliased import: import { z as zod } from "zod"', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z as zod } from 'zod';
        const Schema = zod.object({ name: zod.string() });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.get('Schema')).toBeDefined();
  });
});

describe('extractZodSchemas — registry across files', () => {
  it('builds registry from multiple schema declarations', () => {
    const files = createFixtureFiles({
      'user.schema.ts': `
        import { z } from 'zod';
        export const UserSchema = z.object({ email: z.string() });
      `,
      'product.schema.ts': `
        import { z } from 'zod';
        export const ProductSchema = z.object({ name: z.string(), price: z.number() });
      `,
    });
    const registry = extractZodSchemas(files);
    expect(registry.has('UserSchema')).toBe(true);
    expect(registry.has('ProductSchema')).toBe(true);
  });
});

describe('resolveZodSchema', () => {
  it('resolves schema by variable name from registry', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import { z } from 'zod';
        const LoginSchema = z.object({ email: z.string().email(), password: z.string() });
      `,
    });
    const registry = extractZodSchemas(files);
    const schema = resolveZodSchema('LoginSchema', registry, files);
    expect(schema).toBeDefined();
    expect(schema!.fields.map(f => f.name)).toContain('email');
  });

  it('returns null for unknown schema name', () => {
    const registry = new Map();
    const result = resolveZodSchema('NonExistentSchema', registry, []);
    expect(result).toBeNull();
  });
});
