/**
 * component-registry.ts
 *
 * Pre-pass that builds a registry of locator "templates" from React component files
 * (PascalCase .tsx/.jsx files that are NOT route files).
 *
 * A template captures the Playwright locator pattern of an element inside a component,
 * using `{{propName}}` placeholders where the value comes from a prop at the call site.
 *
 * Example:
 *   components/ButtonGroup.tsx:  <button aria-label={label}>…</button>
 *   → LocatorTemplate { playwrightCodeTemplate: "page.getByRole('button', { name: '{{label}}' })", props: ["label"] }
 *
 *   routes/report.tsx:  <ButtonGroup label="Export" />
 *   → resolveComponentLocators("ButtonGroup", attrs, registry, nextId)
 *   → ExtractedLocator { playwrightCode: "page.getByRole('button', { name: 'Export' })", … }
 *
 * This is framework-agnostic and works for any React-style component library.
 */

import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import { walk } from "../../utils/ast-utils";
import type {
  ExtractedLocator,
  ExtractorFlag,
} from "../../blueprint/types";
import * as path from "path";

// ─── Public interfaces ────────────────────────────────────────────────────────

/**
 * A locator pattern extracted from a component file where dynamic prop values
 * are represented as `{{propName}}` placeholders.
 */
export interface LocatorTemplate {
  /** e.g. "page.getByRole('button', { name: '{{label}}' })" */
  playwrightCodeTemplate: string;
  /** e.g. "{{label}}" — the qualifier portion for naming */
  nameTemplate: string;
  strategy: ExtractedLocator["strategy"];
  elementType: ExtractedLocator["elementType"];
  isInteractive: boolean;
  /** prop names referenced by this template: e.g. ["label"] */
  props: string[];
  confidence: number;
  flags: ExtractorFlag[];
}

/** Map from PascalCase component name → its extracted locator templates */
export type ComponentRegistry = Map<string, LocatorTemplate[]>;

// ─── Internal JSX helpers ─────────────────────────────────────────────────────

interface AttrResultFull {
  exists: boolean;
  value: string | null;
  isDynamic: boolean;
  /** Identifier name driving this value: e.g. "label" from {label} or props.label */
  propRef: string | null;
}

function getJSXAttrFull(
  attrs: (TSESTree.JSXAttribute | TSESTree.JSXSpreadAttribute)[],
  attrName: string
): AttrResultFull {
  for (const attr of attrs) {
    if (attr.type !== "JSXAttribute") continue;
    const jsxAttr = attr as TSESTree.JSXAttribute;
    const nameNode = jsxAttr.name;
    if (nameNode.type !== "JSXIdentifier") continue;
    if ((nameNode as TSESTree.JSXIdentifier).name !== attrName) continue;

    const val = jsxAttr.value;
    if (val === null) return { exists: true, value: null, isDynamic: false, propRef: null };

    // String literal: aria-label="Save"
    if (val.type === "Literal") {
      const litVal = (val as TSESTree.Literal).value;
      return {
        exists: true,
        value: typeof litVal === "string" ? litVal : String(litVal),
        isDynamic: false,
        propRef: null,
      };
    }

    if (val.type === "JSXExpressionContainer") {
      const expr = (val as TSESTree.JSXExpressionContainer).expression;

      // {label} — simple identifier → prop reference
      if (expr.type === "Identifier") {
        return {
          exists: true,
          value: null,
          isDynamic: true,
          propRef: (expr as TSESTree.Identifier).name,
        };
      }

      // {props.label} — member expression → prop reference
      if (expr.type === "MemberExpression") {
        const mem = expr as TSESTree.MemberExpression;
        if (mem.property.type === "Identifier") {
          return {
            exists: true,
            value: null,
            isDynamic: true,
            propRef: (mem.property as TSESTree.Identifier).name,
          };
        }
      }

      // Inline string literal: aria-label={"Save"}
      if (expr.type === "Literal") {
        const litVal = (expr as TSESTree.Literal).value;
        return {
          exists: true,
          value: typeof litVal === "string" ? litVal : String(litVal),
          isDynamic: false,
          propRef: null,
        };
      }

      // Template literal with no expressions: aria-label={`Save`}
      if (expr.type === "TemplateLiteral") {
        const tmpl = expr as TSESTree.TemplateLiteral;
        if (tmpl.expressions.length === 0) {
          const cooked = tmpl.quasis[0]?.value.cooked ?? null;
          return { exists: true, value: cooked, isDynamic: false, propRef: null };
        }
      }

      return { exists: true, value: null, isDynamic: true, propRef: null };
    }

    return { exists: false, value: null, isDynamic: false, propRef: null };
  }
  return { exists: false, value: null, isDynamic: false, propRef: null };
}

