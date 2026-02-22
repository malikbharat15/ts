import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import { walk, extractStringValue } from "../../utils/ast-utils";
import type { BodyField, RequestBodySchema } from "../../blueprint/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collect the chain of method names from a CallExpression (innermost first). */
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

/** Determine if a node is rooted at a Joi.*() call. */
function isJoiCall(node: TSESTree.Node, joiAliases: Set<string>): boolean {
  let cur: TSESTree.Node = node;
  while (cur.type === "CallExpression") {
    const callee = (cur as TSESTree.CallExpression).callee;
    if (callee.type === "MemberExpression") {
      const obj = callee.object;
      if (obj.type === "Identifier" && joiAliases.has(obj.name)) return true;
      cur = obj;
    } else {
      break;
    }
  }
  return false;
}

/** Get the outermost type method name from a Joi chain (e.g. Joi.string()… → "string"). */
function getJoiRootType(node: TSESTree.Node, joiAliases: Set<string>): string | null {
  let cur: TSESTree.Node = node;
  while (cur.type === "CallExpression") {
    const callee = (cur as TSESTree.CallExpression).callee;
    if (callee.type === "MemberExpression") {
      const obj = callee.object;
      if (obj.type === "Identifier" && joiAliases.has(obj.name)) {
        const prop = callee.property;
        return prop.type === "Identifier" ? prop.name : null;
      }
      cur = obj;
    } else {
      break;
    }
  }
  return null;
}

/** Map a Joi root type name to a BodyField type string. */
function joiTypeToFieldType(joiType: string): string {
  switch (joiType) {
    case "string":  return "string";
    case "number":  return "number";
    case "boolean": return "boolean";
    case "date":    return "string";     // date represented as string
    case "array":   return "array";
    case "object":  return "object";
    case "binary":  return "binary";
    case "any":
    default:        return "any";
  }
}

/** Get argument call expressions for a given method name in a chain. */
function findMethodArgs(
  node: TSESTree.Node,
  methodName: string
): TSESTree.Node[] {
  let cur: TSESTree.Node = node;
  while (cur.type === "CallExpression") {
    const callee = (cur as TSESTree.CallExpression).callee;
    if (
      callee.type === "MemberExpression" &&
      callee.property.type === "Identifier" &&
      callee.property.name === methodName
    ) {
      return (cur as TSESTree.CallExpression).arguments as TSESTree.Node[];
    }
    if (callee.type === "MemberExpression") {
      cur = callee.object;
    } else {
      break;
    }
  }
  return [];
}

/** Extract validators list from a Joi field call-chain. */
function extractValidators(node: TSESTree.Node): string[] {
  const methods = collectMethodChain(node);
  const validators: string[] = [];

  for (const m of methods) {
    switch (m) {
      case "email":    validators.push("email"); break;
      case "uri":      validators.push("url"); break;
      case "guid":
      case "uuid":     validators.push("uuid"); break;
      case "integer":  validators.push("integer"); break;
      case "positive": validators.push("positive"); break;
      case "pattern": {
        validators.push("regex");
        break;
      }
      case "min": {
        const args = findMethodArgs(node, "min");
        const val = args[0] && args[0].type === "Literal"
          ? String((args[0] as TSESTree.Literal).value)
          : "n";
        validators.push(`min(${val})`);
        break;
      }
      case "max": {
        const args = findMethodArgs(node, "max");
        const val = args[0] && args[0].type === "Literal"
          ? String((args[0] as TSESTree.Literal).value)
          : "n";
        validators.push(`max(${val})`);
        break;
      }
      case "alphanum":   validators.push("alphanum"); break;
      case "trim":       validators.push("trim"); break;
      case "lowercase":  validators.push("lowercase"); break;
      case "uppercase":  validators.push("uppercase"); break;
      case "hostname":   validators.push("hostname"); break;
      case "ip":         validators.push("ip"); break;
    }
  }
  return validators;
}

/** Determine required state from the method chain. */
function extractRequired(node: TSESTree.Node): boolean {
  const methods = collectMethodChain(node);
  // explicit .optional() → false; explicit .required() → true; default is false in Joi
  if (methods.includes("required")) return true;
  if (methods.includes("optional")) return false;
  return false; // Joi keys are optional by default
}

/** Extract example value from a .default() call in the chain. */
function extractExampleFromDefault(node: TSESTree.Node): string | null {
  const args = findMethodArgs(node, "default");
  if (args.length === 0) return null;
  const val = extractStringValue(args[0] as TSESTree.Expression);
  if (val !== null) return val;
  const lit = args[0];
  if (lit.type === "Literal") return String((lit as TSESTree.Literal).value);
  return null;
}

// ─── Core field extractor ────────────────────────────────────────────────────

/**
 * Given a `Joi.object({ ... })` CallExpression, extract its fields as BodyField[].
 */
