import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import { walk, extractStringValue } from "../../utils/ast-utils";
import type { BodyField, RequestBodySchema } from "../../blueprint/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return the chain of method-call names applied to a node, innermost first.
 *  e.g.  z.string().email().optional()  → ["optional", "email", "string"]  (callee name list)
 */
function collectMethodChain(node: TSESTree.Node): string[] {
  const methods: string[] = [];
  let cur: TSESTree.Node = node;
  while (cur.type === "CallExpression") {
    const callee = (cur as TSESTree.CallExpression).callee;
    if (callee.type === "MemberExpression") {
      const prop = callee.property;
      if (prop.type === "Identifier") methods.push(prop.name);
      cur = callee.object;
    } else {
      break;
    }
  }
  return methods;
}

/** Return the root CallExpression at the base of a method chain. */
function getRootCall(node: TSESTree.Node): TSESTree.CallExpression | null {
  let cur: TSESTree.Node = node;
  let last: TSESTree.CallExpression | null = null;
  while (cur.type === "CallExpression") {
    last = cur as TSESTree.CallExpression;
    const callee = last.callee;
    if (callee.type === "MemberExpression") {
      cur = callee.object;
    } else {
      break;
    }
  }
  return last;
}

/** True when the root of the chain is a z.<method>() call (or alias). */
function isZodCall(node: TSESTree.Node, zodAliases: Set<string>): boolean {
  let cur: TSESTree.Node = node;
  while (cur.type === "CallExpression") {
    const callee = (cur as TSESTree.CallExpression).callee;
    if (callee.type === "MemberExpression") {
      const obj = callee.object;
      if (obj.type === "Identifier" && zodAliases.has(obj.name)) return true;
      cur = obj;
    } else if (callee.type === "Identifier" && zodAliases.has(callee.name)) {
      return true;
    } else {
      break;
    }
  }
  return false;
}

/** Extract z aliases from imports: import { z } from 'zod'; import * as z from 'zod'; */
function collectZodAliases(file: ParsedFile): Set<string> {
  const aliases = new Set<string>();
  walk(file.ast, (node) => {
    if (node.type === "ImportDeclaration") {
      const imp = node as TSESTree.ImportDeclaration;
      if (
        imp.source.value === "zod" ||
        (imp.source.value as string).startsWith("zod/")
      ) {
        for (const spec of imp.specifiers) {
          if (
            spec.type === "ImportDefaultSpecifier" ||
            spec.type === "ImportNamespaceSpecifier"
          ) {
            aliases.add(spec.local.name);
          } else if (spec.type === "ImportSpecifier") {
            const named = spec as TSESTree.ImportSpecifier;
            const importedName =
              named.imported.type === "Identifier"
                ? named.imported.name
                : String((named.imported as unknown as TSESTree.Literal).value);
            if (importedName === "z" || importedName === "zod") {
              aliases.add(named.local.name);
            }
          }
        }
      }
    }
  });
  if (aliases.size === 0) aliases.add("z"); // default assumption
  return aliases;
}

// ─── Type extraction from a single Zod node ──────────────────────────────────

interface ZodFieldInfo {
  type: string;
  required: boolean;
  validators: string[];
  example: string | null;
}

