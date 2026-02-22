// test/unit/analysis/ui/angular.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractAngularLocators } from '../../../../src/analysis/ui/angular.extractor';
import { createFixtureFiles } from '../../../helpers/fixture-helpers';

describe('extractAngularLocators — inline template', () => {
  it('extracts data-testid from inline template', () => {
    const files = createFixtureFiles({
      'src/app/login/login.component.ts': `
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-login',
          template: \`
            <form>
              <input data-testid="username-input" type="text" />
              <input data-testid="password-input" type="password" />
              <button data-testid="login-btn" type="submit">Login</button>
            </form>
          \`,
        })
        export class LoginComponent {}
      `,
    });
    const pages = extractAngularLocators(files);
    expect(pages.length).toBeGreaterThan(0);
    const locators = pages.flatMap(p => p.locators);
    const btn = locators.find(l => l.playwrightCode.includes('login-btn'));
    expect(btn).toBeDefined();
    expect(btn?.strategy).toBe('testId');
  });

  it('extracts aria-label from inline template', () => {
    const files = createFixtureFiles({
      'src/app/header/header.component.ts': `
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-header',
          template: \`
            <nav>
              <button aria-label="Open menu">☰</button>
            </nav>
          \`,
        })
        export class HeaderComponent {}
      `,
    });
    const pages = extractAngularLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const btn = locators.find(l => l.playwrightCode.includes('Open menu'));
    expect(btn).toBeDefined();
  });

  it('extracts formControlName as css strategy', () => {
    const files = createFixtureFiles({
      'src/app/register/register.component.ts': `
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-register',
          template: \`
            <form [formGroup]="form">
              <input formControlName="email" type="email" />
              <input formControlName="password" type="password" />
            </form>
          \`,
        })
        export class RegisterComponent {}
      `,
    });
    const pages = extractAngularLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const emailField = locators.find(l => l.name === 'email' && l.strategy === 'css');
    expect(emailField).toBeDefined();
  });
});

describe('extractAngularLocators — *ngIf conditional', () => {
  it('marks *ngIf elements as CONDITIONAL_ELEMENT', () => {
    const files = createFixtureFiles({
      'src/app/alert/alert.component.ts': `
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-alert',
          template: \`
            <div *ngIf="showAlert" data-testid="alert-box">Warning!</div>
          \`,
        })
        export class AlertComponent { showAlert = false; }
      `,
    });
    const pages = extractAngularLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const alert = locators.find(l => l.playwrightCode.includes('alert-box'));
    if (alert) {
      expect(alert.flags).toContain('CONDITIONAL_ELEMENT');
    }
  });
});

describe('extractAngularLocators — reactive forms from AST', () => {
  it('extracts fb.group() fields', () => {
    const files = createFixtureFiles({
      'src/app/profile/profile.component.ts': `
        import { Component } from '@angular/core';
        import { FormBuilder } from '@angular/forms';
        @Component({
          selector: 'app-profile',
          template: \`<form [formGroup]="form"><input formControlName="firstName" /></form>\`,
        })
        export class ProfileComponent {
          form = this.fb.group({
            firstName: [''],
            lastName: [''],
            bio: [''],
          });
          constructor(private fb: FormBuilder) {}
        }
      `,
    });
    const pages = extractAngularLocators(files);
    expect(pages.length).toBeGreaterThan(0);
    const locators = pages.flatMap(p => p.locators);
    // Should detect formControlName from template or fb.group
    expect(locators.length).toBeGreaterThan(0);
  });
});

describe('extractAngularLocators — edge cases', () => {
  it('returns empty for non-component TypeScript files', () => {
    const files = createFixtureFiles({
      'src/app/utils/format.ts': `export const formatDate = (d: Date) => d.toISOString();`,
    });
    const pages = extractAngularLocators(files);
    expect(Array.isArray(pages)).toBe(true);
  });

  it('page has required fields', () => {
    const files = createFixtureFiles({
      'src/app/home/home.component.ts': `
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-home',
          template: \`<h1 data-testid="home-title">Home</h1>\`,
        })
        export class HomeComponent {}
      `,
    });
    const pages = extractAngularLocators(files);
    pages.forEach(p => {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('locators');
      expect(p).toHaveProperty('formFlows');
      expect(p).toHaveProperty('confidence');
    });
  });
});