/** Extract text or a prop reference from JSX children. */
function extractJSXTextOrPropRef(
  children: TSESTree.JSXChild[]
): { text: string | null; propRef: string | null } {
  for (const child of children) {
    if (child.type === "JSXText") {
      const text = (child as TSESTree.JSXText).value.trim().replace(/\s+/g, " ");
      if (text.length >= 2 && /\w/.test(text)) {
        return { text, propRef: null };
      }
    }
    if (child.type === "JSXExpressionContainer") {
      const expr = (child as TSESTree.JSXExpressionContainer).expression;
      if (expr.type === "Identifier") {
        return { text: null, propRef: (expr as TSESTree.Identifier).name };
      }
      if (expr.type === "MemberExpression") {
        const mem = expr as TSESTree.MemberExpression;
        if (mem.property.type === "Identifier") {
          return { text: null, propRef: (mem.property as TSESTree.Identifier).name };
        }
      }
    }
  }
  return { text: null, propRef: null };
}

function getJSXTagNameLocal(nameNode: TSESTree.JSXTagNameExpression): string | null {
  if (nameNode.type === "JSXIdentifier")
    return (nameNode as TSESTree.JSXIdentifier).name;
  if (nameNode.type === "JSXMemberExpression") {
    const prop = (nameNode as TSESTree.JSXMemberExpression).property;
    return (prop as TSESTree.JSXIdentifier).name;
  }
  return null;
}

function tagToRoleLocal(tag: string, inputType: string): string | null {
  switch (tag.toLowerCase()) {
    case "button": return "button";
    case "a": return "link";
    case "select": return "combobox";
    case "textarea": return "textbox";
    case "dialog": return "dialog";
    case "table": return "table";
    case "h1": case "h2": case "h3":
    case "h4": case "h5": case "h6": return "heading";
    case "input": {
      switch (inputType) {
        case "text": case "email": case "tel": case "url": return "textbox";
        case "search": return "searchbox";
        case "checkbox": return "checkbox";
        case "radio": return "radio";
        case "number": return "spinbutton";
        case "range": return "slider";
        case "submit": case "button": case "reset": return "button";
        case "password": return null;
        default: return "textbox";
      }
    }
    default: return null;
  }
}

function tagToElementTypeLocal(tag: string): ExtractedLocator["elementType"] {
  switch (tag.toLowerCase()) {
    case "button": return "button";
    case "input": return "input";
    case "a": return "link";
    case "select": return "select";
    case "textarea": return "textarea";
    case "form": return "form";
    case "h1": case "h2": case "h3":
    case "h4": case "h5": case "h6": return "heading";
    default: return "other";
  }
}

function isInteractiveLocal(tag: string, inputType: string): boolean {
  switch (tag.toLowerCase()) {
    case "button": case "a": case "select": case "textarea": return true;
    case "input": return inputType !== "hidden";
    default: return false;
  }
}

const FORM_CONTROL_ROLES_LOCAL = new Set([
  "textbox", "combobox", "spinbutton", "searchbox", "checkbox", "radio", "slider",
]);

const SKIP_NAMELESS_ROLES_LOCAL = new Set([
  "main", "navigation", "banner", "contentinfo", "complementary",
  "list", "listitem", "form",
]);


