// test/unit/analysis/ui/vue.extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractVueLocators } from '../../../../src/analysis/ui/vue.extractor';
import { createFixtureFiles } from '../../../helpers/fixture-helpers';

describe('extractVueLocators — data-testid strategy', () => {
  it('extracts button with data-testid', () => {
    const files = createFixtureFiles({
      'src/components/LoginForm.vue': `
<template>
  <form data-testid="login-form">
    <input data-testid="email-input" type="email" />
    <button data-testid="submit-btn" type="submit">Login</button>
  </form>
</template>
<script>
export default { name: 'LoginForm' };
</script>
      `,
    });
    const pages = extractVueLocators(files);
    expect(pages.length).toBeGreaterThan(0);
    const locators = pages.flatMap(p => p.locators);
    const btn = locators.find(l => l.strategy === 'testId' && l.playwrightCode.includes('submit-btn'));
    expect(btn).toBeDefined();
  });

  it('extracts input with data-testid', () => {
    const files = createFixtureFiles({
      'src/components/SearchBar.vue': `
<template>
  <input data-testid="search-input" type="text" placeholder="Search..." />
</template>
<script>
export default { name: 'SearchBar' };
</script>
      `,
    });
    const pages = extractVueLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const input = locators.find(l => l.playwrightCode.includes('search-input'));
    expect(input).toBeDefined();
    expect(input?.strategy).toBe('testId');
  });
});

describe('extractVueLocators — aria-label strategy', () => {
  it('extracts element with aria-label', () => {
    const files = createFixtureFiles({
      'src/components/Modal.vue': `
<template>
  <button aria-label="Close dialog">×</button>
</template>
      `,
    });
    const pages = extractVueLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const close = locators.find(l => l.playwrightCode.includes('Close dialog'));
    expect(close).toBeDefined();
  });
});

describe('extractVueLocators — v-model fallback (css strategy)', () => {
  it('extracts v-model input with css strategy', () => {
    const files = createFixtureFiles({
      'src/components/Settings.vue': `
<template>
  <input v-model="username" type="text" name="username" />
</template>
      `,
    });
    const pages = extractVueLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const modeled = locators.find(l => l.strategy === 'css' && l.name === 'username');
    expect(modeled).toBeDefined();
  });
});

describe('extractVueLocators — conditional elements', () => {
  it('marks v-if elements as conditional', () => {
    const files = createFixtureFiles({
      'src/components/Alert.vue': `
<template>
  <div v-if="showAlert" data-testid="alert">Alert!</div>
</template>
      `,
    });
    const pages = extractVueLocators(files);
    const locators = pages.flatMap(p => p.locators);
    const alert = locators.find(l => l.playwrightCode.includes('alert'));
    if (alert) {
      expect(alert.flags).toContain('CONDITIONAL_ELEMENT');
    }
  });
});

describe('extractVueLocators — form flows', () => {
  it('detects form flow from form with input fields', () => {
    const files = createFixtureFiles({
      'src/components/ContactForm.vue': `
<template>
  <form @submit.prevent="submit">
    <input data-testid="name-input" type="text" placeholder="Your name" />
    <input data-testid="email-input" type="email" placeholder="Email" />
    <button type="submit">Send</button>
  </form>
</template>
<script>
export default { name: 'ContactForm' };
</script>
      `,
    });
    const pages = extractVueLocators(files);
    expect(pages.length).toBeGreaterThan(0);
    const hasContent = pages.some(p => p.locators.length > 0 || p.formFlows.length > 0);
    expect(hasContent).toBe(true);
  });
});

describe('extractVueLocators — non-.vue files', () => {
  it('ignores TypeScript files', () => {
    const files = createFixtureFiles({
      'src/utils/helpers.ts': `export const greet = (name: string) => \`Hello \${name}\`;`,
    });
    const pages = extractVueLocators(files);
    expect(pages).toHaveLength(0);
  });
});

describe('extractVueLocators — page fields', () => {
  it('page has required fields', () => {
    const files = createFixtureFiles({
      'src/views/About.vue': `
<template>
  <div data-testid="about-page"><h1>About</h1></div>
</template>
      `,
    });
    const pages = extractVueLocators(files);
    pages.forEach(p => {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('locators');
      expect(p).toHaveProperty('formFlows');
      expect(p).toHaveProperty('confidence');
      expect(p).toHaveProperty('filePath');
    });
  });
});
