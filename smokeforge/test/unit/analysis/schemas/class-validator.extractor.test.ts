// test/unit/analysis/schemas/class-validator.extractor.test.ts
import { describe, it, expect } from 'vitest';
import {
  extractClassValidatorSchemas,
  resolveClassValidatorSchema,
} from '../../../../src/analysis/schemas/class-validator.extractor';
import { createFixtureFiles } from '../../../helpers/fixture-helpers';

describe('extractClassValidatorSchemas — basic class extraction', () => {
  it('extracts a DTO class with @IsString() decorator', () => {
    const files = createFixtureFiles({
      'dto/create-user.dto.ts': `
        import { IsString, IsEmail, IsOptional } from 'class-validator';
        export class CreateUserDto {
          @IsEmail()
          email: string;

          @IsString()
          name: string;

          @IsString()
          @IsOptional()
          bio: string;
        }
      `,
    });
    const registry = extractClassValidatorSchemas(files);
    const schema = registry.get('CreateUserDto');
    expect(schema).toBeDefined();
    expect(schema!.source).toBe('class-validator');
    const names = schema!.fields.map(f => f.name);
    expect(names).toContain('email');
    expect(names).toContain('name');
    expect(names).toContain('bio');
  });

  it('extracts @IsEmail() as email validator', () => {
    const files = createFixtureFiles({
      'dto.ts': `
        import { IsEmail } from 'class-validator';
        export class LoginDto {
          @IsEmail()
          email: string;
        }
      `,
    });
    const registry = extractClassValidatorSchemas(files);
    const field = registry.get('LoginDto')!.fields.find(f => f.name === 'email');
    expect(field).toBeDefined();
    expect(field!.validators.some(v => v.toLowerCase().includes('email'))).toBe(true);
  });

  it('marks @IsOptional() fields as required: false', () => {
    const files = createFixtureFiles({
      'dto.ts': `
        import { IsString, IsOptional } from 'class-validator';
        export class UpdateDto {
          @IsString()
          @IsOptional()
          bio: string;
        }
      `,
    });
    const registry = extractClassValidatorSchemas(files);
    const field = registry.get('UpdateDto')!.fields.find(f => f.name === 'bio');
    expect(field).toBeDefined();
    expect(field!.required).toBe(false);
  });

  it('extracts number type from TypeScript annotation', () => {
    const files = createFixtureFiles({
      'dto.ts': `
        import { IsNumber } from 'class-validator';
        export class PriceDto {
          @IsNumber()
          price: number;
        }
      `,
    });
    const registry = extractClassValidatorSchemas(files);
    const field = registry.get('PriceDto')!.fields.find(f => f.name === 'price');
    expect(field).toBeDefined();
    expect(field!.type).toBe('number');
  });

  it('extracts boolean type from TypeScript annotation', () => {
    const files = createFixtureFiles({
      'dto.ts': `
        import { IsBoolean } from 'class-validator';
        export class StatusDto {
          @IsBoolean()
          active: boolean;
        }
      `,
    });
    const registry = extractClassValidatorSchemas(files);
    const field = registry.get('StatusDto')!.fields.find(f => f.name === 'active');
    expect(field).toBeDefined();
    expect(field!.type).toBe('boolean');
  });

  it('handles @MinLength() and @MaxLength() validators', () => {
    const files = createFixtureFiles({
      'dto.ts': `
        import { IsString, MinLength, MaxLength } from 'class-validator';
        export class PasswordDto {
          @IsString()
          @MinLength(8)
          @MaxLength(100)
          password: string;
        }
      `,
    });
    const registry = extractClassValidatorSchemas(files);
    const field = registry.get('PasswordDto')!.fields.find(f => f.name === 'password');
    expect(field).toBeDefined();
    // Validators should include minLength or maxLength info
    expect(field!.validators.length).toBeGreaterThan(0);
  });
});

describe('extractClassValidatorSchemas — multiple DTOs', () => {
  it('extracts multiple DTO classes from same file', () => {
    const files = createFixtureFiles({
      'dto.ts': `
        import { IsString, IsEmail } from 'class-validator';
        export class LoginDto {
          @IsEmail()
          email: string;
          @IsString()
          password: string;
        }
        export class RegisterDto {
          @IsEmail()
          email: string;
          @IsString()
          name: string;
          @IsString()
          password: string;
        }
      `,
    });
    const registry = extractClassValidatorSchemas(files);
    expect(registry.has('LoginDto')).toBe(true);
    expect(registry.has('RegisterDto')).toBe(true);
  });

  it('extracts DTOs across multiple files', () => {
    const files = createFixtureFiles({
      'user.dto.ts': `
        import { IsString, IsEmail } from 'class-validator';
        export class CreateUserDto {
          @IsEmail() email: string;
          @IsString() name: string;
        }
      `,
      'product.dto.ts': `
        import { IsString, IsNumber } from 'class-validator';
        export class CreateProductDto {
          @IsString() name: string;
          @IsNumber() price: number;
        }
      `,
    });
    const registry = extractClassValidatorSchemas(files);
    expect(registry.has('CreateUserDto')).toBe(true);
    expect(registry.has('CreateProductDto')).toBe(true);
  });
});

describe('resolveClassValidatorSchema', () => {
  it('resolves DTO by class name', () => {
    const files = createFixtureFiles({
      'dto.ts': `
        import { IsString, IsEmail } from 'class-validator';
        export class LoginDto {
          @IsEmail()
          email: string;
        }
      `,
    });
    const registry = extractClassValidatorSchemas(files);
    const schema = resolveClassValidatorSchema('LoginDto', registry, files);
    expect(schema).toBeDefined();
  });

  it('returns null for unknown class name', () => {
    const registry = new Map();
    const result = resolveClassValidatorSchema('UnknownDto', registry, []);
    expect(result).toBeNull();
  });
});