function toCamelCaseLocal(s: string): string {
  return s
    .replace(/[-_\s](.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

/**
 * Build a qualifier string from a static value or a prop reference.
 * Returns "{{propName}}" if the value comes from a prop.
 * Returns the static value if it's a known string.
 * Returns null if neither is available.
 */
function makeQualifier(
  staticValue: string | null,
  propRef: string | null
): string | null {
  if (staticValue) return staticValue;
  if (propRef) return `{{${propRef}}}`;
  return null;
}

// ─── Template extraction from a single component file ────────────────────────

const TEST_ID_ATTRS = [
  "data-testid", "data-cy", "data-e2e", "data-pw", "data-automation",
];

/**
 * Extract LocatorTemplate entries from a single component file.
 * Uses the same priority order as react.extractor.ts, but with {{propRef}} placeholders.
 */
function extractTemplatesFromFile(file: ParsedFile): LocatorTemplate[] {
  if (!file.ast) return [];
  const templates: LocatorTemplate[] = [];
  const seenTemplates = new Set<string>();

  walk(file.ast, (node) => {
    if (node.type !== "JSXElement") return;
    const el = node as TSESTree.JSXElement;
    const tag = getJSXTagNameLocal(el.openingElement.name);
    if (!tag || tag !== tag.toLowerCase()) return; // Only HTML tags

    const attrs = el.openingElement.attributes;
    const inputTypeAttr = getJSXAttrFull(attrs, "type");
    const inputType = inputTypeAttr.value ?? "text";
    const elementType = tagToElementTypeLocal(tag);
    const interactive = isInteractiveLocal(tag, inputType);

    // ── Priority 1: test-id attributes ─────────────────────────────────────
    for (const tidAttr of TEST_ID_ATTRS) {
      const testId = getJSXAttrFull(attrs, tidAttr);
      if (!testId.exists) continue;
      const qualifier = makeQualifier(testId.value, testId.propRef);
      if (!qualifier) continue;

      const codeTemplate = testId.isDynamic && testId.propRef
        ? `page.getByTestId('{{${testId.propRef}}}')`
        : `page.getByTestId('${testId.value ?? ""}')`;

      if (seenTemplates.has(codeTemplate)) continue;
      seenTemplates.add(codeTemplate);

      const props = testId.propRef ? [testId.propRef] : [];
      templates.push({
        playwrightCodeTemplate: codeTemplate,
        nameTemplate: qualifier,
        strategy: "testId",
        elementType,
        isInteractive: interactive,
        props,
        confidence: 0.95,
        flags: props.length > 0 ? [] : [],
      });
      return; // found testId — stop for this element
    }

    // ── Priority 2: aria-label ─────────────────────────────────────────────
    const ariaLabel = getJSXAttrFull(attrs, "aria-label");
    if (ariaLabel.exists) {
      const qualifier = makeQualifier(ariaLabel.value, ariaLabel.propRef);
      if (qualifier) {
        const role = tagToRoleLocal(tag, inputType);
        const codeTemplate = role
          ? `page.getByRole('${role}', { name: '${qualifier}' })`
          : `page.getByLabel('${qualifier}')`;

        if (!seenTemplates.has(codeTemplate)) {
          seenTemplates.add(codeTemplate);
          const props = ariaLabel.propRef ? [ariaLabel.propRef] : [];
          templates.push({
            playwrightCodeTemplate: codeTemplate,
            nameTemplate: qualifier,
            strategy: "role",
            elementType,
            isInteractive: interactive,
            props,
            confidence: 0.85,
            flags: [],
          });
        }
        return;
      }
    }

    // ── Priority 3: role with text content ────────────────────────────────
    const role = tagToRoleLocal(tag, inputType);
    if (role) {
      const { text: textContent, propRef: textPropRef } =
        extractJSXTextOrPropRef(el.children);
      const qualifier = makeQualifier(textContent, textPropRef);

      // Skip structural roles with no qualifying name
      if (SKIP_NAMELESS_ROLES_LOCAL.has(role) && !qualifier) return;

      // Form-control roles with no qualifying text: fall through to priority 4 (placeholder/name)
      // Same logic as react.extractor.ts: avoids unqualified role locators on multi-field forms
      if (!(FORM_CONTROL_ROLES_LOCAL.has(role) && !qualifier)) {
        if (!qualifier) return;

        let codeTemplate: string;
        if (role === "heading") {
          const level = tag.match(/^h([1-6])$/i)?.[1] ?? "1";
          codeTemplate = `page.getByRole('heading', { name: '${qualifier}', level: ${level} })`;
        } else {
          codeTemplate = `page.getByRole('${role}', { name: '${qualifier}' })`;
        }

        if (!seenTemplates.has(codeTemplate)) {
          seenTemplates.add(codeTemplate);
          const props = textPropRef ? [textPropRef] : [];
          templates.push({
            playwrightCodeTemplate: codeTemplate,
            nameTemplate: qualifier,
            strategy: "role",
            elementType,
            isInteractive: interactive,
            props,
            confidence: 0.75,
            flags: [],
          });
        }
        return;
      }
      // FORM_CONTROL with no qualifier: fall through to priority 4 (placeholder/name)
    }

    // ── Priority 4: placeholder ────────────────────────────────────────────
    const placeholder = getJSXAttrFull(attrs, "placeholder");
    if (placeholder.exists) {
      const qualifier = makeQualifier(placeholder.value, placeholder.propRef);
      if (qualifier) {
        const codeTemplate = `page.getByPlaceholder('${qualifier}')`;
        if (!seenTemplates.has(codeTemplate)) {
          seenTemplates.add(codeTemplate);
          const props = placeholder.propRef ? [placeholder.propRef] : [];
          templates.push({
            playwrightCodeTemplate: codeTemplate,
            nameTemplate: qualifier,
            strategy: "placeholder",
            elementType,
            isInteractive: interactive,
            props,
            confidence: 0.70,
            flags: [],
          });
        }
        return;
      }
    }

    // ── Priority 4.5: name attribute CSS ──────────────────────────────────
    const nameAttr = getJSXAttrFull(attrs, "name");
    if (nameAttr.exists && ["input", "select", "textarea"].includes(tag)) {
      const qualifier = makeQualifier(nameAttr.value, nameAttr.propRef);
      if (qualifier && !nameAttr.isDynamic) {
        const codeTemplate = `page.locator('[name="${qualifier}"]')`;
        if (!seenTemplates.has(codeTemplate)) {
          seenTemplates.add(codeTemplate);
          const props = nameAttr.propRef ? [nameAttr.propRef] : [];
          templates.push({
            playwrightCodeTemplate: codeTemplate,
            nameTemplate: qualifier,
            strategy: "css",
            elementType,
            isInteractive: interactive,
            props,
            confidence: 0.65,
            flags: [],
          });
        }
        return;
      }
    }
  });

  return templates;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract the PascalCase component name from a file path.
 * Handles:
 *   components/ButtonGroup.tsx         → "ButtonGroup"
 *   components/Modal/index.tsx         → "Modal"
 *   ui/forms/TextInput.jsx             → "TextInput"
 */
export function componentNameFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = path.basename(normalized, path.extname(normalized));

  // index.{ts,tsx,js,jsx} → use parent folder name
  const nameToCheck = basename === "index" || basename === "Index"
    ? path.basename(path.dirname(normalized))
    : basename;

  // Must be PascalCase (starts with uppercase, has mixed case, not all-caps abbreviation like URL)
  if (/^[A-Z][a-zA-Z0-9]+$/.test(nameToCheck)) {
    return nameToCheck;
  }
  return null;
}

/**
 * Pre-pass: build a registry of component→locator-templates from all non-route component files.
 *
 * Skips:
 *   - Files in /routes/ or /pages/ (those are route files, not components)
 *   - Test, spec, story files
 *   - node_modules
 *   - Non-PascalCase named files (utilities, hooks, etc.)
 */
export function buildComponentRegistry(files: ParsedFile[]): ComponentRegistry {
  const registry: ComponentRegistry = new Map();

  for (const file of files) {
    if (!file.ast) continue;
    const fp = file.filePath.replace(/\\/g, "/");

    // Only .tsx / .jsx
    if (!fp.endsWith(".tsx") && !fp.endsWith(".jsx")) continue;

    // Skip route/page files — they are handled by the main extractor
    if (/\/routes\/|\/pages\//.test(fp)) continue;

    // Skip test / story / node_modules
    if (
      fp.includes(".test.") ||
      fp.includes(".spec.") ||
      fp.includes(".stories.") ||
      fp.includes("node_modules")
    ) continue;

    // Only accept PascalCase component files
    const componentName = componentNameFromPath(fp);
    if (!componentName) continue;

    const templates = extractTemplatesFromFile(file);
    if (templates.length === 0) continue;

    // Merge: same component name may appear in multiple paths — accumulate templates
    const existing = registry.get(componentName) ?? [];
    const seenInRegistry = new Set(existing.map((t) => t.playwrightCodeTemplate));
    const merged = [...existing];
    for (const t of templates) {
      if (!seenInRegistry.has(t.playwrightCodeTemplate)) {
        merged.push(t);
        seenInRegistry.add(t.playwrightCodeTemplate);
      }
    }
    registry.set(componentName, merged);
  }

  return registry;
}

/**
 * Substitute `{{propName}}` placeholders with actual call-site prop values.
 * - If the call-site provides a static string → substitute inline.
 * - If the call-site provides a dynamic/unknown value → emit `[propName]` and set hasUnresolved.
 * - If the call-site doesn't pass the prop at all → emit `[propName]` and set hasUnresolved.
 */
export function resolvePropTemplate(
  template: string,
  callSiteProps: Map<string, string | null>
): { resolved: string; hasUnresolved: boolean } {
  let hasUnresolved = false;
  const resolved = template.replace(/\{\{([^}]+)\}\}/g, (_, propName: string) => {
    const val = callSiteProps.get(propName);
    if (val !== undefined && val !== null) {
      // Static value provided at call site
      return val;
    }
    // Dynamic or missing
    hasUnresolved = true;
    return `[${propName}]`;
  });
  return { resolved, hasUnresolved };
}

/**
 * Given a PascalCase component usage at a call site (e.g. `<ButtonGroup label="Export" />`),
 * look up the registry, substitute props, and return concrete ExtractedLocator entries.
 *
 * @param componentName  "ButtonGroup"
 * @param callSiteAttrs  JSX attributes from the call site (the <ButtonGroup …> element)
 * @param registry       Built from buildComponentRegistry()
 * @param nextId         ID generator function (e.g. () => `loc_${++n}`)
 */
export function resolveComponentLocators(
  componentName: string,
  callSiteAttrs: (TSESTree.JSXAttribute | TSESTree.JSXSpreadAttribute)[],
  registry: ComponentRegistry,
  nextId: () => string
): ExtractedLocator[] {
  const templates = registry.get(componentName);
  if (!templates || templates.length === 0) return [];

  // Build call-site prop map: propName → static value (or null if dynamic)
  const callSiteProps = new Map<string, string | null>();
  for (const attr of callSiteAttrs) {
    if (attr.type !== "JSXAttribute") continue;
    const jsxAttr = attr as TSESTree.JSXAttribute;
    if (jsxAttr.name.type !== "JSXIdentifier") continue;
    const propName = (jsxAttr.name as TSESTree.JSXIdentifier).name;

    const val = jsxAttr.value;
    if (val === null) {
      callSiteProps.set(propName, "true"); // boolean prop
    } else if (val.type === "Literal") {
      const litVal = (val as TSESTree.Literal).value;
      callSiteProps.set(propName, typeof litVal === "string" ? litVal : String(litVal));
    } else if (val.type === "JSXExpressionContainer") {
      const expr = (val as TSESTree.JSXExpressionContainer).expression;
      if (expr.type === "Literal") {
        const litVal = (expr as TSESTree.Literal).value;
        callSiteProps.set(propName, typeof litVal === "string" ? litVal : String(litVal));
      } else if (expr.type === "TemplateLiteral") {
        const tmpl = expr as TSESTree.TemplateLiteral;
        if (tmpl.expressions.length === 0) {
          callSiteProps.set(propName, tmpl.quasis[0]?.value.cooked ?? null);
        } else {
          callSiteProps.set(propName, null); // dynamic
        }
      } else {
        callSiteProps.set(propName, null); // dynamic
      }
    }
  }

  const locators: ExtractedLocator[] = [];

  for (const template of templates) {
    const { resolved, hasUnresolved } = resolvePropTemplate(
      template.playwrightCodeTemplate,
      callSiteProps
    );

    // Build flags
    const flags: ExtractorFlag[] = [...template.flags];
    if (hasUnresolved) flags.push("DYNAMIC_PROP");

    // Build a human-readable name from the nameTemplate
    const { resolved: resolvedName } = resolvePropTemplate(template.nameTemplate, callSiteProps);
    const name = toCamelCaseLocal(
      resolvedName.replace(/[\[\]{}]/g, "").slice(0, 30)
    );

    // If a heading name ends with " (" the source JSX has a dynamic count like
    // <h1>Appointments ({count})</h1> — the static prefix "Appointments (" was
    // extracted but the closing ")" is dynamic. Playwright exact-string matching
    // would never match "Appointments (42)", so rewrite to a regex instead.
    // Pattern: getByRole('heading'...) with name: 'SomeText (' (trailing open-paren)
    const truncatedHeadingRe = /getByRole\('heading'[^}]*name:\s*'([^'(]*)\s*\('/;
    const safePlaywrightCode = truncatedHeadingRe.test(resolved)
      ? resolved.replace(
          /name:\s*'([^'(]*)\s*\('\s*([,}])/,
          (_m, prefix, tail) => {
            const escaped = prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return `name: /^${escaped}/i${tail}`;
          }
        )
      : resolved;

    locators.push({
      id: nextId(),
      name: name || toCamelCaseLocal(componentName),
      playwrightCode: safePlaywrightCode,
      strategy: template.strategy,
      elementType: template.elementType,
      isInteractive: template.isInteractive,
      isConditional: false,
      isDynamic: hasUnresolved,
      confidence: hasUnresolved ? template.confidence * 0.6 : template.confidence,
      flags,
    });
  }

  return locators;
}
