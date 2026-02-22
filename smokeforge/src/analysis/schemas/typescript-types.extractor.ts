import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import { walk, extractStringValue } from "../../utils/ast-utils";
import type { BodyField, RequestBodySchema } from "../../blueprint/types";

// ─── Type annotation → BodyField type string ─────────────────────────────────

function tsTypeToString(typeNode: TSESTree.TypeNode): string {
  switch (typeNode.type) {
    case "TSStringKeyword":
      return "string";
    case "TSNumberKeyword":
      return "number";
    case "TSBooleanKeyword":
      return "boolean";
    case "TSAnyKeyword":
      return "any";
    case "TSUnknownKeyword":
      return "unknown";
    case "TSNullKeyword":
      return "null";
    case "TSUndefinedKeyword":
      return "undefined";
    case "TSNeverKeyword":
      return "never";
    case "TSVoidKeyword":
      return "void";
    case "TSObjectKeyword":
      return "object";
    case "TSTypeReference": {
      const ref = typeNode as TSESTree.TSTypeReference;
      if (ref.typeName.type === "Identifier") {
        const name = ref.typeName.name;
        if (name === "Date") return "string"; // Date → string (format: date-time)
        if (name === "Record") return "object";
        if (name === "Array") return "array";
        return name;
      }
      return "object";
    }
    case "TSArrayType":
      return "array";
    case "TSUnionType": {
      const union = typeNode as TSESTree.TSUnionType;
      // Check for string literal union → enum
      const allLiterals = union.types.every(
        (t) =>
          t.type === "TSLiteralType" &&
          (t as TSESTree.TSLiteralType).literal.type === "Literal"
      );
      if (allLiterals) return "enum";
      // T | undefined → treat as the non-undefined type
      const nonUndefined = union.types.filter(
        (t) => t.type !== "TSUndefinedKeyword" && t.type !== "TSNullKeyword"
      );
      if (nonUndefined.length === 1) return tsTypeToString(nonUndefined[0] as TSESTree.TypeNode);
      return "union";
    }
    case "TSLiteralType": {
      const lit = typeNode as TSESTree.TSLiteralType;
      if (lit.literal.type === "Literal") return "literal";
      return "unknown";
    }
    case "TSTypeLiteral":
      return "object";
    case "TSTupleType":
      return "array";
    case "TSIntersectionType":
      return "object";
    default:
      return "unknown";
  }
}

function getValidatorsFromTsType(typeNode: TSESTree.TypeNode): string[] {
  const validators: string[] = [];
  if (typeNode.type === "TSTypeReference") {
    const ref = typeNode as TSESTree.TSTypeReference;
    if (ref.typeName.type === "Identifier" && ref.typeName.name === "Date") {
      validators.push("format:date-time");
    }
  }
  return validators;
}

function isOptional(typeNode?: TSESTree.TypeNode): boolean {
  if (!typeNode) return false;
  if (typeNode.type === "TSUnionType") {
    const union = typeNode as TSESTree.TSUnionType;
    return union.types.some((t) => t.type === "TSUndefinedKeyword");
  }
  return false;
}

function getEnumValues(typeNode: TSESTree.TypeNode): string[] {
  const values: string[] = [];
  if (typeNode.type === "TSUnionType") {
    const union = typeNode as TSESTree.TSUnionType;
    for (const t of union.types) {
      if (t.type === "TSLiteralType") {
        const lit = (t as TSESTree.TSLiteralType).literal;
        if (lit.type === "Literal") {
          const raw = extractStringValue(lit);
          if (raw !== null) values.push(raw);
          else if (typeof lit.value === "number") values.push(String(lit.value));
        }
      }
    }
  }
  return values;
}

// ─── Extract fields from TSPropertySignature list ────────────────────────────

