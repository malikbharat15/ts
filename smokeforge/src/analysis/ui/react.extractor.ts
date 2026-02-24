import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import { walk } from "../../utils/ast-utils";
import { buildComponentRegistry, resolveComponentLocators } from "./component-registry";
import type {
  ExtractedLocator,
  ExtractedPage,
  ExtractorFlag,
  FormFlow,
  FormStep,
  NavigationLink,
} from "../../blueprint/types";

// ─── ID counters ──────────────────────────────────────────────────────────────

let _pageCount = 0;
const nextPageId = (): string =>
  `react_page_${String(++_pageCount).padStart(3, "0")}`;

let _locCount = 0;
const nextLocId = (): string =>
  `loc_${String(++_locCount).padStart(4, "0")}`;

let _flowCount = 0;
const nextFlowId = (): string =>
  `flow_${String(++_flowCount).padStart(3, "0")}`;

// ─── JSX helpers ──────────────────────────────────────────────────────────────

interface AttrResult {
  exists: boolean;
  value: string | null;
  isDynamic: boolean;
}

function getJSXAttr(
  attrs: (TSESTree.JSXAttribute | TSESTree.JSXSpreadAttribute)[],
  attrName: string
): AttrResult {
  for (const attr of attrs) {
    if (attr.type !== "JSXAttribute") continue;
    const jsxAttr = attr as TSESTree.JSXAttribute;
    const nameNode = jsxAttr.name;
    if (nameNode.type !== "JSXIdentifier") continue;
    if ((nameNode as TSESTree.JSXIdentifier).name !== attrName) continue;

    const val = jsxAttr.value;
    if (val === null) return { exists: true, value: null, isDynamic: false };

    if (val.type === "Literal") {
      const litVal = (val as TSESTree.Literal).value;
      return {
        exists: true,
        value: typeof litVal === "string" ? litVal : String(litVal),
        isDynamic: false,
      };
    }
    if (val.type === "JSXExpressionContainer") {
      const expr = (val as TSESTree.JSXExpressionContainer).expression;
      if (expr.type === "Literal") {
        const litVal = (expr as TSESTree.Literal).value;
        return {
          exists: true,
          value: typeof litVal === "string" ? litVal : String(litVal),
          isDynamic: false,
        };
      }
      if (expr.type === "TemplateLiteral") {
        const tmpl = expr as TSESTree.TemplateLiteral;
        if (tmpl.expressions.length === 0) {
          const cooked = tmpl.quasis[0]?.value.cooked ?? null;
          return { exists: true, value: cooked, isDynamic: false };
        }
        return { exists: true, value: null, isDynamic: true };
      }
      return { exists: true, value: null, isDynamic: true };
    }
    return { exists: true, value: null, isDynamic: false };
  }
  return { exists: false, value: null, isDynamic: false };
}

function getJSXTagName(nameNode: TSESTree.JSXTagNameExpression): string | null {
  if (nameNode.type === "JSXIdentifier")
    return (nameNode as TSESTree.JSXIdentifier).name;
  if (nameNode.type === "JSXMemberExpression") {
    const prop = (nameNode as TSESTree.JSXMemberExpression).property;
    return (prop as TSESTree.JSXIdentifier).name;
  }
  return null;
}

/** Extract raw text from JSX children (string literals only). */
function extractJSXText(children: TSESTree.JSXChild[]): string | null {
  for (const child of children) {
    if (child.type === "JSXText") {
      const text = (child as TSESTree.JSXText).value.trim().replace(/\s+/g, " ");
      if (text) return text;
    }
  }
  return null;
}

/**
 * Like extractJSXText but recurses into wrapper JSXElements (e.g. Typography,
 * span, strong) one level deep.  Handles patterns like:
 *   <Button><Typography variant="inherit">Authorize</Typography></Button>
 * Concatenates text fragments, strips icon-only segments (no alphabetic chars).
 */
function extractJSXTextDeep(children: TSESTree.JSXChild[], maxDepth = 2): string | null {
  const parts: string[] = [];
  for (const child of children) {
    if (child.type === "JSXText") {
      const text = (child as TSESTree.JSXText).value.trim().replace(/\s+/g, " ");
      if (text) parts.push(text);
    } else if (child.type === "JSXElement" && maxDepth > 0) {
      const nested = extractJSXTextDeep((child as TSESTree.JSXElement).children, maxDepth - 1);
      if (nested) parts.push(nested);
    }
  }
  const combined = parts.join(" ").trim().replace(/\s+/g, " ");
  // Only return if the result contains at least one alphabetic character
  return combined && /[a-zA-Z]/.test(combined) ? combined : null;
}

/** Check if an attribute name matches any of the test-id conventions. */
function findTestIdAttr(
  attrs: (TSESTree.JSXAttribute | TSESTree.JSXSpreadAttribute)[]
): AttrResult & { attrName: string } {
  const TEST_ID_ATTRS = [
    "data-testid",
    "data-cy",
    "data-e2e",
    "data-pw",
    "data-automation",
  ];
  for (const name of TEST_ID_ATTRS) {
    const result = getJSXAttr(attrs, name);
    if (result.exists) return { ...result, attrName: name };
  }
  return { exists: false, value: null, isDynamic: false, attrName: "" };
}

// ─── Element type/role helpers ────────────────────────────────────────────────

function tagToElementType(
  tag: string
): ExtractedLocator["elementType"] {
  switch (tag.toLowerCase()) {
    case "button": return "button";
    case "input": return "input";
    case "a": return "link";
    case "select": return "select";
    case "textarea": return "textarea";
    case "form": return "form";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": return "heading";
    default: return "other";
  }
}

function tagToRole(tag: string, inputType: string): string | null {
  switch (tag.toLowerCase()) {
    case "button": return "button";
    case "a": return "link";
    case "select": return "combobox";
    case "textarea": return "textbox";
    case "nav": return "navigation";
    case "main": return "main";
    case "header": return "banner";
    case "footer": return "contentinfo";
    case "aside": return "complementary";
    case "dialog": return "dialog";
    case "table": return "table";
    case "ul":
    case "ol": return "list";
    case "li": return "listitem";
    case "form": return "form";
    case "h1": return "heading";
    case "h2": return "heading";
    case "h3": return "heading";
    case "h4": return "heading";
    case "h5": return "heading";
    case "h6": return "heading";
    case "input": {
      switch (inputType) {
        case "text":
        case "email":
        case "tel":
        case "url": return "textbox";
        case "search": return "searchbox";
        case "checkbox": return "checkbox";
        case "radio": return "radio";
        case "number": return "spinbutton";
        case "range": return "slider";
        case "submit":
        case "button":
        case "reset": return "button";
        case "password": return null; // must use CSS
        default: return "textbox";
      }
    }
    default: return null;
  }
}

