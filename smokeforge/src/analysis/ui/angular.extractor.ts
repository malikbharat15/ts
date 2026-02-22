// src/analysis/ui/angular.extractor.ts
// AST + regex-based extraction for Angular components.
// Finds @Component decorators, reads templateUrl/inline template,
// scans HTML for Angular attribute patterns, and extracts
// reactive form field names from fb.group({}) calls.

import * as fs from "fs";
import * as path from "path";
import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import {
  walk,
  extractStringValue,
  getDecorators,
} from "../../utils/ast-utils";
import type {
  ExtractedLocator,
  ExtractedPage,
  ExtractorFlag,
  FormFlow,
  FormStep,
  NavigationLink,
} from "../../blueprint/types";

// ─── ID counters ─────────────────────────────────────────────────────────────

let _pageCount = 0;
const nextPageId = (): string =>
  `ng_page_${String(++_pageCount).padStart(3, "0")}`;

let _locCount = 0;
const nextLocId = (): string =>
  `ng_loc_${String(++_locCount).padStart(4, "0")}`;

let _flowCount = 0;
const nextFlowId = (): string =>
  `ng_flow_${String(++_flowCount).padStart(3, "0")}`;

// ─── Playwright code builder ──────────────────────────────────────────────────

function buildPlaywrightCode(
  strategy: ExtractedLocator["strategy"],
  locValue: string,
  elementType: ExtractedLocator["elementType"]
): string {
  switch (strategy) {
    case "testId":      return `page.getByTestId(${JSON.stringify(locValue)})`;
    case "label":       return `page.getByLabel(${JSON.stringify(locValue)})`;
    case "placeholder": return `page.getByPlaceholder(${JSON.stringify(locValue)})`;
    case "altText":     return `page.getByAltText(${JSON.stringify(locValue)})`;
    case "text":        return `page.getByText(${JSON.stringify(locValue)})`;
    case "role": {
      const role =
        elementType === "button" ? "button"
        : elementType === "link" ? "link"
        : elementType === "heading" ? "heading"
        : "generic";
      const text = locValue.replace(
        /^(?:button|link|heading)\[name="(.*)"\]$/,
        "$1"
      );
      return `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(text)} })`;
    }
    default:
      return `page.locator(${JSON.stringify(locValue)})`;
  }
}

// ─── Element type from tag ────────────────────────────────────────────────────

function elementTypeFromTag(
  tagName: string
): ExtractedLocator["elementType"] {
  switch (tagName.toLowerCase()) {
    case "button":   return "button";
    case "input":    return "input";
    case "a":        return "link";
    case "select":   return "select";
    case "textarea": return "textarea";
    case "form":     return "form";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":       return "heading";
    default:         return "other";
  }
}

// ─── HTML attribute helpers ───────────────────────────────────────────────────

function readStaticAttr(attrs: string, attr: string): string | null {
  const re = new RegExp(`\\b${attr}\\s*=\\s*["\']([^"\']+)["\']`);
  const m = attrs.match(re);
  return m ? m[1] : null;
}

/** Angular dynamic binding: [attr.data-testid]="..." */
function hasDynamicBinding(attrs: string, attr: string): boolean {
  const escaped = attr.replace(/-/g, "\\-");
  const re = new RegExp(`\\[${escaped}\\]\\s*=\\s*["\'][^"\']*["\']`);
  return re.test(attrs) || new RegExp(`\\[attr\\.${escaped}\\]\\s*=`).test(attrs);
}

function innerText(html: string, tagStart: number, tagName: string): string {
  const closeTag = `</${tagName}>`;
  const closeIdx = html.indexOf(closeTag, tagStart);
  if (closeIdx === -1) return "";
  const openEnd = html.indexOf(">", tagStart);
  if (openEnd === -1 || openEnd > closeIdx) return "";
  return html.slice(openEnd + 1, closeIdx).replace(/<[^>]+>/g, "").trim();
}

// ─── HTML template scanner ────────────────────────────────────────────────────

interface RawLocator {
  locator: ExtractedLocator;
  isFormField: boolean;
}

const TAG_RE = /<([\w-]+)([^>]*)>/gi;

