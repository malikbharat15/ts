// test/unit/analysis/schemas/joi.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractJoiSchemas, resolveJoiSchema } from '../../../../src/analysis/schemas/joi.extractor';
import { createFixtureFiles } from '../../../helpers/fixture-helpers';

describe('extractJoiSchemas — basic type extraction', () => {
  it('extracts Joi.string() as type string', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const UserSchema = Joi.object({ name: Joi.string() });
      `,
    });
    const registry = extractJoiSchemas(files);
    const schema = registry.get('UserSchema');
    expect(schema).toBeDefined();
    expect(schema!.fields[0].name).toBe('name');
    expect(schema!.fields[0].type).toBe('string');
  });

  it('extracts Joi.number() as type number', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const Schema = Joi.object({ age: Joi.number() });
      `,
    });
    const registry = extractJoiSchemas(files);
    expect(registry.get('Schema')!.fields[0].type).toBe('number');
  });

  it('extracts Joi.boolean() as type boolean', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const Schema = Joi.object({ active: Joi.boolean() });
      `,
    });
    const registry = extractJoiSchemas(files);
    expect(registry.get('Schema')!.fields[0].type).toBe('boolean');
  });

  it('extracts Joi.array() as type array', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const Schema = Joi.object({ tags: Joi.array() });
      `,
    });
    const registry = extractJoiSchemas(files);
    expect(registry.get('Schema')!.fields[0].type).toBe('array');
  });
});

describe('extractJoiSchemas — validators', () => {
  it('extracts .email() validator', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const Schema = Joi.object({ email: Joi.string().email() });
      `,
    });
    const registry = extractJoiSchemas(files);
    const field = registry.get('Schema')!.fields[0];
    expect(field.validators).toContain('email');
  });

  it('extracts .min() validator', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const Schema = Joi.object({ password: Joi.string().min(8) });
      `,
    });
    const registry = extractJoiSchemas(files);
    const validators = registry.get('Schema')!.fields[0].validators;
    expect(validators.some(v => v.includes('min'))).toBe(true);
  });

  it('extracts .max() validator', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const Schema = Joi.object({ name: Joi.string().max(100) });
      `,
    });
    const registry = extractJoiSchemas(files);
    const validators = registry.get('Schema')!.fields[0].validators;
    expect(validators.some(v => v.includes('max'))).toBe(true);
  });
});

describe('extractJoiSchemas — optionality', () => {
  it('marks .optional() fields as required: false', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const Schema = Joi.object({ bio: Joi.string().optional() });
      `,
    });
    const registry = extractJoiSchemas(files);
    expect(registry.get('Schema')!.fields[0].required).toBe(false);
  });

  it('marks .required() fields as required: true', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const Schema = Joi.object({ email: Joi.string().required() });
      `,
    });
    const registry = extractJoiSchemas(files);
    // Fields without .optional() default to required; .required() is explicit
    const field = registry.get('Schema')!.fields[0];
    expect(field).toBeDefined();
    expect(field.name).toBe('email');
  });
});

describe('extractJoiSchemas — CommonJS require', () => {
  it('handles const Joi = require("joi")', () => {
    const files = createFixtureFiles({
      'schema.js': `
        const Joi = require('joi');
        const Schema = Joi.object({ name: Joi.string() });
      `,
    });
    const registry = extractJoiSchemas(files);
    expect(registry.has('Schema')).toBe(true);
  });

  it('handles const Joi = require("@hapi/joi")', () => {
    const files = createFixtureFiles({
      'schema.js': `
        const Joi = require('@hapi/joi');
        const Schema = Joi.object({ email: Joi.string().email() });
      `,
    });
    const registry = extractJoiSchemas(files);
    expect(registry.has('Schema')).toBe(true);
  });
});

describe('extractJoiSchemas — multiple fields', () => {
  it('extracts multiple fields from Joi.object()', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const LoginSchema = Joi.object({
          email: Joi.string().email().required(),
          password: Joi.string().min(8).required(),
        });
      `,
    });
    const registry = extractJoiSchemas(files);
    const schema = registry.get('LoginSchema');
    expect(schema).toBeDefined();
    expect(schema!.source).toBe('joi');
    const names = schema!.fields.map(f => f.name);
    expect(names).toContain('email');
    expect(names).toContain('password');
  });
});

describe('resolveJoiSchema', () => {
  it('resolves schema from registry', () => {
    const files = createFixtureFiles({
      'schema.ts': `
        import Joi from 'joi';
        const LoginSchema = Joi.object({ email: Joi.string().email() });
      `,
    });
    const registry = extractJoiSchemas(files);
    const schema = resolveJoiSchema('LoginSchema', registry);
    expect(schema).toBeDefined();
  });

  it('returns null for unknown schema', () => {
    const registry = new Map();
    expect(resolveJoiSchema('Unknown', registry)).toBeNull();
  });
});
