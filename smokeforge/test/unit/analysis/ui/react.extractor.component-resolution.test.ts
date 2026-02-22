// test/unit/analysis/ui/react.extractor.component-resolution.test.ts
//
// Tests for component prop-passing resolution (Phase 19).
// Also acts as regression guard for all Phase 18 HTML-native locator fixes.
//
// Architecture under test:
//   buildComponentRegistry()      — pre-pass over component files
//   resolveComponentLocators()    — call-site prop substitution
//   extractReactLocators()        — two-pass integration (HTML + components)

import { describe, it, expect } from "vitest";
import { createFixtureFiles } from "../../../helpers/fixture-helpers";
import {
  buildComponentRegistry,
  componentNameFromPath,
  resolvePropTemplate,
  resolveComponentLocators,
} from "../../../../src/analysis/ui/component-registry";
import { extractReactLocators } from "../../../../src/analysis/ui/react.extractor";

// ─── Unit: componentNameFromPath ─────────────────────────────────────────────

describe("componentNameFromPath", () => {
  it("extracts PascalCase name from file basename", () => {
    expect(componentNameFromPath("components/ButtonGroup.tsx")).toBe("ButtonGroup");
    expect(componentNameFromPath("ui/TextInput.tsx")).toBe("TextInput");
    expect(componentNameFromPath("src/components/UserCard.jsx")).toBe("UserCard");
  });

  it("uses parent folder name for index files", () => {
    expect(componentNameFromPath("components/Modal/index.tsx")).toBe("Modal");
    expect(componentNameFromPath("ui/DataTable/index.jsx")).toBe("DataTable");
  });

  it("returns null for non-PascalCase names (utilities, hooks)", () => {
    expect(componentNameFromPath("utils/formatDate.ts")).toBeNull();
    expect(componentNameFromPath("hooks/useAuth.ts")).toBeNull();
    expect(componentNameFromPath("lib/helpers.tsx")).toBeNull();
  });

  it("returns null for route files (handled separately)", () => {
    // Note: routes filtering is in buildComponentRegistry, not componentNameFromPath
    // componentNameFromPath just cares about the name format
    expect(componentNameFromPath("routes/Dashboard.tsx")).toBe("Dashboard");
  });
});

// ─── Unit: resolvePropTemplate ────────────────────────────────────────────────

describe("resolvePropTemplate", () => {
  it("substitutes a static prop value", () => {
    const props = new Map([["label", "Export"]]);
    const result = resolvePropTemplate(
      "page.getByRole('button', { name: '{{label}}' })",
      props
    );
    expect(result.resolved).toBe("page.getByRole('button', { name: 'Export' })");
    expect(result.hasUnresolved).toBe(false);
  });

  it("emits [propName] for dynamic/missing props and sets hasUnresolved", () => {
    const props = new Map<string, string | null>([["label", null]]);
    const result = resolvePropTemplate(
      "page.getByRole('button', { name: '{{label}}' })",
      props
    );
    expect(result.resolved).toBe("page.getByRole('button', { name: '[label]' })");
    expect(result.hasUnresolved).toBe(true);
  });

  it("emits [propName] when prop is not passed at all", () => {
    const props = new Map<string, string | null>();
    const result = resolvePropTemplate(
      "page.getByPlaceholder('{{hint}}')",
      props
    );
    expect(result.resolved).toBe("page.getByPlaceholder('[hint]')");
    expect(result.hasUnresolved).toBe(true);
  });

  it("substitutes multiple props at once", () => {
    const props = new Map([["role", "button"], ["label", "Submit"]]);
    const result = resolvePropTemplate(
      "page.getByRole('{{role}}', { name: '{{label}}' })",
      props
    );
    expect(result.resolved).toBe("page.getByRole('button', { name: 'Submit' })");
    expect(result.hasUnresolved).toBe(false);
  });

  it("handles mixed static and dynamic props", () => {
    const props = new Map<string, string | null>([["label", "Save"], ["hint", null]]);
    const result = resolvePropTemplate(
      "page.getByRole('button', { name: '{{label}}' }) /* hint='{{hint}}' */",
      props
    );
    expect(result.resolved).toContain("Save");
    expect(result.resolved).toContain("[hint]");
    expect(result.hasUnresolved).toBe(true);
  });
});

// ─── Unit: buildComponentRegistry ────────────────────────────────────────────