function scanHtml(html: string, filePath: string): RawLocator[] {
  const results: RawLocator[] = [];
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;

  while ((match = TAG_RE.exec(html)) !== null) {
    const tagName = match[1];
    const attrs = match[2];
    const tagStart = match.index;
    const elType = elementTypeFromTag(tagName);
    const flags: ExtractorFlag[] = [];

    if (/\*ngIf\s*=/.test(attrs)) flags.push("CONDITIONAL_ELEMENT");
    if (/\*ngFor\s*=/.test(attrs)) flags.push("DYNAMIC_LIST");

    const isInteractive =
      elType === "button" ||
      elType === "input" ||
      elType === "select" ||
      elType === "textarea" ||
      elType === "link";
    const isConditional = flags.includes("CONDITIONAL_ELEMENT");

    // Priority 1: data-testid
    const staticTestId = readStaticAttr(attrs, "data-testid");
    if (staticTestId) {
      results.push({
        locator: {
          id: nextLocId(),
          name: staticTestId,
          playwrightCode: buildPlaywrightCode("testId", staticTestId, elType),
          strategy: "testId",
          elementType: elType,
          isInteractive,
          isConditional,
          isDynamic: false,
          confidence: 0.95,
          flags,
        },
        isFormField:
          elType === "input" || elType === "select" || elType === "textarea",
      });
      continue;
    }

    if (hasDynamicBinding(attrs, "data-testid")) {
      results.push({
        locator: {
          id: nextLocId(),
          name: "[dynamic-testid]",
          playwrightCode: `page.getByTestId("[dynamic]")`,
          strategy: "testId",
          elementType: elType,
          isInteractive,
          isConditional,
          isDynamic: true,
          confidence: 0.5,
          flags: [...flags, "DYNAMIC_TESTID"],
        },
        isFormField: false,
      });
      continue;
    }

    // Priority 2: aria-label
    const ariaLabel = readStaticAttr(attrs, "aria-label");
    if (ariaLabel) {
      results.push({
        locator: {
          id: nextLocId(),
          name: ariaLabel,
          playwrightCode: buildPlaywrightCode("label", ariaLabel, elType),
          strategy: "label",
          elementType: elType,
          isInteractive,
          isConditional,
          isDynamic: false,
          confidence: 0.85,
          flags,
        },
        isFormField:
          elType === "input" || elType === "select" || elType === "textarea",
      });
      continue;
    }

    // Priority 3: formControlName
    const fcn = readStaticAttr(attrs, "formControlName");
    if (fcn) {
      const cssValue = `[formControlName="${fcn}"]`;
      results.push({
        locator: {
          id: nextLocId(),
          name: fcn,
          playwrightCode: buildPlaywrightCode("css", cssValue, elType),
          strategy: "css",
          elementType: elType,
          isInteractive: isInteractive,
          isConditional,
          isDynamic: false,
          confidence: 0.8,
          flags,
        },
        isFormField: true,
      });
      continue;
    }

    // Priority 4: ngModel + name
    if (/\[\(ngModel\)\]\s*=/.test(attrs)) {
      const nameAttr = readStaticAttr(attrs, "name");
      if (nameAttr) {
        const cssValue = `[name="${nameAttr}"]`;
        results.push({
          locator: {
            id: nextLocId(),
            name: nameAttr,
            playwrightCode: buildPlaywrightCode("css", cssValue, elType),
            strategy: "css",
            elementType: elType,
            isInteractive: isInteractive,
            isConditional,
            isDynamic: false,
            confidence: 0.75,
            flags,
          },
          isFormField: true,
        });
        continue;
      }
    }

    // Priority 5: placeholder
    if (elType === "input" || elType === "textarea") {
      const placeholder = readStaticAttr(attrs, "placeholder");
      if (placeholder) {
        results.push({
          locator: {
            id: nextLocId(),
            name: placeholder,
            playwrightCode: buildPlaywrightCode("placeholder", placeholder, elType),
            strategy: "placeholder",
            elementType: elType,
            isInteractive: true,
            isConditional,
            isDynamic: false,
            confidence: 0.7,
            flags,
          },
          isFormField: true,
        });
        continue;
      }
    }

    // Role + text (buttons / links)
    if (elType === "button" || elType === "link") {
      const text = innerText(html, tagStart, tagName);
      if (text) {
        const roleValue = `${elType}[name="${text}"]`;
        results.push({
          locator: {
            id: nextLocId(),
            name: text,
            playwrightCode: buildPlaywrightCode("role", roleValue, elType),
            strategy: "role",
            elementType: elType,
            isInteractive: true,
            isConditional,
            isDynamic: false,
            confidence: 0.65,
            flags,
          },
          isFormField: false,
        });
        continue;
      }
    }

    // filePath used to scope locator names uniquely — suppresses unused param
    void filePath;
  }

  return results;
}