function extractZodFieldInfo(
  node: TSESTree.Node,
  zodAliases: Set<string>
): ZodFieldInfo {
  const methods = collectMethodChain(node);
  const info: ZodFieldInfo = {
    type: "unknown",
    required: true,
    validators: [],
    example: null,
  };

  // Walk down to the innermost z.<type>() call to determine the base type
  const rootCall = getRootCall(node);
  if (rootCall) {
    const callee = rootCall.callee;
    if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
      const typeName = callee.property.name;
      switch (typeName) {
        case "string":
          info.type = "string";
          info.example = "smoke-test-value";
          break;
        case "number":
          info.type = "number";
          info.example = "1";
          break;
        case "boolean":
          info.type = "boolean";
          info.example = "true";
          break;
        case "date":
          info.type = "string";
          info.validators.push("format:date-time");
          info.example = new Date().toISOString();
          break;
        case "array":
          info.type = "array";
          info.example = "[]";
          break;
        case "enum": {
          info.type = "enum";
          const firstArg = rootCall.arguments[0];
          if (firstArg?.type === "ArrayExpression") {
            const vals = (firstArg as TSESTree.ArrayExpression).elements
              .map((el) => (el ? extractStringValue(el as TSESTree.Node) : null))
              .filter((v): v is string => v !== null);
            info.validators.push(`enum:${vals.join(",")}`);
            if (vals[0]) info.example = vals[0];
          }
          break;
        }
        case "literal": {
          info.type = "literal";
          const val = rootCall.arguments[0];
          if (val) {
            const strVal = extractStringValue(val as TSESTree.Node);
            if (strVal !== null) {
              info.validators.push(`literal:${strVal}`);
              info.example = strVal;
            }
          }
          break;
        }
        case "object":
          info.type = "object";
          break;
        case "union":
          info.type = "union";
          break;
        case "record":
          info.type = "object";
          info.validators.push("additionalProperties:string");
          break;
        case "any":
          info.type = "any";
          break;
        case "unknown":
          info.type = "unknown";
          break;
        case "null":
          info.type = "null";
          break;
        case "undefined":
          info.type = "undefined";
          break;
        case "never":
          info.type = "never";
          break;
        default:
          info.type = typeName;
      }
    }
  }

  // Walk method chain for validators and modifiers
  for (const method of methods) {
    switch (method) {
      case "optional":
        info.required = false;
        break;
      case "default":
        info.required = false;
        break;
      case "nullable":
        info.validators.push("nullable");
        break;
      case "email":
        info.validators.push("email");
        info.example = "smoketest@example.com";
        break;
      case "url":
        info.validators.push("url");
        info.example = "https://example.com";
        break;
      case "uuid":
        info.validators.push("uuid");
        info.type = "string";
        info.example = "11111111-2222-3333-4444-555555555555";
        break;
      case "min":
        info.validators.push("min");
        break;
      case "max":
        info.validators.push("max");
        break;
      case "regex":
        info.validators.push("regex");
        break;
      case "int":
        info.validators.push("integer");
        break;
      case "positive":
        info.validators.push("positive");
        break;
      case "nonempty":
        info.validators.push("nonempty");
        break;
      case "trim":
        info.validators.push("trim");
        break;
      case "toLowerCase":
        info.validators.push("toLowerCase");
        break;
      case "toUpperCase":
        info.validators.push("toUpperCase");
        break;
    }
  }

  void zodAliases; // used by caller context
  return info;
}

// ─── Extract fields from z.object({...}) ─────────────────────────────────────

function extractObjectFields(
  objectArg: TSESTree.ObjectExpression,
  zodAliases: Set<string>
): BodyField[] {
  const fields: BodyField[] = [];
  for (const prop of objectArg.properties) {
    if (prop.type !== "Property") continue;
    const p = prop as TSESTree.Property;
    const keyNode = p.key;
    let fieldName: string | null = null;
    if (keyNode.type === "Identifier") {
      fieldName = keyNode.name;
    } else if (keyNode.type === "Literal") {
      fieldName = String(keyNode.value);
    }
    if (!fieldName) continue;

    const valueNode = p.value as TSESTree.Node;
    if (!isZodCall(valueNode, zodAliases)) continue;

    const info = extractZodFieldInfo(valueNode, zodAliases);
    fields.push({
      name: fieldName,
      type: info.type,
      required: info.required,
      validators: info.validators,
      example: info.example,
    });
  }
  return fields;
}

// ─── Public: extractInlineZodSchema ──────────────────────────────────────────

export function extractInlineZodSchema(
  node: TSESTree.CallExpression,
  zodAliases: Set<string> = new Set(["z"])
): RequestBodySchema | null {
  const callee = node.callee;
  if (callee.type !== "MemberExpression") return null;
  if (callee.property.type !== "Identifier") return null;
  if (callee.property.name !== "object") return null;
  const obj = node.callee as TSESTree.MemberExpression;
  if (obj.object.type !== "Identifier" || !zodAliases.has(obj.object.name)) {
    return null;
  }
  const firstArg = node.arguments[0];
  if (!firstArg || firstArg.type !== "ObjectExpression") return null;
  const fields = extractObjectFields(
    firstArg as TSESTree.ObjectExpression,
    zodAliases
  );
  return { source: "zod", fields, rawSchemaRef: null };
}

// ─── Public: extractZodSchemas ────────────────────────────────────────────────