describe("buildComponentRegistry", () => {
  it("extracts aria-label prop template from a component file", () => {
    const files = createFixtureFiles({
      "components/IconButton.tsx": `
        export function IconButton({ label }: { label: string }) {
          return <button aria-label={label}>icon</button>;
        }
      `,
    });
    const registry = buildComponentRegistry(files);
    expect(registry.has("IconButton")).toBe(true);
    const templates = registry.get("IconButton")!;
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0].playwrightCodeTemplate).toBe(
      "page.getByRole('button', { name: '{{label}}' })"
    );
    expect(templates[0].props).toContain("label");
  });

  it("extracts static text button as a template (no props)", () => {
    const files = createFixtureFiles({
      "components/LogoutButton.tsx": `
        export function LogoutButton() {
          return <button>Log out</button>;
        }
      `,
    });
    const registry = buildComponentRegistry(files);
    expect(registry.has("LogoutButton")).toBe(true);
    const templates = registry.get("LogoutButton")!;
    expect(templates[0].playwrightCodeTemplate).toBe(
      "page.getByRole('button', { name: 'Log out' })"
    );
    expect(templates[0].props).toHaveLength(0);
  });

  it("extracts placeholder prop template from an input component", () => {
    const files = createFixtureFiles({
      "components/TextInput.tsx": `
        export function TextInput({ placeholder }: { placeholder: string }) {
          return <input type="text" placeholder={placeholder} />;
        }
      `,
    });
    const registry = buildComponentRegistry(files);
    expect(registry.has("TextInput")).toBe(true);
    const templates = registry.get("TextInput")!;
    expect(templates[0].playwrightCodeTemplate).toBe("page.getByPlaceholder('{{placeholder}}')");
    expect(templates[0].props).toContain("placeholder");
  });

  it("skips route files (files under /routes/)", () => {
    const files = createFixtureFiles({
      "app/routes/Dashboard.tsx": `
        export default function Dashboard() {
          return <button>Submit</button>;
        }
      `,
    });
    const registry = buildComponentRegistry(files);
    // Route files must not be indexed as components
    expect(registry.has("Dashboard")).toBe(false);
  });

  it("skips non-PascalCase utility files", () => {
    const files = createFixtureFiles({
      "utils/helpers.tsx": `
        export function getLabel() {
          return <span>helper</span>;
        }
      `,
    });
    const registry = buildComponentRegistry(files);
    expect(registry.size).toBe(0);
  });

  it("handles index.tsx by using the parent folder name", () => {
    const files = createFixtureFiles({
      "components/Modal/index.tsx": `
        export function Modal({ title }: { title: string }) {
          return <dialog role="dialog" aria-label={title}>content</dialog>;
        }
      `,
    });
    const registry = buildComponentRegistry(files);
    expect(registry.has("Modal")).toBe(true);
  });

  it("does not crash on a component file with no HTML elements", () => {
    const files = createFixtureFiles({
      "components/EmptyComp.tsx": `
        export function EmptyComp() {
          return <AnotherComponent />;
        }
      `,
    });
    // Should produce no templates but should not throw
    expect(() => buildComponentRegistry(files)).not.toThrow();
    const registry = buildComponentRegistry(files);
    expect(registry.has("EmptyComp")).toBe(false);
  });
});

// ─── Unit: resolveComponentLocators ──────────────────────────────────────────