function isInteractiveElement(tag: string, inputType: string): boolean {
  switch (tag.toLowerCase()) {
    case "button":
    case "a":
    case "select":
    case "textarea": return true;
    case "input": return inputType !== "hidden";
    default: return false;
  }
}

function headingLevel(tag: string): number {
  const m = tag.match(/^h([1-6])$/i);
  return m ? parseInt(m[1], 10) : 1;
}

// ─── Conditional / dynamic detection ─────────────────────────────────────────

/**
 * Try to detect if a JSXElement is inside a conditional or map expression.
 * We look at the parent node passed through.
 */
function detectRendering(
  parent: TSESTree.Node | null
): { isConditional: boolean; isDynamic: boolean } {
  if (!parent) return { isConditional: false, isDynamic: false };

  // {condition && <El />} → LogicalExpression inside JSXExpressionContainer
  if (parent.type === "LogicalExpression") {
    return { isConditional: true, isDynamic: false };
  }
  // {condition ? <El /> : null} → ConditionalExpression
  if (parent.type === "ConditionalExpression") {
    return { isConditional: true, isDynamic: false };
  }
  // items.map(...) → the JSXElement is returned from arrow fn inside CallExpression
  if (parent.type === "ArrowFunctionExpression" || parent.type === "ReturnStatement") {
    // might be inside a map - flag it
    return { isConditional: false, isDynamic: true };
  }
  return { isConditional: false, isDynamic: false };
}

// ─── camelCase name from test-id ──────────────────────────────────────────────