// ─── Navigation link extraction ───────────────────────────────────────────────

function extractNavLinks(html: string): NavigationLink[] {
  const links: NavigationLink[] = [];
  let m: RegExpExecArray | null;

  // Angular routerLink
  const routerRe =
    /<a\b[^>]*\brouterLink\s*=\s*["\']([^"\']+)["\'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = routerRe.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim() || href;
    links.push({
      href,
      text,
      locatorCode: `page.getByRole("link", { name: ${JSON.stringify(text)} })`,
    });
  }

  // Plain <a href="...">
  const hrefRe =
    /<a\b(?!.*\brouterLink)[^>]*\bhref\s*=\s*["\']([^"\']+)["\'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim() || href;
    links.push({
      href,
      text,
      locatorCode: `page.getByRole("link", { name: ${JSON.stringify(text)} })`,
    });
  }

  return links;
}

// ─── Reactive forms extraction from AST ──────────────────────────────────────

function extractReactiveFormFields(
  ast: TSESTree.Program,
  sourceFilePath: string
): RawLocator[] {
  const results: RawLocator[] = [];

  walk(ast, (node) => {
    // Find calls to fb.group({...}) / this.fb.group / this.formBuilder.group
    if (node.type !== "CallExpression") return;
    const call = node as TSESTree.CallExpression;
    if (call.callee.type !== "MemberExpression") return;
    const callee = call.callee as TSESTree.MemberExpression;
    if (callee.property.type !== "Identifier") return;
    if ((callee.property as TSESTree.Identifier).name !== "group") return;
    if (call.arguments.length === 0) return;

    const firstArg = call.arguments[0];
    if (firstArg.type !== "ObjectExpression") return;

    const obj = firstArg as TSESTree.ObjectExpression;
    for (const prop of obj.properties) {
      if (prop.type !== "Property") continue;
      const p = prop as TSESTree.Property;
      let fieldName: string | null = null;
      if (p.key.type === "Identifier") {
        fieldName = (p.key as TSESTree.Identifier).name;
      } else if (p.key.type === "Literal") {
        const lit = (p.key as TSESTree.Literal).value;
        fieldName = typeof lit === "string" ? lit : null;
      }
      if (!fieldName) continue;

      const cssValue = `[formControlName="${fieldName}"]`;
      results.push({
        locator: {
          id: nextLocId(),
          name: fieldName,
          playwrightCode: buildPlaywrightCode("css", cssValue, "input"),
          strategy: "css",
          elementType: "input",
          isInteractive: true,
          isConditional: false,
          isDynamic: false,
          confidence: 0.8,
          flags: [],
        },
        isFormField: true,
      });
    }
    void sourceFilePath;
  });

  return results;
}

// ─── @Component decorator parsing ────────────────────────────────────────────

interface ComponentMeta {
  templateContent: string | null;
  selector: string | null;
}