describe("resolveComponentLocators", () => {
  let idSeq = 0;
  const makeId = () => `loc_${String(++idSeq).padStart(4, "0")}`;

  it("resolves a static aria-label prop to a concrete locator", () => {
    const files = createFixtureFiles({
      "components/ActionButton.tsx": `
        export function ActionButton({ label }: { label: string }) {
          return <button aria-label={label}>x</button>;
        }
      `,
    });
    const registry = buildComponentRegistry(files);
    // Simulate call site: <ActionButton label="Export" />
    // We'll parse a real call-site file to get actual JSX attributes
    const callSiteFiles = createFixtureFiles({
      "app/routes/report.tsx": `
        import { ActionButton } from '~/components/ActionButton';
        export default function Report() {
          return <ActionButton label="Export" />;
        }
      `,
    });
    // Extract locators from call site using full two-pass
    const allFiles = [...files, ...callSiteFiles];
    const pages = extractReactLocators(allFiles);
    const reportPage = pages.find((p) => p.filePath.includes("report.tsx"));
    expect(reportPage).toBeDefined();
    const exportBtn = reportPage!.locators.find((l) =>
      l.playwrightCode.includes("Export")
    );
    expect(exportBtn).toBeDefined();
    expect(exportBtn!.playwrightCode).toBe(
      "page.getByRole('button', { name: 'Export' })"
    );
    expect(exportBtn!.strategy).toBe("role");
  });

  it("emits DYNAMIC_PROP flag when call-site prop is dynamic", () => {
    const files = createFixtureFiles({
      "components/ActionButton.tsx": `
        export function ActionButton({ label }: { label: string }) {
          return <button aria-label={label}>x</button>;
        }
      `,
      "app/routes/report.tsx": `
        export default function Report({ actionLabel }: { actionLabel: string }) {
          return <ActionButton label={actionLabel} />;
        }
      `,
    });
    const pages = extractReactLocators(files);
    const reportPage = pages.find((p) => p.filePath.includes("report.tsx"));
    expect(reportPage).toBeDefined();
    const dynBtn = reportPage!.locators.find((l) =>
      l.playwrightCode.includes("[label]")
    );
    expect(dynBtn).toBeDefined();
    expect(dynBtn!.flags).toContain("DYNAMIC_PROP");
    expect(dynBtn!.isDynamic).toBe(true);
  });

  it("does not crash or emit locators for PascalCase with no registry entry", () => {
    const files = createFixtureFiles({
      "app/routes/home.tsx": `
        export default function Home() {
          return <UnknownWidget foo="bar" />;
        }
      `,
    });
    // No component files — empty registry
    expect(() => extractReactLocators(files)).not.toThrow();
    // No locators expected since the component has no HTML
    const pages = extractReactLocators(files);
    const home = pages.find((p) => p.filePath.includes("home.tsx"));
    // page is either absent (no locators) or present with 0 component locators
    if (home) {
      const unknownLoc = home.locators.find((l) =>
        l.playwrightCode.includes("UnknownWidget")
      );
      expect(unknownLoc).toBeUndefined();
    }
  });

  it("does not duplicate locators when HTML and component resolve to same code", () => {
    // Component has <button aria-label={label}>
    // Route also has a literal <button aria-label="Export"> (same text)
    const files = createFixtureFiles({
      "components/ExportBtn.tsx": `
        export function ExportBtn({ label }: { label: string }) {
          return <button aria-label={label}>x</button>;
        }
      `,
      "app/routes/data.tsx": `
        export default function Data() {
          return (
            <div>
              <button aria-label="Export">Export</button>
              <ExportBtn label="Export" />
            </div>
          );
        }
      `,
    });
    const pages = extractReactLocators(files);
    const dataPage = pages.find((p) => p.filePath.includes("data.tsx"));
    expect(dataPage).toBeDefined();
    const exportLocators = dataPage!.locators.filter((l) =>
      l.playwrightCode === "page.getByRole('button', { name: 'Export' })"
    );
    // Must appear exactly once — dedup must work
    expect(exportLocators).toHaveLength(1);
  });
});

// ─── Integration: two-pass with mixed HTML + components ──────────────────────

describe("extractReactLocators — component resolution integration", () => {
  it("extracts locators from both HTML and component calls on the same route", () => {
    const files = createFixtureFiles({
      "components/SubmitButton.tsx": `
        export function SubmitButton({ label }: { label: string }) {
          return <button type="submit" aria-label={label}>{label}</button>;
        }
      `,
      "app/routes/login.tsx": `
        export default function Login() {
          return (
            <form>
              <label>Email<input type="email" /></label>
              <label>Password<input type="password" /></label>
              <SubmitButton label="Sign in" />
            </form>
          );
        }
      `,
    });
    const pages = extractReactLocators(files);
    const loginPage = pages.find((p) => p.filePath.includes("login.tsx"));
    expect(loginPage).toBeDefined();

    const codes = loginPage!.locators.map((l) => l.playwrightCode);

    // HTML-native locators still work (regression)
    expect(codes).toContain("page.getByLabel('Email')");
    expect(codes).toContain("page.locator('input[type=\"password\"]')");

    // Component-resolved locator
    expect(codes).toContain("page.getByRole('button', { name: 'Sign in' })");
  });

  it("resolves a text-input component with placeholder prop", () => {
    const files = createFixtureFiles({
      "components/SearchBox.tsx": `
        export function SearchBox({ placeholder }: { placeholder: string }) {
          return <input type="search" placeholder={placeholder} />;
        }
      `,
      "app/routes/search.tsx": `
        export default function Search() {
          return <SearchBox placeholder="Search patients…" />;
        }
      `,
    });
    const pages = extractReactLocators(files);
    const searchPage = pages.find((p) => p.filePath.includes("search.tsx"));
    expect(searchPage).toBeDefined();
    const loc = searchPage!.locators.find((l) =>
      l.playwrightCode.includes("Search patients")
    );
    expect(loc).toBeDefined();
    expect(loc!.playwrightCode).toBe("page.getByPlaceholder('Search patients…')");
  });

  it("resolves a data-testid prop from a component", () => {
    const files = createFixtureFiles({
      "components/Card.tsx": `
        export function Card({ testId }: { testId: string }) {
          return <div data-testid={testId}>content</div>;
        }
      `,
      "app/routes/dashboard.tsx": `
        export default function Dashboard() {
          return <Card testId="patient-summary" />;
        }
      `,
    });
    const pages = extractReactLocators(files);
    const dashPage = pages.find((p) => p.filePath.includes("dashboard.tsx"));
    expect(dashPage).toBeDefined();
    const loc = dashPage!.locators.find((l) =>
      l.playwrightCode.includes("patient-summary")
    );
    expect(loc).toBeDefined();
    expect(loc!.strategy).toBe("testId");
  });
});