function toCamelCase(s: string): string {
  return s
    .replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

// ─── Core locator extraction from a single JSXElement ────────────────────────

/**
 * Structural/container roles that produce useless/ambiguous locators when there is no
 * qualifying name. e.g. page.getByRole('main') always matches and asserts nothing useful.
 */
const SKIP_NAMELESS_ROLES = new Set([
  "main", "navigation", "banner", "contentinfo", "complementary",
  "list", "listitem", "form",
]);

/**
 * Form-control roles where an unqualified locator (no { name: }) is dangerous:
 * if >1 of the same role exists on a page, Playwright strict-mode will throw.
 * When one of these has no qualifying text/label, we fall through to
 * placeholder → name-attr CSS, which are always unique per field.
 * This is framework-agnostic: it applies to any HTML form regardless of React/Remix/Next/Vue.
 */
const FORM_CONTROL_ROLES = new Set([
  "textbox", "combobox", "spinbutton", "searchbox", "checkbox", "radio", "slider",
]);

/** Validate extracted JSX text — must be ≥2 chars, contain a word char, not all-punctuation. */
function isValidLabelText(t: string | null): t is string {
  return t !== null && t.trim().length >= 2 && /\w/.test(t) && !/^[\W_]+$/.test(t.trim());
}

// ─── MUI / PascalCase component special handling ────────────────────────────
//
// MUI components render as semantic HTML at runtime but have PascalCase names
// that the extractLocatorFromJSXElement function skips. This function maps the
// most common MUI (and Remix-compatible) component patterns to Playwright locators.
//   <Typography variant="h1">Title</Typography>  → getByRole('heading', {name:'Title', level:1})
//   <Tabs aria-label="nav">                      → getByRole('tablist', {name:'nav'})
//   <Tab label="Binaries">                       → getByRole('tab', {name:'Binaries'})
//   <Button>Save</Button>                        → getByRole('button', {name:'Save'})
//   <TextField label="Email">                    → getByLabel('Email')
function extractMUIComponentLocator(
  tag: string,
  el: TSESTree.JSXElement,
  _parentNode: TSESTree.Node | null
): ExtractedLocator | null {
  const attrs = el.openingElement.attributes;

  // ── Typography → heading (when variant or component prop is h1-h6) ────────
  if (tag === "Typography") {
    const variantAttr = getJSXAttr(attrs, "variant");
    const componentAttr = getJSXAttr(attrs, "component");
    const effectiveTag = componentAttr.value ?? variantAttr.value ?? "";
    if (/^h[1-6]$/i.test(effectiveTag)) {
      const level = headingLevel(effectiveTag);
      const textContent = extractJSXText(el.children);
      if (isValidLabelText(textContent)) {
        const safe = textContent!.replace(/'/g, "\\'");
        return {
          id: nextLocId(),
          name: toCamelCase(textContent!.slice(0, 30)),
          playwrightCode: `page.getByRole('heading', { name: '${safe}', level: ${level} })`,
          strategy: "role",
          elementType: "heading",
          isInteractive: false,
          isConditional: false,
          isDynamic: false,
          confidence: 0.80,
          flags: [],
        };
      }
    }
    return null;
  }

  // ── Tabs → tablist  ────────────────────────────────────────────────────────
  if (tag === "Tabs") {
    const ariaLabel = getJSXAttr(attrs, "aria-label");
    if (ariaLabel.exists && ariaLabel.value) {
      return {
        id: nextLocId(),
        name: toCamelCase(ariaLabel.value),
        playwrightCode: `page.getByRole('tablist', { name: '${ariaLabel.value.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "other",
        isInteractive: false,
        isConditional: false,
        isDynamic: false,
        confidence: 0.85,
        flags: [],
      };
    }
    return null;
  }

  // ── Tab → tab  ─────────────────────────────────────────────────────────────
  if (tag === "Tab") {
    const labelAttr = getJSXAttr(attrs, "label");
    if (labelAttr.exists && labelAttr.value) {
      return {
        id: nextLocId(),
        name: toCamelCase(labelAttr.value),
        playwrightCode: `page.getByRole('tab', { name: '${labelAttr.value.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "other",
        isInteractive: true,
        isConditional: false,
        isDynamic: false,
        confidence: 0.85,
        flags: [],
      };
    }
    // Tab with child text
    const textContent = extractJSXText(el.children);
    if (isValidLabelText(textContent)) {
      return {
        id: nextLocId(),
        name: toCamelCase(textContent!.slice(0, 30)),
        playwrightCode: `page.getByRole('tab', { name: '${textContent!.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "other",
        isInteractive: true,
        isConditional: false,
        isDynamic: false,
        confidence: 0.80,
        flags: [],
      };
    }
    return null;
  }

  // ── Button / IconButton / LoadingButton (MUI) → button  ────────────────────
  if (tag === "Button" || tag === "IconButton" || tag === "LoadingButton") {
    const ariaLabel = getJSXAttr(attrs, "aria-label");
    if (ariaLabel.exists && ariaLabel.value) {
      return {
        id: nextLocId(),
        name: toCamelCase(ariaLabel.value),
        playwrightCode: `page.getByRole('button', { name: '${ariaLabel.value.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "button",
        isInteractive: true,
        isConditional: false,
        isDynamic: false,
        confidence: 0.85,
        flags: [],
      };
    }
    // Use deep extraction so text inside wrapper elements like <Typography> is found:
    //   <Button><Typography variant="inherit">Authorize</Typography></Button>
    const textContent = extractJSXTextDeep(el.children);
    if (isValidLabelText(textContent)) {
      return {
        id: nextLocId(),
        name: toCamelCase(textContent!.slice(0, 30)),
        playwrightCode: `page.getByRole('button', { name: '${textContent!.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "button",
        isInteractive: true,
        isConditional: false,
        isDynamic: false,
        confidence: 0.80,
        flags: [],
      };
    }
    return null;
  }

  // ── TextField / Autocomplete (MUI) → getByLabel  ───────────────────────────
  if (tag === "TextField" || tag === "Autocomplete") {
    const labelAttr = getJSXAttr(attrs, "label");
    if (labelAttr.exists && labelAttr.value) {
      return {
        id: nextLocId(),
        name: toCamelCase(labelAttr.value),
        playwrightCode: `page.getByLabel('${labelAttr.value.replace(/'/g, "\\'")}'  )`,
        strategy: "label",
        elementType: "input",
        isInteractive: true,
        isConditional: false,
        isDynamic: false,
        confidence: 0.85,
        flags: [],
      };
    }
    const ariaLabel = getJSXAttr(attrs, "aria-label");
    if (ariaLabel.exists && ariaLabel.value) {
      return {
        id: nextLocId(),
        name: toCamelCase(ariaLabel.value),
        playwrightCode: `page.getByLabel('${ariaLabel.value.replace(/'/g, "\\'")}'  )`,
        strategy: "label",
        elementType: "input",
        isInteractive: true,
        isConditional: false,
        isDynamic: false,
        confidence: 0.85,
        flags: [],
      };
    }
    return null;
  }

  // ── Select (MUI controlled)  ───────────────────────────────────────────────
  if (tag === "Select") {
    const labelAttr = getJSXAttr(attrs, "label");
    if (labelAttr.exists && labelAttr.value) {
      return {
        id: nextLocId(),
        name: toCamelCase(labelAttr.value),
        playwrightCode: `page.getByLabel('${labelAttr.value.replace(/'/g, "\\'")}'  )`,
        strategy: "label",
        elementType: "select",
        isInteractive: true,
        isConditional: false,
        isDynamic: false,
        confidence: 0.80,
        flags: [],
      };
    }
    return null;
  }

  // ── MenuItem → menuitem role  ──────────────────────────────────────────────
  // <MenuItem>Export CSV</MenuItem>  →  getByRole('menuitem', { name: 'Export CSV' })
  // Also handles <MenuItem value={x}>Label</MenuItem>
  if (tag === "MenuItem") {
    const textContent = extractJSXTextDeep(el.children);
    if (isValidLabelText(textContent)) {
      return {
        id: nextLocId(),
        name: toCamelCase(textContent!.slice(0, 30)),
        playwrightCode: `page.getByRole('menuitem', { name: '${textContent!.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "other",
        isInteractive: true,
        isConditional: false,
        isDynamic: false,
        confidence: 0.78,
        flags: [],
      };
    }
    return null;
  }

  // ── Link (MUI) → link role  ────────────────────────────────────────────────
  // <Link href="/dashboard">Dashboard</Link>  →  getByRole('link', { name: 'Dashboard' })
  // MUI Link renders as <a>; grab text or aria-label
  if (tag === "Link") {
    const ariaLabel = getJSXAttr(attrs, "aria-label");
    if (ariaLabel.exists && ariaLabel.value) {
      return {
        id: nextLocId(),
        name: toCamelCase(ariaLabel.value),
        playwrightCode: `page.getByRole('link', { name: '${ariaLabel.value.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "link",
        isInteractive: true,
        isConditional: false,
        isDynamic: false,
        confidence: 0.85,
        flags: [],
      };
    }
    const textContent = extractJSXTextDeep(el.children);
    if (isValidLabelText(textContent)) {
      return {
        id: nextLocId(),
        name: toCamelCase(textContent!.slice(0, 30)),
        playwrightCode: `page.getByRole('link', { name: '${textContent!.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "link",
        isInteractive: true,
        isConditional: false,
        isDynamic: false,
        confidence: 0.80,
        flags: [],
      };
    }
    return null;
  }

  // ── ListItemText → getByText (best-effort; no stable role)  ───────────────
  // <ListItemText primary="Dashboard" />  →  page.getByText('Dashboard')
  // Used heavily in MUI sidebar/drawer navigation. No reliable role since
  // ListItem renders as <li> which has many siblings. Flag as BRITTLE.
  if (tag === "ListItemText") {
    const primaryAttr = getJSXAttr(attrs, "primary");
    if (primaryAttr.exists && primaryAttr.value && !primaryAttr.isDynamic) {
      return {
        id: nextLocId(),
        name: toCamelCase(primaryAttr.value.slice(0, 30)),
        playwrightCode: `page.getByText('${primaryAttr.value.replace(/'/g, "\\'")}'  )`,
        strategy: "text",
        elementType: "other",
        isInteractive: false,
        isConditional: false,
        isDynamic: false,
        confidence: 0.55,
        flags: ["BRITTLE"],
      };
    }
    return null;
  }

  // ── Chip → button (when clickable/deletable) or text  ─────────────────────
  // <Chip label="Admin" onClick={...} />  →  getByRole('button', { name: 'Admin' })
  // <Chip label="Tag" />                  →  getByText('Tag')  (BRITTLE)
  if (tag === "Chip") {
    const labelAttr = getJSXAttr(attrs, "label");
    if (labelAttr.exists && labelAttr.value && !labelAttr.isDynamic) {
      const hasOnClick = attrs.some(
        a => a.type === "JSXAttribute" && (a as TSESTree.JSXAttribute).name.type === "JSXIdentifier" &&
        ((a as TSESTree.JSXAttribute).name as TSESTree.JSXIdentifier).name === "onClick"
      );
      const hasOnDelete = attrs.some(
        a => a.type === "JSXAttribute" && (a as TSESTree.JSXAttribute).name.type === "JSXIdentifier" &&
        ((a as TSESTree.JSXAttribute).name as TSESTree.JSXIdentifier).name === "onDelete"
      );
      const safe = labelAttr.value.replace(/'/g, "\\'");
      if (hasOnClick || hasOnDelete) {
        return {
          id: nextLocId(),
          name: toCamelCase(labelAttr.value.slice(0, 30)),
          playwrightCode: `page.getByRole('button', { name: '${safe}'  })`,
          strategy: "role",
          elementType: "button",
          isInteractive: true,
          isConditional: false,
          isDynamic: false,
          confidence: 0.78,
          flags: [],
        };
      }
      return {
        id: nextLocId(),
        name: toCamelCase(labelAttr.value.slice(0, 30)),
        playwrightCode: `page.getByText('${safe}'  )`,
        strategy: "text",
        elementType: "other",
        isInteractive: false,
        isConditional: false,
        isDynamic: false,
        confidence: 0.55,
        flags: ["BRITTLE"],
      };
    }
    return null;
  }

  // ── Alert → alert role  ────────────────────────────────────────────────────
  // <Alert severity="error">Email is required</Alert>  →  getByRole('alert')
  // Qualifies with text content when possible; falls back to bare role.
  if (tag === "Alert") {
    const textContent = extractJSXTextDeep(el.children);
    if (isValidLabelText(textContent)) {
      return {
        id: nextLocId(),
        name: toCamelCase(textContent!.slice(0, 30)),
        playwrightCode: `page.getByRole('alert').filter({ hasText: '${textContent!.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "other",
        isInteractive: false,
        isConditional: false,
        isDynamic: false,
        confidence: 0.75,
        flags: [],
      };
    }
    // Bare role — still useful for smoke: verify an alert is present
    return {
      id: nextLocId(),
      name: "alertMessage",
      playwrightCode: `page.getByRole('alert')`,
      strategy: "role",
      elementType: "other",
      isInteractive: false,
      isConditional: false,
      isDynamic: false,
      confidence: 0.60,
      flags: [],
    };
  }

  // ── Dialog / Modal → dialog role  ─────────────────────────────────────────
  // Finds `aria-labelledby` then looks for the heading text inside children.
  // <Dialog aria-labelledby="confirm-title"><h2 id="confirm-title">Confirm</h2>…</Dialog>
  // Falls back to bare getByRole('dialog') when no label can be resolved.
  if (tag === "Dialog" || tag === "Modal") {
    const ariaLabel = getJSXAttr(attrs, "aria-label");
    if (ariaLabel.exists && ariaLabel.value) {
      return {
        id: nextLocId(),
        name: toCamelCase(ariaLabel.value),
        playwrightCode: `page.getByRole('dialog', { name: '${ariaLabel.value.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "other",
        isInteractive: false,
        isConditional: false,
        isDynamic: false,
        confidence: 0.82,
        flags: [],
      };
    }
    // Try to read heading text directly from children (h1-h6 or Typography h*)
    const heading = extractJSXTextDeep(el.children);
    if (isValidLabelText(heading)) {
      return {
        id: nextLocId(),
        name: toCamelCase(heading!.slice(0, 30)),
        playwrightCode: `page.getByRole('dialog', { name: '${heading!.replace(/'/g, "\\'")}'  })`,
        strategy: "role",
        elementType: "other",
        isInteractive: false,
        isConditional: false,
        isDynamic: false,
        confidence: 0.65,
        flags: [],
      };
    }
    return null;  // no name discoverable — would create false positives
  }

  return null;
}

function extractLocatorFromJSXElement(
  el: TSESTree.JSXElement,
  parentNode: TSESTree.Node | null,
  inheritedLabelText: string | null = null,
  htmlForMap: Map<string, string> = new Map()
): ExtractedLocator | null {
  const opening = el.openingElement;
  const tag = getJSXTagName(opening.name);
  if (!tag) return null;

  // Skip non-HTML elements — but first try to extract locators from known
  // MUI/PascalCase components (Typography, Tabs, Tab, Button, TextField, etc.)
  const isHTMLTag = tag === tag.toLowerCase();
  if (!isHTMLTag) return extractMUIComponentLocator(tag, el, parentNode);

  const attrs = opening.attributes;
  const inputTypeAttr = getJSXAttr(attrs, "type");
  const inputType = inputTypeAttr.value ?? "text";

  const { isConditional, isDynamic } = detectRendering(parentNode);
  const flags: ExtractorFlag[] = [];

  const elementType = tagToElementType(tag);
  const interactive = isInteractiveElement(tag, inputType);

  // ── Priority 1: Test-ID attributes ─────────────────────────────────────────
  const testIdAttr = findTestIdAttr(attrs);
  if (testIdAttr.exists) {
    if (testIdAttr.isDynamic) flags.push("DYNAMIC_TESTID");
    if (isConditional) flags.push("CONDITIONAL_ELEMENT");
    if (isDynamic) flags.push("DYNAMIC_LIST");

    const testIdVal = testIdAttr.value;
    const playwrightCode = testIdAttr.isDynamic
      ? `page.getByTestId(/^${tag}-/)`
      : `page.getByTestId('${testIdVal ?? ""}')`;

    return {
      id: nextLocId(),
      name: testIdVal ? toCamelCase(testIdVal) : `${tag}Element`,
      playwrightCode,
      strategy: "testId",
      elementType,
      isInteractive: interactive,
      isConditional: isConditional || testIdAttr.isDynamic,
      isDynamic: isDynamic || testIdAttr.isDynamic,
      confidence: 0.95,
      flags,
    };
  }

  // ── Priority 2: aria-label ─────────────────────────────────────────────────
  const ariaLabel = getJSXAttr(attrs, "aria-label");
  if (ariaLabel.exists && ariaLabel.value) {
    if (isConditional) flags.push("CONDITIONAL_ELEMENT");
    if (isDynamic) flags.push("DYNAMIC_LIST");

    const role = tagToRole(tag, inputType);
    const playwrightCode = role
      ? `page.getByRole('${role}', { name: '${ariaLabel.value}' })`
      : `page.getByLabel('${ariaLabel.value}')`;

    return {
      id: nextLocId(),
      name: toCamelCase(ariaLabel.value),
      playwrightCode,
      strategy: "role",
      elementType,
      isInteractive: interactive,
      isConditional,
      isDynamic,
      confidence: 0.85,
      flags,
    };
  }

  // ── Priority 2.5: label-wraps-input (parent <label> text) ─────────────────
  // Handles: <label>Email<input type="email" /></label>
  // This is the most common React form pattern and produces page.getByLabel()
  // which Playwright resolves via the DOM label association.
  if (inheritedLabelText && isValidLabelText(inheritedLabelText) &&
      ["input", "select", "textarea"].includes(tag) && inputType !== "password") {
    if (isConditional) flags.push("CONDITIONAL_ELEMENT");
    if (isDynamic) flags.push("DYNAMIC_LIST");
    const clean = inheritedLabelText.trim().replace(/\s+/g, " ");
    return {
      id: nextLocId(),
      name: toCamelCase(clean.slice(0, 30)),
      playwrightCode: `page.getByLabel('${clean.replace(/'/g, "\\'")}')`  ,
      strategy: "label",
      elementType,
      isInteractive: interactive,
      isConditional,
      isDynamic,
      confidence: 0.90,
      flags,
    };
  }

  // ── Priority 2.6: htmlFor-linked label (e.g. <label htmlFor="email">Email + <input id="email">)
  // Playwright's getByLabel() resolves both wrapping and htmlFor-linked labels.
  if (htmlForMap.size > 0 && ["input", "select", "textarea"].includes(tag) && inputType !== "password") {
    const idAttrForLabel = getJSXAttr(attrs, "id");
    if (idAttrForLabel.exists && idAttrForLabel.value && !idAttrForLabel.isDynamic) {
      const linkedLabelText = htmlForMap.get(idAttrForLabel.value);
      if (linkedLabelText && isValidLabelText(linkedLabelText)) {
        if (isConditional) flags.push("CONDITIONAL_ELEMENT");
        if (isDynamic) flags.push("DYNAMIC_LIST");
        const clean = linkedLabelText.trim().replace(/\s+/g, " ");
        return {
          id: nextLocId(),
          name: toCamelCase(clean.slice(0, 30)),
          playwrightCode: `page.getByLabel('${clean.replace(/'/g, "\\'")}')`,
          strategy: "label",
          elementType,
          isInteractive: interactive,
          isConditional,
          isDynamic,
          confidence: 0.92,
          flags,
        };
      }
    }
  }

  // ── Priority 2.75: password input — always use CSS (tagToRole returns null for password) ──
  if (tag === "input" && inputType === "password") {
    if (isConditional) flags.push("CONDITIONAL_ELEMENT");
    if (isDynamic) flags.push("DYNAMIC_LIST");
    return {
      id: nextLocId(),
      name: "passwordInput",
      playwrightCode: `page.locator('input[type="password"]')`,
      strategy: "css",
      elementType: "input",
      isInteractive: true,
      isConditional,
      isDynamic,
      confidence: 0.75,
      flags,
    };
  }

  // ── Priority 3: HTML semantic roles ───────────────────────────────────────
  const role = tagToRole(tag, inputType);
  if (role) {
    // Get text content first — used for both skip-guard and locator name
    const textContent = extractJSXText(el.children);
    const validText = isValidLabelText(textContent) ? textContent : null;

    // Skip structural/container roles with no qualifying name (always ambiguous).
    if (SKIP_NAMELESS_ROLES.has(role) && !validText) return null;

    // For form-control roles (textbox, combobox, spinbutton, etc.) with no qualifying text:
    // fall through to placeholder → name-attr CSS, which are always field-unique.
    // Emitting an unqualified page.getByRole('textbox') on any multi-field form
    // causes Playwright strict-mode violations at runtime.
    // This is intentionally framework-agnostic: the same fallback applies to React,
    // Remix, Next.js, Vue, or any framework that renders standard HTML form controls.
    if (!(FORM_CONTROL_ROLES.has(role) && !validText)) {
      if (isConditional) flags.push("CONDITIONAL_ELEMENT");
      if (isDynamic) flags.push("DYNAMIC_LIST");

      // Special case: img → use getByAltText
      if (tag === "img") {
        const alt = getJSXAttr(attrs, "alt");
        if (alt.value) {
          return {
            id: nextLocId(),
            name: toCamelCase(alt.value),
            playwrightCode: `page.getByAltText('${alt.value}')`,
            strategy: "altText",
            elementType: "other",
            isInteractive: false,
            isConditional,
            isDynamic,
            confidence: 0.80,
            flags,
          };
        }
      }

      // validText already extracted + validated above (for the skip-guard)
      const nameOpts =
        validText
          ? `, { name: '${validText.replace(/'/g, "\\'")}' }`
          : "";
      const levelOpts =
        tag.match(/^h[1-6]$/i)
          ? `, { level: ${headingLevel(tag)} }`
          : "";

      let playwrightCode: string;
      if (role === "heading") {
        if (validText) {
          // If the extracted text ends with " (" the JSX has a dynamic count: <h1>Items ({count})</h1>.
          // Playwright exact-string matching won't match "Items (42)", so use a regex instead.
          const isTruncated = /\(\s*$/.test(validText);
          if (isTruncated) {
            const prefix = validText.replace(/\s*\(\s*$/, "").trim();
            const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            playwrightCode = `page.getByRole('heading', { name: /^${escaped}/i, level: ${headingLevel(tag)} })`;
          } else {
            playwrightCode = `page.getByRole('heading', { name: '${validText.replace(/'/g, "\\'")}', level: ${headingLevel(tag)} })`;
          }
        } else {
          playwrightCode = `page.getByRole('heading'${levelOpts})`;
        }
      } else {
        playwrightCode = `page.getByRole('${role}'${nameOpts})`;
      }

      const name = validText
        ? toCamelCase(validText.slice(0, 30))
        : `${tag}${role.charAt(0).toUpperCase() + role.slice(1)}`;

      return {
        id: nextLocId(),
        name,
        playwrightCode,
        strategy: "role",
        elementType,
        isInteractive: interactive,
        isConditional,
        isDynamic,
        confidence: 0.75,
        flags,
      };
    }
    // FORM_CONTROL role with no qualifying text: fall through to priority 4 (placeholder/name)
  }

  // ── Priority 4: placeholder ────────────────────────────────────────────────
  // Reliable for any input/textarea that has a placeholder. Framework-agnostic.
  const placeholder = getJSXAttr(attrs, "placeholder");
  if (placeholder.exists && placeholder.value) {
    if (isConditional) flags.push("CONDITIONAL_ELEMENT");
    if (isDynamic) flags.push("DYNAMIC_LIST");

    return {
      id: nextLocId(),
      name: toCamelCase(placeholder.value),
      playwrightCode: `page.getByPlaceholder('${placeholder.value}')`,
      strategy: "placeholder",
      elementType,
      isInteractive: interactive,
      isConditional,
      isDynamic,
      confidence: 0.70,
      flags,
    };
  }

  // ── Priority 4.5: name attribute CSS selector ──────────────────────────────
  // The HTML `name` attribute is required for form submission, so it is always
  // present on real form controls and unique within a form.
  // page.locator('[name="status"]') is stable, framework-agnostic, and
  // far better than an unqualified role when no label/placeholder exists.
  const nameAttr = getJSXAttr(attrs, "name");
  if (nameAttr.exists && nameAttr.value && !nameAttr.isDynamic &&
      ["input", "select", "textarea"].includes(tag)) {
    if (isConditional) flags.push("CONDITIONAL_ELEMENT");
    if (isDynamic) flags.push("DYNAMIC_LIST");

    return {
      id: nextLocId(),
      name: toCamelCase(nameAttr.value),
      playwrightCode: `page.locator('[name="${nameAttr.value}"]')`,
      strategy: "css",
      elementType,
      isInteractive: interactive,
      isConditional,
      isDynamic,
      confidence: 0.65,
      flags,
    };
  }

  // ── Priority 5: CSS selectors (BRITTLE) ────────────────────────────────────
  const idAttr = getJSXAttr(attrs, "id");
  if (idAttr.exists && idAttr.value && !idAttr.isDynamic) {
    if (isConditional) flags.push("CONDITIONAL_ELEMENT");
    if (isDynamic) flags.push("DYNAMIC_LIST");
    flags.push("BRITTLE");

    return {
      id: nextLocId(),
      name: toCamelCase(idAttr.value),
      playwrightCode: `page.locator('#${idAttr.value}') // ⚠️ BRITTLE`,
      strategy: "css",
      elementType,
      isInteractive: interactive,
      isConditional,
      isDynamic,
      confidence: 0.50,
      flags,
    };
  }

  const classNameAttr = getJSXAttr(attrs, "className");
  if (classNameAttr.exists && classNameAttr.value && !classNameAttr.isDynamic) {
    if (isConditional) flags.push("CONDITIONAL_ELEMENT");
    if (isDynamic) flags.push("DYNAMIC_LIST");
    flags.push("BRITTLE");

    // Build CSS class selector
    const classes = classNameAttr.value
      .trim()
      .split(/\s+/)
      .map((c) => `.${c}`)
      .join("");

    return {
      id: nextLocId(),
      name: toCamelCase(classNameAttr.value.split(" ")[0]),
      playwrightCode: `page.locator('${classes}') // ⚠️ BRITTLE`,
      strategy: "css",
      elementType,
      isInteractive: interactive,
      isConditional,
      isDynamic,
      confidence: 0.50,
      flags,
    };
  }

  return null;
}

// ─── Form flow extraction ─────────────────────────────────────────────────────

interface FormInteractive {
  tag: string;
  inputType: string;
  locatorCode: string;
  fieldType: string;
}

function collectFormInteractives(
  children: TSESTree.JSXChild[]
): FormInteractive[] {
  const result: FormInteractive[] = [];

  for (const child of children) {
    if (child.type !== "JSXElement") continue;
    const el = child as TSESTree.JSXElement;
    const tag = getJSXTagName(el.openingElement.name);
    if (!tag) continue;

    const attrs = el.openingElement.attributes;
    const inputTypeAttr = getJSXAttr(attrs, "type");
    const inputType = inputTypeAttr.value ?? "text";

    if (["input", "textarea", "select"].includes(tag)) {
      const locatorCode = buildInputLocator(tag, inputType, attrs, el.children);
      const fieldType = inputType === "text" ? "text" : inputType;
      result.push({ tag, inputType, locatorCode, fieldType });
    }

    if (tag === "button") {
      const inputTypeB = inputTypeAttr.value ?? "button";
      const textContent = extractJSXText(el.children);
      const ariaLabel = getJSXAttr(attrs, "aria-label");
      const name = ariaLabel.value ?? textContent ?? "button";
      const locatorCode = `page.getByRole('button', { name: '${name.replace(/'/g, "\\'")}' })`;
      result.push({
        tag: "button",
        inputType: inputTypeB,
        locatorCode,
        fieldType: inputTypeB,
      });
    }

    // Recurse into children (handles wrappers like <div><input /></div>)
    const nested = collectFormInteractives(el.children);
    result.push(...nested);
  }

  return result;
}

function buildInputLocator(
  tag: string,
  inputType: string,
  attrs: (TSESTree.JSXAttribute | TSESTree.JSXSpreadAttribute)[],
  children: TSESTree.JSXChild[]
): string {
  // Check test-id first
  const testId = findTestIdAttr(attrs);
  if (testId.exists && testId.value) {
    return `page.getByTestId('${testId.value}')`;
  }
  // aria-label
  const ariaLabel = getJSXAttr(attrs, "aria-label");
  if (ariaLabel.value) return `page.getByLabel('${ariaLabel.value}')`;
  // placeholder
  const placeholder = getJSXAttr(attrs, "placeholder");
  if (placeholder.value) return `page.getByPlaceholder('${placeholder.value}')`;
  // role
  const role = tagToRole(tag, inputType);
  if (role && inputType !== "password") {
    const textContent = extractJSXText(children);
    const nameOpts = textContent ? `, { name: '${textContent.replace(/'/g, "\\'")}' }` : "";
    return `page.getByRole('${role}'${nameOpts})`;
  }
  // password fallback
  if (tag === "input" && inputType === "password") {
    return `page.locator('input[type="password"]')`;
  }
  // CSS fallback
  return `page.locator('${tag}')`;
}

function inferTestValue(inputType: string, fieldType: string): string | null {
  switch (inputType) {
    case "email": return "process.env.SMOKE_TEST_EMAIL || 'smoketest@example.com'";
    case "password": return "process.env.SMOKE_TEST_PASSWORD || 'SmokeTest123!'";
    case "number": return "1";
    case "checkbox":
    case "radio": return null;
    case "submit":
    case "button":
    case "reset": return null;
    default:
      if (fieldType === "email") return "process.env.SMOKE_TEST_EMAIL || 'smoketest@example.com'";
      return "'smoke-test-value'";
  }
}

function formInteractiveToStep(fi: FormInteractive, order: number): FormStep {
  const testValue = inferTestValue(fi.inputType, fi.fieldType);

  if (fi.tag === "button" || fi.inputType === "submit" || fi.inputType === "reset") {
    return {
      order,
      action: "click",
      locatorCode: fi.locatorCode,
      testValue: null,
      fieldType: fi.fieldType,
    };
  }
  if (fi.inputType === "checkbox") {
    return {
      order,
      action: "check",
      locatorCode: fi.locatorCode,
      testValue: null,
      fieldType: "checkbox",
    };
  }
  if (fi.tag === "select") {
    return {
      order,
      action: "select",
      locatorCode: fi.locatorCode,
      testValue: "'smoke-test-value'",
      fieldType: "select",
    };
  }
  return {
    order,
    action: "fill",
    locatorCode: fi.locatorCode,
    testValue,
    fieldType: fi.fieldType,
  };
}

function buildFormFlow(
  el: TSESTree.JSXElement,
  fileBaseName: string
): FormFlow {
  const opening = el.openingElement;
  const attrs = opening.attributes;

  const testIdAttr = findTestIdAttr(attrs);
  const actionAttr = getJSXAttr(attrs, "action");

  // Try to derive a name from the test-id or file name
  const name = testIdAttr.value
    ? toCamelCase(testIdAttr.value)
    : `${fileBaseName}Form`;

  const interactives = collectFormInteractives(el.children);
  const steps: FormStep[] = interactives.map((fi, i) =>
    formInteractiveToStep(fi, i + 1)
  );

  // Try to infer linked endpoint from form action attr
  const linkedEndpointId = actionAttr.value
    ? `POST ${actionAttr.value}`
    : null;

  return {
    id: nextFlowId(),
    name,
    testId: testIdAttr.value,
    steps,
    linkedEndpointId,
    successRedirectHint: null,
  };
}

// ─── Navigation link extraction ───────────────────────────────────────────────

function extractNavigationLinks(
  ast: TSESTree.Program
): NavigationLink[] {
  const links: NavigationLink[] = [];
  const seen = new Set<string>();

  walk(ast, (node) => {
    if (node.type !== "JSXElement") return;
    const el = node as TSESTree.JSXElement;
    const tag = getJSXTagName(el.openingElement.name);
    if (tag !== "a" && tag !== "Link") return;

    const attrs = el.openingElement.attributes;
    const href = getJSXAttr(attrs, "href").value ?? getJSXAttr(attrs, "to").value;
    if (!href || seen.has(href)) return;
    seen.add(href);

    const text = extractJSXText(el.children) ?? href;
    links.push({
      text,
      href,
      locatorCode: `page.getByRole('link', { name: '${text.replace(/'/g, "\\'")}' })`,
    });
  });

  return links;
}

// ─── File path → route heuristic ─────────────────────────────────────────────

function filePathToRoute(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  // Next.js App Router: src/app/(group)/login/page.tsx → /login
  // Must be checked before the legacy /pages/ pattern.
  const appRouterMatch = normalized.match(/\/app\/(.+?)\/page\.(tsx?|jsx?)$/);
  if (appRouterMatch) {
    const segments = appRouterMatch[1].split("/").reduce<string[]>((acc, seg) => {
      // Strip route groups: (groupName) → no URL segment
      if (/^\(.*\)$/.test(seg)) return acc;
      // Catch-all: [...param] → *
      if (/^\[\.\.\.(.+)\]$/.test(seg)) { acc.push("*"); return acc; }
      // Dynamic: [param] → :param
      const dynMatch = seg.match(/^\[(.+)\]$/);
      if (dynMatch) { acc.push(`:${dynMatch[1]}`); return acc; }
      acc.push(seg);
      return acc;
    }, []);
    const route = "/" + segments.join("/");
    return route === "/" ? "/" : route;
  }

  // Next.js Pages Router: src/pages/users/[userId].tsx → /users/:userId
  const pagesMatch = normalized.match(/\/pages\/(.+?)\.(tsx?|jsx?)$/);
  if (pagesMatch) {
    let route = pagesMatch[1]
      .replace(/\/index$/, "")
      .replace(/\[\.\.\.([^\]]+)\]/g, "*")
      .replace(/\[([^\]]+)\]/g, ":$1");
    if (!route.startsWith("/")) route = "/" + route;
    return route || "/";
  }

  // Remix flat-file: app/routes/appointments.$appointmentId.tsx → /appointments/:appointmentId
  // Dot-segments = path separators; $param = :param; _index = index (no segment)
  const remixMatch = normalized.match(/\/routes\/(.+?)\.(tsx?|jsx?)$/);
  if (remixMatch) {
    const parts = remixMatch[1].split(".");
    const segments: string[] = [];
    for (const part of parts) {
      if (part === "_index") continue;           // index route — no segment
      if (part.startsWith("_")) continue;        // layout segment (e.g. _app) — no URL segment
      if (part.startsWith("$")) {
        segments.push(`:${part.slice(1)}`);      // $param → :param
      } else {
        segments.push(part);
      }
    }
    const route = "/" + segments.join("/");
    return route === "/" ? "/" : route.replace(/\/+/g, "/");
  }

  return "";
}

function extractTitleFromFile(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const base = (normalized.split("/").pop() ?? filePath).replace(/\.(tsx?|jsx?)$/, "");
  // For App Router / Pages Router: filename "page" or "index" — use parent segment
  if (/^(index|page)$/i.test(base)) {
    const segments = normalized.split("/");
    for (let i = segments.length - 2; i >= 0; i--) {
      const seg = segments[i];
      if (!seg || /^\(.*\)$/.test(seg)) continue;       // skip route groups (auth), layouts
      if (seg === "app" || seg === "pages" || seg === "src") break;
      if (/^\[/.test(seg)) continue;                    // skip dynamic segments [id], [...slug]
      return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/[-_]/g, " ");
    }
    return "Home";
  }
  // Remix flat-file routing: strip $param segments and _index — use first meaningful segment
  // e.g. "appointments.$appointmentId" → "appointments" → "Appointments"
  const firstSeg = base.split(".").find((s) => s && !s.startsWith("$") && s !== "_index") ?? base;
  return firstSeg.charAt(0).toUpperCase() + firstSeg.slice(1).replace(/[-_]/g, " ");
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Extract UI locators, form flows, and navigation links from React component files.
 * Returns one ExtractedPage per .tsx/.jsx file.
 */
export function extractReactLocators(files: ParsedFile[]): ExtractedPage[] {
  const pages: ExtractedPage[] = [];

  // PASS 1: Build component registry from all non-route component files.
  // This maps PascalCase component names to locator templates with {{prop}} placeholders.
  const componentRegistry = buildComponentRegistry(files);

  for (const file of files) {
    if (!file.ast) continue;
    const fp = file.filePath.replace(/\\/g, "/");
    if (!fp.endsWith(".tsx") && !fp.endsWith(".jsx")) continue;

    // Skip test files, stories, node_modules
    if (
      fp.includes(".test.") ||
      fp.includes(".spec.") ||
      fp.includes(".stories.") ||
      fp.includes("node_modules")
    ) continue;

    const locators: ExtractedLocator[] = [];
    const formFlows: FormFlow[] = [];
    const seenPlawright = new Set<string>();

    // Pre-pass: build htmlFor → label text map.
    // Handles <label htmlFor="email">Email</label> → { "email": "Email" }
    // so that the sibling <input id="email"> can use page.getByLabel('Email').
    const htmlForMap = new Map<string, string>();
    walk(file.ast, (node) => {
      if (node.type !== "JSXElement") return;
      const el = node as TSESTree.JSXElement;
      const tag = getJSXTagName(el.openingElement.name);
      if (tag !== "label") return;
      const htmlForAttr = getJSXAttr(el.openingElement.attributes, "htmlFor");
      if (!htmlForAttr.exists || !htmlForAttr.value || htmlForAttr.isDynamic) return;
      const labelText = extractJSXText(el.children);
      if (isValidLabelText(labelText)) {
        htmlForMap.set(htmlForAttr.value, labelText!);
      }
    });

    // Walk AST collecting JSXElements and keeping track of parent
    const parentMap = new Map<TSESTree.Node, TSESTree.Node | null>();

    walk(file.ast, (node, parent) => {
      parentMap.set(node, parent);

      if (node.type !== "JSXElement") return;

      const el = node as TSESTree.JSXElement;
      const tag = getJSXTagName(el.openingElement.name);

      // Form flow extraction
      if (tag === "form") {
        const fileBase = extractTitleFromFile(fp);
        const flow = buildFormFlow(el, toCamelCase(fileBase));
        if (flow.steps.length > 0) {
          formFlows.push(flow);
        }
        return;
      }

      // Locator extraction — detect if parent is a <label> to inherit label text
      const parentNode = parentMap.get(node) ?? null;
      let inheritedLabelText: string | null = null;
      if (parentNode?.type === "JSXElement") {
        const parentEl = parentNode as TSESTree.JSXElement;
        const parentTag = getJSXTagName(parentEl.openingElement.name);
        if (parentTag === "label") {
          const rawLabel = extractJSXText(parentEl.children);
          if (isValidLabelText(rawLabel)) inheritedLabelText = rawLabel;
        }
      }
      const locator = extractLocatorFromJSXElement(el, parentNode, inheritedLabelText, htmlForMap);
      if (locator && !seenPlawright.has(locator.playwrightCode)) {
        seenPlawright.add(locator.playwrightCode);
        locators.push(locator);
      }
    });

    // PASS 2 (component resolution): Walk this file's JSX looking for PascalCase component
    // usages (e.g. <ButtonGroup label="Export" />). For each one, look up the component
    // registry and resolve placeholders to concrete Playwright locators.
    // This is purely additive — it never duplicates locators already found via HTML extraction.
    walk(file.ast, (node) => {
      if (node.type !== "JSXElement") return;
      const el = node as TSESTree.JSXElement;
      const tag = getJSXTagName(el.openingElement.name);
      // Only PascalCase names (components, not HTML tags)
      if (!tag || !/^[A-Z]/.test(tag)) return;
      const resolved = resolveComponentLocators(
        tag,
        el.openingElement.attributes,
        componentRegistry,
        nextLocId
      );
      for (const loc of resolved) {
        if (!seenPlawright.has(loc.playwrightCode)) {
          seenPlawright.add(loc.playwrightCode);
          locators.push(loc);
        }
      }
    });

    const navLinks = extractNavigationLinks(file.ast);
    const route = filePathToRoute(fp);
    const title = extractTitleFromFile(fp);

    // Detect authRequired + roles by scanning the entire file AST
    // (not just JSX) for requireUser / requireRole calls
    let fileAuthRequired = false;
    const fileRoles: string[] = [];
    walk(file.ast, (node) => {
      if (node.type !== "CallExpression") return;
      const call = node as TSESTree.CallExpression;
      if (call.callee.type !== "Identifier") return;
      const fnName = (call.callee as TSESTree.Identifier).name;
      if (/^requireUser$|^requireRole$|^requireAuth$|^requireSession$/i.test(fnName)) {
        fileAuthRequired = true;
        // requireRole(request, ['admin', 'doctor']) — extract roles from 2nd arg
        if (fnName.toLowerCase() === "requirerole" || fnName.toLowerCase() === "requirepermission") {
          const rolesArg = call.arguments[1];
          if (rolesArg?.type === "ArrayExpression") {
            for (const el of (rolesArg as TSESTree.ArrayExpression).elements) {
              if (el?.type === "Literal" && typeof (el as TSESTree.Literal).value === "string") {
                const role = String((el as TSESTree.Literal).value);
                if (!fileRoles.includes(role)) fileRoles.push(role);
              }
            }
          }
        }
      }
    });

    // Build routeParams from dynamic segments
    const rawParams = [...route.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => ({
      name: m[1],
      example: "test-id",
    }));
    const isDynamic = rawParams.length > 0;

    const normalizedRoute = route.replace(
      /:([a-zA-Z0-9_]+)/g,
      "11111111-2222-3333-4444-555555555555"
    );

    // Only emit pages that have at least some locators or form flows
    if (locators.length === 0 && formFlows.length === 0 && navLinks.length === 0) continue;

    pages.push({
      id: nextPageId(),
      route: route || fp,
      normalizedRoute: normalizedRoute || fp,
      title,
      filePath: fp,
      authRequired: fileAuthRequired,
      roles: fileRoles,
      isDynamic,
      routeParams: rawParams,
      locators,
      formFlows,
      navigationLinks: navLinks,
      linkedEndpoints: [],
      confidence: 0.70,
    });
  }

  return pages;
}
