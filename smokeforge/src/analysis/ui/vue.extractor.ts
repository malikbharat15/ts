// src/analysis/ui/vue.extractor.ts
// Regex-based extraction for Vue SFCs (.vue files).
// TSESTree cannot parse Vue templates, so we extract <script> and <template>
// blocks via regex, then scan each block independently.

import * as fs from "fs";
import * as path from "path";
import type { ParsedFile } from "../parser";
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
  `vue_page_${String(++_pageCount).padStart(3, "0")}`;

let _locCount = 0;
const nextLocId = (): string =>
  `vue_loc_${String(++_locCount).padStart(4, "0")}`;

let _flowCount = 0;
const nextFlowId = (): string =>
  `vue_flow_${String(++_flowCount).padStart(3, "0")}`;

// ─── Block extraction ─────────────────────────────────────────────────────────

interface SfcBlocks {
  template: string;
  script: string;
}

function extractSfcBlocks(raw: string): SfcBlocks {
  const templateMatch = raw.match(/<template(?:[^>]*)>([\s\S]*?)<\/template>/i);
  const scriptMatch = raw.match(/<script(?:[^>]*)>([\s\S]*?)<\/script>/i);
  return {
    template: templateMatch ? templateMatch[1] : "",
    script: scriptMatch ? scriptMatch[1] : "",
  };
}

// ─── Component name extraction ────────────────────────────────────────────────

function extractComponentName(script: string): string | null {
  const m = script.match(/\bname\s*:\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

// ─── HTML attribute helpers ───────────────────────────────────────────────────

function readStaticAttr(attrs: string, attr: string): string | null {
  const re = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`);
  const m = attrs.match(re);
  return m ? m[1] : null;
}

function hasDynamicAttr(attrs: string, attr: string): boolean {
  const re = new RegExp(`(?::|v-bind:)${attr}\\s*=\\s*["'][^"']*["']`);
  return re.test(attrs);
}

function elementTypeFromTag(tagName: string): ExtractedLocator["elementType"] {
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

function innerText(template: string, tagStart: number, tagName: string): string {
  const closeTag = `</${tagName}>`;
  const closeIdx = template.indexOf(closeTag, tagStart);
  if (closeIdx === -1) return "";
  const openEnd = template.indexOf(">", tagStart);
  if (openEnd === -1 || openEnd > closeIdx) return "";
  return template.slice(openEnd + 1, closeIdx).replace(/<[^>]+>/g, "").trim();
}

function inputTypeFromAttrs(attrs: string): string {
  return (attrs.match(/\btype\s*=\s*["']([^"']+)["']/) ?? [])[1] ?? "text";
}

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
      const text = locValue.replace(/^(?:button|link|heading)\[name="(.*)"\]$/, "$1");
      return `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(text)} })`;
    }
    default:
      return `page.locator(${JSON.stringify(locValue)})`;
  }
}

// ─── Template locator scan ────────────────────────────────────────────────────

interface RawLocator {
  locator: ExtractedLocator;
  isFormField: boolean;
}

const TAG_RE = /<([\w-]+)([^>]*)>/gi;

function scanTemplate(template: string): RawLocator[] {
  const results: RawLocator[] = [];
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;

  while ((match = TAG_RE.exec(template)) !== null) {
    const tagName = match[1];
    const attrs = match[2];
    const tagStart = match.index;
    const elType = elementTypeFromTag(tagName);
    const flags: ExtractorFlag[] = [];

    if (/\bv-if\s*=/.test(attrs)) flags.push("CONDITIONAL_ELEMENT");
    if (/\bv-for\s*=/.test(attrs)) flags.push("DYNAMIC_LIST");

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

    if (hasDynamicAttr(attrs, "data-testid")) {
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

    // Priority 3: placeholder
    if (elType === "input" || elType === "textarea") {
      const placeholder = readStaticAttr(attrs, "placeholder");
      if (placeholder) {
        results.push({
          locator: {
            id: nextLocId(),
            name: placeholder,
            playwrightCode: buildPlaywrightCode(
              "placeholder",
              placeholder,
              elType
            ),
            strategy: "placeholder",
            elementType: elType,
            isInteractive: true,
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

    // Priority 4: role + text (buttons / links)
    if (elType === "button" || elType === "link") {
      const text = innerText(template, tagStart, tagName);
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
            confidence: 0.7,
            flags,
          },
          isFormField: false,
        });
        continue;
      }
    }

    // Priority 5: img alt text
    if (tagName.toLowerCase() === "img") {
      const alt = readStaticAttr(attrs, "alt");
      if (alt) {
        results.push({
          locator: {
            id: nextLocId(),
            name: alt,
            playwrightCode: buildPlaywrightCode("altText", alt, "other"),
            strategy: "altText",
            elementType: "other",
            isInteractive: false,
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

    // Fallback: v-model inputs
    if (elType === "input") {
      const vModel = (attrs.match(/\bv-model\s*=\s*["']([^"']+)["']/) ?? [])[1];
      if (vModel) {
        const inputType = inputTypeFromAttrs(attrs);
        const cssValue = `input[type="${inputType}"]`;
        results.push({
          locator: {
            id: nextLocId(),
            name: vModel,
            playwrightCode: buildPlaywrightCode("css", cssValue, "input"),
            strategy: "css",
            elementType: "input",
            isInteractive: true,
            isConditional,
            isDynamic: false,
            confidence: 0.45,
            flags: [...flags, "BRITTLE"],
          },
          isFormField: true,
        });
      }
    }
  }

  return results;
}

// ─── Navigation link extraction ───────────────────────────────────────────────

function extractNavLinks(template: string): NavigationLink[] {
  const links: NavigationLink[] = [];
  let m: RegExpExecArray | null;

  const routerRe =
    /<(?:router-link|nuxt-link|NuxtLink|RouterLink)\b[^>]*\bto\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:router-link|nuxt-link|NuxtLink|RouterLink)>/gi;
  while ((m = routerRe.exec(template)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim() || href;
    links.push({
      href,
      text,
      locatorCode: `page.getByRole("link", { name: ${JSON.stringify(text)} })`,
    });
  }

  const hrefRe =
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = hrefRe.exec(template)) !== null) {
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

// ─── Form flow detection ──────────────────────────────────────────────────────

function detectFormFlows(rawLocs: RawLocator[], template: string): FormFlow[] {
  const hasForm = /<form\b/i.test(template);
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
    /<button[^>]*\btype\s*=\s*["']submit["'][^>]*>([\s\S]*?)<\/button>/i;
  const submitMatch = template.match(submitRe);
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

export function extractVueLocators(files: ParsedFile[]): ExtractedPage[] {
  const pages: ExtractedPage[] = [];

  for (const file of files) {
    if (!file.filePath.endsWith(".vue")) continue;

    const raw = (() => {
      try {
        return fs.readFileSync(file.filePath, "utf-8");
      } catch {
        return file.code;
      }
    })();

    const { template, script } = extractSfcBlocks(raw);
    const componentName = extractComponentName(script);
    const rawLocs = scanTemplate(template);
    const locators: ExtractedLocator[] = rawLocs.map((r) => r.locator);
    const formFlows = detectFormFlows(rawLocs, template);
    const navLinks = extractNavLinks(template);

    const baseName = path.basename(file.filePath, ".vue");
    const title = componentName ?? baseName;

    pages.push({
      id: nextPageId(),
      route: "",
      normalizedRoute: "",
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
      confidence: locators.length > 0 ? 0.7 : 0.3,
    });
  }

  return pages;
}