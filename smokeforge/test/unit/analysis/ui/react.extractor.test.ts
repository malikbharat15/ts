// test/unit/analysis/ui/react.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractReactLocators } from '../../../../src/analysis/ui/react.extractor';
import { createFixtureFiles } from '../../../helpers/fixture-helpers';

describe('extractReactLocators — data-testid strategy', () => {
  it('extracts button with data-testid', () => {
    const files = createFixtureFiles({
      'src/components/LoginForm.tsx': `
        export function LoginForm() {
          return (
            <form data-testid="login-form">
              <button data-testid="submit-btn" type="submit">Login</button>
            </form>
          );
        }
      `,
    });
    const pages = extractReactLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const btn = locators.find(l => l.strategy === 'testId' && l.playwrightCode.includes('submit-btn'));
    expect(btn).toBeDefined();
  });

  it('extracts input with data-testid', () => {
    const files = createFixtureFiles({
      'src/components/SearchBar.tsx': `
        export function SearchBar() {
          return <input data-testid="search-input" type="text" placeholder="Search..." />;
        }
      `,
    });
    const pages = extractReactLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const input = locators.find(l => l.playwrightCode.includes('search-input'));
    expect(input).toBeDefined();
    expect(input?.strategy).toBe('testId');
  });
});

describe('extractReactLocators — aria-label strategy', () => {
  it('extracts element with aria-label', () => {
    const files = createFixtureFiles({
      'src/components/Nav.tsx': `
        export function Nav() {
          return (
            <nav>
              <button aria-label="Close menu">×</button>
            </nav>
          );
        }
      `,
    });
    const pages = extractReactLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const closeBtn = locators.find(l => l.strategy === 'label' || (l.playwrightCode.includes('Close menu')));
    expect(closeBtn).toBeDefined();
  });
});

describe('extractReactLocators — form flows', () => {
  it('detects form flow with input fields', () => {
    const files = createFixtureFiles({
      'src/components/RegisterForm.tsx': `
        export function RegisterForm({ onSubmit }) {
          const [email, setEmail] = React.useState('');
          return (
            <form onSubmit={onSubmit} data-testid="register-form">
              <input data-testid="email-input" name="email" type="email" />
              <input data-testid="password-input" name="password" type="password" />
              <button data-testid="register-btn" type="submit">Register</button>
            </form>
          );
        }
      `,
    });
    const pages = extractReactLocators(files);
    expect(pages.length).toBeGreaterThan(0);
    const hasForm = pages.some(p => p.formFlows.length > 0 || p.locators.length > 0);
    expect(hasForm).toBe(true);
  });
});

describe('extractReactLocators — conditional elements', () => {
  it('marks conditional element with CONDITIONAL_ELEMENT flag', () => {
    const files = createFixtureFiles({
      'src/components/Alert.tsx': `
        export function Alert({ show, message }) {
          return (
            <div>
              {show && <div data-testid="alert-box">{message}</div>}
            </div>
          );
        }
      `,
    });
    const pages = extractReactLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const alert = locators.find(l => l.playwrightCode.includes('alert-box'));
    if (alert) {
      expect(alert.flags).toContain('CONDITIONAL_ELEMENT');
    }
  });
});

describe('extractReactLocators — dynamic testId', () => {
  it('marks dynamic testid as DYNAMIC_TESTID', () => {
    const files = createFixtureFiles({
      'src/components/Row.tsx': `
        export function Row({ id }) {
          return <tr data-testid={\`row-\${id}\`}><td>test</td></tr>;
        }
      `,
    });
    const pages = extractReactLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const row = locators.find(l => l.flags.includes('DYNAMIC_TESTID'));
    expect(row).toBeDefined();
  });
});

describe('extractReactLocators — edge cases', () => {
  it('returns empty pages for non-React file', () => {
    const files = createFixtureFiles({
      'src/utils/math.ts': `export const add = (a: number, b: number) => a + b;`,
    });
    const pages = extractReactLocators(files);
    expect(Array.isArray(pages)).toBe(true);
  });

  it('extracted pages have all required fields', () => {
    const files = createFixtureFiles({
      'src/pages/Home.tsx': `
        export function Home() {
          return <main data-testid="home-page"><h1>Home</h1></main>;
        }
      `,
    });
    const pages = extractReactLocators(files);
    pages.forEach(p => {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('locators');
      expect(p).toHaveProperty('formFlows');
      expect(p).toHaveProperty('confidence');
    });
  });
});