function parseComponentDecorator(
  ast: TSESTree.Program,
  sourceFilePath: string
): ComponentMeta {
  let templateContent: string | null = null;
  let selector: string | null = null;
  const sourceDir = path.dirname(sourceFilePath);

  walk(ast, (node) => {
    if (
      node.type !== "ClassDeclaration" &&
      node.type !== "ClassExpression"
    ) {
      return;
    }
    const decorators = getDecorators(node);
    for (const dec of decorators) {
      if (dec.expression.type !== "CallExpression") continue;
      const call = dec.expression as TSESTree.CallExpression;
      if (call.callee.type !== "Identifier") continue;
      if ((call.callee as TSESTree.Identifier).name !== "Component") continue;
      if (call.arguments.length === 0) continue;

      const arg = call.arguments[0];
      if (arg.type !== "ObjectExpression") continue;

      for (const prop of (arg as TSESTree.ObjectExpression).properties) {
        if (prop.type !== "Property") continue;
        const p = prop as TSESTree.Property;
        if (p.key.type !== "Identifier") continue;
        const keyName = (p.key as TSESTree.Identifier).name;

        if (keyName === "selector") {
          selector = extractStringValue(p.value) ?? null;
        }

        if (keyName === "template") {
          templateContent = extractStringValue(p.value) ?? null;
        }

        if (keyName === "templateUrl") {
          const relUrl = extractStringValue(p.value);
          if (relUrl) {
            const absPath = path.resolve(sourceDir, relUrl);
            try {
              templateContent = fs.readFileSync(absPath, "utf-8");
            } catch {
              // file not accessible — skip
            }
          }
        }
      }
    }
  });

  return { templateContent, selector };
}

// ─── Form flow detection ──────────────────────────────────────────────────────

function detectFormFlows(rawLocs: RawLocator[], html: string): FormFlow[] {
  const hasForm = /<form\b/i.test(html);
  const fields = rawLocs.filter((r) => r.isFormField);
  if (!hasForm || fields.length === 0) return [];

  const steps: FormStep[] = fields.map((r, idx) => ({
    order: idx + 1,
    action: (
      r.locator.elementType === "select"
        ? "select"
        : r.locator.elementType === "input"
        ? "fill"
        : "click"
    ) as FormStep["action"],
    locatorCode: r.locator.playwrightCode,
    testValue: null,
    fieldType: r.locator.elementType,
  }));

  const submitRe =
    /<button[^>]*\btype\s*=\s*["\']submit["\'][^>]*>([\s\S]*?)<\/button>/i;
  const submitMatch = html.match(submitRe);
  if (submitMatch) {
    const btnText =
      submitMatch[1].replace(/<[^>]+>/g, "").trim() || "Submit";
    steps.push({
      order: steps.length + 1,
      action: "click",
      locatorCode: `page.getByRole("button", { name: ${JSON.stringify(btnText)} })`,
      testValue: null,
      fieldType: "button",
    });
  }

  return [
    {
      id: nextFlowId(),
      name: "FormSubmit",
      testId: null,
      steps,
      linkedEndpointId: null,
      successRedirectHint: null,
    },
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function extractAngularLocators(files: ParsedFile[]): ExtractedPage[] {
  const pages: ExtractedPage[] = [];

  for (const file of files) {
    // Only process TypeScript Angular component files
    if (!file.filePath.endsWith(".ts")) continue;
    if (!/\.component\.ts$/.test(file.filePath) &&
        !/@Component/.test(file.code)) continue;

    const { templateContent, selector } = parseComponentDecorator(
      file.ast,
      file.filePath
    );
    if (!templateContent) continue;

    // Scan HTML template
    const htmlLocs = scanHtml(templateContent, file.filePath);

    // Deduplicate formControlName locators with reactive forms AST scan
    const reactiveFormLocs = extractReactiveFormFields(file.ast, file.filePath);
    const seenFcn = new Set<string>(
      htmlLocs.filter((r) => r.isFormField).map((r) => r.locator.name)
    );
    const deduped = reactiveFormLocs.filter((r) => !seenFcn.has(r.locator.name));

    const rawLocs = [...htmlLocs, ...deduped];
    const locators: ExtractedLocator[] = rawLocs.map((r) => r.locator);
    const formFlows = detectFormFlows(rawLocs, templateContent);
    const navLinks = extractNavLinks(templateContent);

    const baseName = path.basename(file.filePath, ".component.ts");
    const title = selector ?? baseName;

    pages.push({
      id: nextPageId(),
      route: selector ? `/${selector}` : "",
      normalizedRoute: selector ? `/${selector}` : "",
      title,
      filePath: file.filePath,
      authRequired: false,
      roles: [],
      isDynamic: false,
      routeParams: [],
      locators,
      formFlows,
      navigationLinks: navLinks,
      linkedEndpoints: [],
      confidence: locators.length > 0 ? 0.7 : 0.35,
    });
  }

  return pages;
}