export function extractZodSchemas(
  files: ParsedFile[]
): Map<string, RequestBodySchema> {
  const registry = new Map<string, RequestBodySchema>();

  // Also record chained declarations for post-processing
  interface ChainedEntry {
    baseName: string;
    transformer: string;
    pickKeys?: string[];
    omitKeys?: string[];
    extendFields?: BodyField[];
  }
  const chainedEntries = new Map<string, ChainedEntry>();

  for (const file of files) {
    const zodAliases = collectZodAliases(file);

    walk(file.ast, (node) => {
      if (node.type !== "VariableDeclaration") return;
      const decl = node as TSESTree.VariableDeclaration;
      for (const declarator of decl.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        const varName = declarator.id.name;
        if (!declarator.init) continue;
        const init = declarator.init as TSESTree.Node;

        if (!isZodCall(init, zodAliases)) continue;

        // Check if this is z.object() at root
        const rootCall = getRootCall(init);
        if (!rootCall) continue;

        const methods = collectMethodChain(init);
        const calleeRoot = rootCall.callee;

        // Determine whether root is z.object(...)
        const isDirectObject =
          calleeRoot.type === "MemberExpression" &&
          calleeRoot.property.type === "Identifier" &&
          calleeRoot.property.name === "object" &&
          calleeRoot.object.type === "Identifier" &&
          zodAliases.has((calleeRoot.object as TSESTree.Identifier).name);

        if (isDirectObject) {
          const firstArg = rootCall.arguments[0];
          if (firstArg?.type === "ObjectExpression") {
            const fields = extractObjectFields(
              firstArg as TSESTree.ObjectExpression,
              zodAliases
            );
            // Apply any chained transformers in the outer chain
            let resultFields = fields;
            let isPartial = false;

            for (const method of methods) {
              if (method === "partial") isPartial = true;
            }
            if (isPartial) {
              resultFields = resultFields.map((f) => ({
                ...f,
                required: false,
              }));
            }
            registry.set(varName, {
              source: "zod",
              fields: resultFields,
              rawSchemaRef: null,
            });
          }
        } else {
          // Chained from another schema — record for second pass
          // Find the base variable name: outermost identifier in chain
          let baseCur: TSESTree.Node = init;
          while (baseCur.type === "CallExpression") {
            const cCallee = (baseCur as TSESTree.CallExpression).callee;
            if (cCallee.type === "MemberExpression") {
              baseCur = cCallee.object;
            } else {
              break;
            }
          }
          if (baseCur.type !== "Identifier") continue;
          const baseName = (baseCur as TSESTree.Identifier).name;

          // Determine outermost transformation
          const outerMethod = methods[0]; // first in chain = last applied
          if (!outerMethod) continue;

          const entry: ChainedEntry = {
            baseName,
            transformer: outerMethod,
          };

          if (outerMethod === "pick" || outerMethod === "omit") {
            const outerCall = init as TSESTree.CallExpression;
            const outerArg = outerCall.arguments[0];
            if (
              outerArg?.type === "ObjectExpression"
            ) {
              const keys = (outerArg as TSESTree.ObjectExpression).properties
                .filter((p) => p.type === "Property")
                .map((p) => {
                  const prop = p as TSESTree.Property;
                  if (prop.key.type === "Identifier") return prop.key.name;
                  return null;
                })
                .filter((k): k is string => k !== null);
              if (outerMethod === "pick") entry.pickKeys = keys;
              else entry.omitKeys = keys;
            }
          } else if (outerMethod === "extend") {
            const outerCall = init as TSESTree.CallExpression;
            const outerArg = outerCall.arguments[0];
            if (outerArg?.type === "ObjectExpression") {
              entry.extendFields = extractObjectFields(
                outerArg as TSESTree.ObjectExpression,
                zodAliases
              );
            }
          }

          chainedEntries.set(varName, entry);
        }
      }
    });
  }

  // Second pass: resolve chained schemas (max 3 levels deep)
  for (let pass = 0; pass < 3; pass++) {
    for (const [varName, entry] of chainedEntries) {
      if (registry.has(varName)) continue;
      const base = registry.get(entry.baseName);
      if (!base) continue;

      let fields = base.fields.map((f) => ({ ...f }));

      switch (entry.transformer) {
        case "partial":
          fields = fields.map((f) => ({ ...f, required: false }));
          break;
        case "pick":
          if (entry.pickKeys) {
            const keys = new Set(entry.pickKeys);
            fields = fields.filter((f) => keys.has(f.name));
          }
          break;
        case "omit":
          if (entry.omitKeys) {
            const keys = new Set(entry.omitKeys);
            fields = fields.filter((f) => !keys.has(f.name));
          }
          break;
        case "extend":
          if (entry.extendFields) fields = [...fields, ...entry.extendFields];
          break;
      }

      registry.set(varName, { source: "zod", fields, rawSchemaRef: null });
    }
  }

  return registry;
}

// ─── Public: resolveZodSchema ─────────────────────────────────────────────────

export function resolveZodSchema(
  schemaName: string,
  schemaRegistry: Map<string, RequestBodySchema>
): RequestBodySchema | null {
  return schemaRegistry.get(schemaName) ?? null;
}