function extractFieldsFromTypeMembers(
  members: TSESTree.TypeElement[]
): BodyField[] {
  const fields: BodyField[] = [];
  for (const member of members) {
    if (member.type !== "TSPropertySignature") continue;
    const prop = member as TSESTree.TSPropertySignature;
    const keyNode = prop.key;
    let fieldName: string | null = null;
    if (keyNode.type === "Identifier") fieldName = keyNode.name;
    else if (keyNode.type === "Literal") fieldName = String(keyNode.value);
    if (!fieldName) continue;

    const typeAnnotation = prop.typeAnnotation?.typeAnnotation;
    let typeStr = "unknown";
    let required = prop.optional !== true;
    const validators: string[] = [];

    if (typeAnnotation) {
      typeStr = tsTypeToString(typeAnnotation);
      if (isOptional(typeAnnotation)) required = false;
      validators.push(...getValidatorsFromTsType(typeAnnotation));

      if (typeStr === "enum") {
        const vals = getEnumValues(typeAnnotation);
        if (vals.length > 0) validators.push(`enum:${vals.join(",")}`);
      }
    }

    fields.push({
      name: fieldName,
      type: typeStr,
      required,
      validators,
      example: null,
    });
  }
  return fields;
}

// ─── Public: extractTypeScriptTypes ──────────────────────────────────────────

export function extractTypeScriptTypes(
  files: ParsedFile[]
): Map<string, RequestBodySchema> {
  const registry = new Map<string, RequestBodySchema>();

  for (const file of files) {
    walk(file.ast, (node) => {
      // Interface declarations
      if (node.type === "TSInterfaceDeclaration") {
        const iface = node as TSESTree.TSInterfaceDeclaration;
        const name = iface.id.name;
        const fields = extractFieldsFromTypeMembers(iface.body.body);
        registry.set(name, { source: "typescript", fields, rawSchemaRef: null });
        return;
      }

      // Type alias declarations: type Foo = { ... }
      if (node.type === "TSTypeAliasDeclaration") {
        const alias = node as TSESTree.TSTypeAliasDeclaration;
        const name = alias.id.name;
        const typeAnnotation = alias.typeAnnotation;

        if (typeAnnotation.type === "TSTypeLiteral") {
          const lit = typeAnnotation as TSESTree.TSTypeLiteral;
          const fields = extractFieldsFromTypeMembers(lit.members);
          registry.set(name, {
            source: "typescript",
            fields,
            rawSchemaRef: null,
          });
        }
      }
    });
  }

  return registry;
}

// ─── Public: extractDestructuredBodyFields ────────────────────────────────────

/**
 * Given a function node, scan for:
 *   const { a, b } = req.body
 *   const { a, b } = await request.json()
 * Returns fields with type "unknown" and low confidence.
 */
export function extractDestructuredBodyFields(
  functionNode: TSESTree.Node
): BodyField[] {
  const fields: BodyField[] = [];
  const seen = new Set<string>();

  walk(functionNode, (node) => {
    if (node.type !== "VariableDeclaration") return;
    const decl = node as TSESTree.VariableDeclaration;
    for (const declarator of decl.declarations) {
      if (declarator.id.type !== "ObjectPattern") continue;
      const init = declarator.init;
      if (!init) continue;

      // Match req.body or request.body
      const isBodyAccess =
        (init.type === "MemberExpression" &&
          init.property.type === "Identifier" &&
          init.property.name === "body") ||
        // await request.json() or await c.req.json() etc.
        (init.type === "AwaitExpression" &&
          init.argument.type === "CallExpression" &&
          (init.argument as TSESTree.CallExpression).callee.type ===
            "MemberExpression" &&
          (
            (init.argument as TSESTree.CallExpression)
              .callee as TSESTree.MemberExpression
          ).property.type === "Identifier" &&
          (
            (
              (init.argument as TSESTree.CallExpression)
                .callee as TSESTree.MemberExpression
            ).property as TSESTree.Identifier
          ).name === "json");

      if (!isBodyAccess) continue;

      const pattern = declarator.id as TSESTree.ObjectPattern;
      for (const prop of pattern.properties) {
        if (prop.type !== "Property") continue;
        const p = prop as TSESTree.Property;
        const key = p.key;
        let fieldName: string | null = null;
        if (key.type === "Identifier") fieldName = key.name;
        else if (key.type === "Literal") fieldName = String(key.value);
        if (!fieldName || seen.has(fieldName)) continue;
        seen.add(fieldName);
        fields.push({
          name: fieldName,
          type: "unknown",
          required: true,
          validators: [],
          example: null,
        });
      }
    }
  });

  return fields;
}