// ─── Regression: Phase 18 HTML-native fixes still work ───────────────────────

describe("extractReactLocators — regression: Phase 18 HTML locator fixes", () => {
  it("label-wraps-input: emits getByLabel for email, skips password", () => {
    const files = createFixtureFiles({
      "app/routes/auth.tsx": `
        export default function Auth() {
          return (
            <form>
              <label>Email<input type="email" /></label>
              <label>Password<input type="password" /></label>
            </form>
          );
        }
      `,
    });
    const pages = extractReactLocators(files);
    const authPage = pages.find((p) => p.filePath.includes("auth.tsx"));
    expect(authPage).toBeDefined();
    const codes = authPage!.locators.map((l) => l.playwrightCode);
    expect(codes).toContain("page.getByLabel('Email')");
    // password must use CSS selector, not label
    expect(codes).not.toContain("page.getByLabel('Password')");
    expect(codes).toContain("page.locator('input[type=\"password\"]')");
  });

  it("FORM_CONTROL_ROLES fallthrough: no unqualified getByRole('textbox') on multi-field form", () => {
    const files = createFixtureFiles({
      "app/routes/register.tsx": `
        export default function Register() {
          return (
            <form>
              <input type="text" placeholder="First name" name="firstName" />
              <input type="text" placeholder="Last name" name="lastName" />
              <input type="email" placeholder="Email address" name="email" />
            </form>
          );
        }
      `,
    });
    const pages = extractReactLocators(files);
    const regPage = pages.find((p) => p.filePath.includes("register.tsx"));
    expect(regPage).toBeDefined();
    const codes = regPage!.locators.map((l) => l.playwrightCode);

    // Unqualified role locators must NOT be emitted
    expect(codes).not.toContain("page.getByRole('textbox')");

    // Should fall through to placeholder
    expect(codes).toContain("page.getByPlaceholder('First name')");
    expect(codes).toContain("page.getByPlaceholder('Last name')");
    expect(codes).toContain("page.getByPlaceholder('Email address')");
  });

  it("SKIP_NAMELESS_ROLES: no locator emitted for structural tags with no text", () => {
    const files = createFixtureFiles({
      "app/routes/layout.tsx": `
        export default function Layout() {
          return (
            <div>
              <nav></nav>
              <main></main>
              <ul><li>Item</li></ul>
              <button>Save</button>
            </div>
          );
        }
      `,
    });
    const pages = extractReactLocators(files);
    const layoutPage = pages.find((p) => p.filePath.includes("layout.tsx"));
    expect(layoutPage).toBeDefined();
    const codes = layoutPage!.locators.map((l) => l.playwrightCode);

    expect(codes).not.toContain("page.getByRole('navigation')");
    expect(codes).not.toContain("page.getByRole('main')");
    // Save button should still be found
    expect(codes).toContain("page.getByRole('button', { name: 'Save' })");
  });

  it("name-attr CSS fallback: emits [name=] selector when no label or placeholder", () => {
    const files = createFixtureFiles({
      "app/routes/settings.tsx": `
        export default function Settings() {
          return (
            <form>
              <select name="status"><option>Active</option></select>
            </form>
          );
        }
      `,
    });
    const pages = extractReactLocators(files);
    const page = pages.find((p) => p.filePath.includes("settings.tsx"));
    expect(page).toBeDefined();
    const loc = page!.locators.find((l) => l.playwrightCode.includes("[name="));
    expect(loc).toBeDefined();
    expect(loc!.playwrightCode).toBe('page.locator(\'[name="status"]\')');
  });
});