function extractJoiObjectFields(
  objectCall: TSESTree.CallExpression,
  joiAliases: Set<string>
): BodyField[] {
  // The first argument to Joi.object() is the shape object literal
  const arg = objectCall.arguments[0];
  if (!arg || arg.type !== "ObjectExpression") return [];

  const fields: BodyField[] = [];

  for (const prop of (arg as TSESTree.ObjectExpression).properties) {
    if (prop.type !== "Property") continue;

    const key = prop.key;
    const name =
      key.type === "Identifier"
        ? (key as TSESTree.Identifier).name
        : key.type === "Literal"
          ? String((key as TSESTree.Literal).value)
          : null;
    if (!name) continue;

    const value = prop.value as TSESTree.Node;
    const rootType = getJoiRootType(value, joiAliases) ?? "any";
    const fieldType = joiTypeToFieldType(rootType);
    const validators = extractValidators(value);
    const required = extractRequired(value);
    const example = extractExampleFromDefault(value);

    // For binary — add FILE_UPLOAD hint in validators
    if (rootType === "binary") validators.push("file_upload");

    fields.push({
      name,
      type: fieldType,
      required,
      validators,
      example,
    });
  }

  return fields;
}

// ─── Main extractor ──────────────────────────────────────────────────────────

/**
 * Scan all parsed files for Joi.object() schema declarations.
 * Returns a map of variableName → RequestBodySchema.
 */
export function extractJoiSchemas(
  files: ParsedFile[]
): Map<string, RequestBodySchema> {
  const registry = new Map<string, RequestBodySchema>();

  for (const file of files) {
    if (!file.ast) continue;

    // Discover the local aliases for Joi (import Joi from 'joi', const J = require('joi'), etc.)
    const joiAliases = new Set<string>(["Joi"]);

    walk(file.ast, (node) => {
      // import Joi from 'joi'  or  import * as Joi from 'joi'
      if (node.type === "ImportDeclaration") {
        const imp = node as TSESTree.ImportDeclaration;
        const src = extractStringValue(imp.source);
        if (src === "joi" || src === "@hapi/joi") {
          for (const spec of imp.specifiers) {
            if (
              spec.type === "ImportDefaultSpecifier" ||
              spec.type === "ImportNamespaceSpecifier"
            ) {
              joiAliases.add(spec.local.name);
            }
          }
        }
        return;
      }

      // const Joi = require('joi')
      if (node.type === "VariableDeclaration") {
        const decl = node as TSESTree.VariableDeclaration;
        for (const declarator of decl.declarations) {
          if (
            declarator.id.type === "Identifier" &&
            declarator.init?.type === "CallExpression"
          ) {
            const call = declarator.init as TSESTree.CallExpression;
            if (
              call.callee.type === "Identifier" &&
              (call.callee as TSESTree.Identifier).name === "require" &&
              call.arguments.length > 0
            ) {
              const src = extractStringValue(
                call.arguments[0] as TSESTree.Expression
              );
              if (src === "joi" || src === "@hapi/joi") {
                joiAliases.add(
                  (declarator.id as TSESTree.Identifier).name
                );
              }
            }
          }
        }
        return;
      }
    });

    // Second pass — extract Joi.object() variable declarations
    walk(file.ast, (node) => {
      if (node.type !== "VariableDeclaration") return;

      const decl = node as TSESTree.VariableDeclaration;
      for (const declarator of decl.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        const varName = (declarator.id as TSESTree.Identifier).name;
        if (!declarator.init) continue;

        const init = declarator.init as TSESTree.Node;
        if (!isJoiCall(init, joiAliases)) continue;

        // Walk the chain to find the innermost Joi.object() call
        const joiObjectCall = findInnerJoiObject(init, joiAliases);
        if (!joiObjectCall) continue;

        const fields = extractJoiObjectFields(joiObjectCall, joiAliases);
        if (fields.length === 0) continue;

        registry.set(varName, {
          source: "joi",
          fields,
          rawSchemaRef: varName,
        });
      }
    });
  }

  return registry;
}

/**
 * Walk a method chain to find the first `Joi.object(...)` call expression.
 */
function findInnerJoiObject(
  node: TSESTree.Node,
  joiAliases: Set<string>
): TSESTree.CallExpression | null {
  let cur: TSESTree.Node = node;
  while (cur.type === "CallExpression") {
    const call = cur as TSESTree.CallExpression;
    const callee = call.callee;
    if (callee.type === "MemberExpression") {
      const obj = callee.object;
      const prop = callee.property;
      // If obj is Joi alias and method is "object"
      if (
        obj.type === "Identifier" &&
        joiAliases.has((obj as TSESTree.Identifier).name) &&
        prop.type === "Identifier" &&
        (prop as TSESTree.Identifier).name === "object"
      ) {
        return call;
      }
      cur = obj;
    } else {
      break;
    }
  }
  return null;
}

/**
 * Resolve a schema name from the registry (compatibility shim with zod pattern).
 */
export function resolveJoiSchema(
  schemaName: string,
  registry: Map<string, RequestBodySchema>
): RequestBodySchema | null {
  return registry.get(schemaName) ?? null;
}
