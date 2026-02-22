import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import { walk } from "../../utils/ast-utils";
import type { BodyField, RequestBodySchema } from "../../blueprint/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Get decorator name string from a Decorator node. */
function getDecoratorName(decorator: TSESTree.Decorator): string | null {
  const expr = decorator.expression;
  if (expr.type === "Identifier") {
    return (expr as TSESTree.Identifier).name;
  }
  if (expr.type === "CallExpression") {
    const callee = (expr as TSESTree.CallExpression).callee;
    if (callee.type === "Identifier") return (callee as TSESTree.Identifier).name;
    if (callee.type === "MemberExpression") {
      const prop = callee.property;
      if (prop.type === "Identifier") return (prop as TSESTree.Identifier).name;
    }
  }
  return null;
}

/** Get the first argument (as a Node) of a decorator call, if any. */
function getDecoratorArg(
  decorator: TSESTree.Decorator,
  index: number
): TSESTree.Node | null {
  const expr = decorator.expression;
  if (expr.type !== "CallExpression") return null;
  const args = (expr as TSESTree.CallExpression).arguments;
  return args.length > index ? (args[index] as TSESTree.Node) : null;
}

/** Read a numeric literal from a node. */
function numLit(node: TSESTree.Node | null): number | null {
  if (!node) return null;
  if (node.type === "Literal") {
    const v = (node as TSESTree.Literal).value;
    if (typeof v === "number") return v;
  }
  return null;
}

/** Get a string property value from an ObjectExpression. */
function getObjProp(
  obj: TSESTree.ObjectExpression,
  propName: string
): string | null {
  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    const key = prop.key;
    const keyName =
      key.type === "Identifier"
        ? (key as TSESTree.Identifier).name
        : key.type === "Literal"
          ? String((key as TSESTree.Literal).value)
          : null;
    if (keyName !== propName) continue;
    const val = prop.value as TSESTree.Node;
    if (val.type === "Literal") return String((val as TSESTree.Literal).value);
    if (val.type === "Identifier") return (val as TSESTree.Identifier).name;
  }
  return null;
}

/** Get a boolean property value from an ObjectExpression. */
function getObjPropBool(
  obj: TSESTree.ObjectExpression,
  propName: string
): boolean | null {
  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    const key = prop.key;
    const keyName =
      key.type === "Identifier"
        ? (key as TSESTree.Identifier).name
        : null;
    if (keyName !== propName) continue;
    const val = prop.value as TSESTree.Node;
    if (val.type === "Literal") {
      const v = (val as TSESTree.Literal).value;
      if (typeof v === "boolean") return v;
    }
  }
  return null;
}

/** TypeScript type annotation → BodyField type string. */
function tsAnnotationToType(annotation: TSESTree.TSTypeAnnotation | undefined): {
  type: string;
  isArray: boolean;
} {
  if (!annotation) return { type: "unknown", isArray: false };

  const typeNode = annotation.typeAnnotation;

  if (typeNode.type === "TSStringKeyword") return { type: "string", isArray: false };
  if (typeNode.type === "TSNumberKeyword") return { type: "number", isArray: false };
  if (typeNode.type === "TSBooleanKeyword") return { type: "boolean", isArray: false };
  if (typeNode.type === "TSAnyKeyword") return { type: "any", isArray: false };
  if (typeNode.type === "TSObjectKeyword") return { type: "object", isArray: false };

  // string[] or number[]
  if (typeNode.type === "TSArrayType") {
    const inner = typeNode.elementType;
    if (inner.type === "TSStringKeyword") return { type: "array", isArray: true };
    if (inner.type === "TSNumberKeyword") return { type: "array", isArray: true };
    return { type: "array", isArray: true };
  }

  // Array<string>
  if (typeNode.type === "TSTypeReference") {
    const name = typeNode.typeName;
    if (name.type === "Identifier") {
      const n = (name as TSESTree.Identifier).name;
      if (n === "Array") return { type: "array", isArray: true };
      if (n === "Date") return { type: "string", isArray: false };
      // Could be an enum or DTO reference
      return { type: n, isArray: false };
    }
  }

  return { type: "unknown", isArray: false };
}

// ─── Decorator-to-field logic ─────────────────────────────────────────────────

interface FieldInfo {
  decoratorType: string | null;
  validators: string[];
  required: boolean;             // default true for class-validator
  example: string | null;
  tsType: string;
  isArray: boolean;
}

function analyzePropertyDecorators(
  decorators: TSESTree.Decorator[],
  tsAnnotation: TSESTree.TSTypeAnnotation | undefined
): FieldInfo {
  const info: FieldInfo = {
    decoratorType: null,
    validators: [],
    required: true,              // NestJS/class-validator default is required
    example: null,
    tsType: "unknown",
    isArray: false,
  };

  // Start from TypeScript type annotation (fallback)
  const tsInfo = tsAnnotationToType(tsAnnotation);
  info.tsType = tsInfo.type;
  info.isArray = tsInfo.isArray;

  for (const decorator of decorators) {
    const name = getDecoratorName(decorator);
    if (!name) continue;

    switch (name) {
      // ── Type decorators ──────────────────────────────────────────────────
      case "IsString":
        if (!info.isArray) info.decoratorType = "string";
        break;
      case "IsNumber":
        if (!info.isArray) info.decoratorType = "number";
        break;
      case "IsBoolean":
        if (!info.isArray) info.decoratorType = "boolean";
        break;
      case "IsDate":
        info.decoratorType = "string";
        break;
      case "IsEmail":
        info.decoratorType = "string";
        info.validators.push("email");
        break;
      case "IsUrl":
        info.decoratorType = "string";
        info.validators.push("url");
        break;
      case "IsUUID": {
        info.decoratorType = "string";
        info.validators.push("uuid");
        break;
      }
      case "IsEnum": {
        info.decoratorType = "enum";
        break;
      }
      case "IsArray":
        info.isArray = true;
        if (!info.decoratorType) info.decoratorType = "array";
        break;
      case "IsObject":
        info.decoratorType = "object";
        break;
      case "IsInt":
        info.decoratorType = "number";
        info.validators.push("integer");
        break;

      // ── Validators ───────────────────────────────────────────────────────
      case "IsPositive":
        info.validators.push("positive");
        break;
      case "IsNegative":
        info.validators.push("negative");
        break;
      case "IsNotEmpty":
        info.validators.push("notEmpty");
        break;
      case "Min": {
        const arg = getDecoratorArg(decorator, 0);
        const n = numLit(arg);
        info.validators.push(`min(${n ?? "n"})`);
        break;
      }
      case "Max": {
        const arg = getDecoratorArg(decorator, 0);
        const n = numLit(arg);
        info.validators.push(`max(${n ?? "n"})`);
        break;
      }
      case "MinLength": {
        const arg = getDecoratorArg(decorator, 0);
        const n = numLit(arg);
        info.validators.push(`minLength(${n ?? "n"})`);
        break;
      }
      case "MaxLength": {
        const arg = getDecoratorArg(decorator, 0);
        const n = numLit(arg);
        info.validators.push(`maxLength(${n ?? "n"})`);
        break;
      }
      case "Length": {
        const arg0 = getDecoratorArg(decorator, 0);
        const arg1 = getDecoratorArg(decorator, 1);
        const mn = numLit(arg0);
        const mx = numLit(arg1);
        if (mn !== null) info.validators.push(`minLength(${mn})`);
        if (mx !== null) info.validators.push(`maxLength(${mx})`);
        break;
      }
      case "Matches":
        info.validators.push("regex");
        break;
      case "IsIn": {
        info.validators.push("isIn");
        break;
      }
      case "IsNotIn":
        info.validators.push("isNotIn");
        break;

      // ── Required/Optional ────────────────────────────────────────────────
      case "IsOptional":
        info.required = false;
        break;

      // ── Swagger / NestJS ApiProperty ─────────────────────────────────────
      case "ApiProperty": {
        const arg = getDecoratorArg(decorator, 0);
        if (arg && arg.type === "ObjectExpression") {
          const obj = arg as TSESTree.ObjectExpression;
          const exampleVal = getObjProp(obj, "example");
          if (exampleVal !== null) info.example = exampleVal;
          const reqOverride = getObjPropBool(obj, "required");
          if (reqOverride === false) info.required = false;
          if (reqOverride === true) info.required = true;
        }
        break;
      }

      // ── ValidateNested ───────────────────────────────────────────────────
      case "ValidateNested":
        info.decoratorType = "object";
        info.validators.push("nested");
        break;
    }
  }

  // Resolve final type: decorator type wins over TS annotation
  if (!info.decoratorType) {
    info.decoratorType = info.isArray ? "array" : info.tsType;
  }

  return info;
}

// ─── Enum resolver ────────────────────────────────────────────────────────────

/**
 * Build a map of enum name → string values from the file's AST.
 * Used to resolve @IsEnum(SomeEnum) → ['admin', 'user'].
 */
function buildEnumMap(ast: TSESTree.Program): Map<string, string[]> {
  const enumMap = new Map<string, string[]>();

  walk(ast, (node) => {
    if (node.type !== "TSEnumDeclaration") return;
    const enumDecl = node as TSESTree.TSEnumDeclaration;
    const enumName = enumDecl.id.name;
    const values: string[] = [];
    for (const member of enumDecl.members) {
      if (member.initializer && member.initializer.type === "Literal") {
        const v = (member.initializer as TSESTree.Literal).value;
        if (v !== null && v !== undefined) values.push(String(v));
      } else if (member.id.type === "Identifier") {
        values.push((member.id as TSESTree.Identifier).name);
      }
    }
    enumMap.set(enumName, values);
  });

  return enumMap;
}

// ─── Main extractor ───────────────────────────────────────────────────────────

/**
 * Scan all parsed files for class-validator DTO class declarations.
 * Returns a map of className → RequestBodySchema.
 */
export function extractClassValidatorSchemas(
  files: ParsedFile[]
): Map<string, RequestBodySchema> {
  const registry = new Map<string, RequestBodySchema>();

  for (const file of files) {
    if (!file.ast) continue;

    // Only process files that are likely DTOs or have class-validator imports
    let hasClassValidator = false;

    walk(file.ast, (node) => {
      if (node.type === "ImportDeclaration") {
        const imp = node as TSESTree.ImportDeclaration;
        const src = imp.source.value;
        if (
          typeof src === "string" &&
          (src === "class-validator" || src === "class-transformer")
        ) {
          hasClassValidator = true;
        }
      }
    });

    if (!hasClassValidator) continue;

    const enumMap = buildEnumMap(file.ast);

    walk(file.ast, (node) => {
      if (node.type !== "ClassDeclaration") return;

      const classDecl = node as TSESTree.ClassDeclaration;
      if (!classDecl.id) return;

      const className = classDecl.id.name;
      // Only process classes ending in Dto, DTO, Request, Input, Body (NestJS convention)
      // but also process any class that has property decorators
      const fields: BodyField[] = [];

      for (const member of classDecl.body.body) {
        if (member.type !== "PropertyDefinition") continue;

        const propDef = member as TSESTree.PropertyDefinition;
        if (!propDef.decorators || propDef.decorators.length === 0) continue;

        const key = propDef.key;
        const propName =
          key.type === "Identifier"
            ? (key as TSESTree.Identifier).name
            : key.type === "Literal"
              ? String((key as TSESTree.Literal).value)
              : null;
        if (!propName) continue;

        // Check if this property has ? (optional shorthand)
        const hasQuestionToken = propDef.optional === true;

        const info = analyzePropertyDecorators(
          propDef.decorators,
          propDef.typeAnnotation ?? undefined
        );

        // ? suffix overrides @IsOptional()
        if (hasQuestionToken) info.required = false;

        // Resolve enum values if @IsEnum() was found
        let finalType = info.decoratorType ?? "unknown";
        if (finalType === "enum") {
          // Try to find the enum arg to resolve values
          let resolvedValues: string[] | null = null;
          for (const dec of propDef.decorators) {
            if (getDecoratorName(dec) !== "IsEnum") continue;
            const arg = getDecoratorArg(dec, 0);
            if (arg && arg.type === "Identifier") {
              const enumName = (arg as TSESTree.Identifier).name;
              const vals = enumMap.get(enumName);
              if (vals) {
                resolvedValues = vals;
              }
            }
          }
          if (resolvedValues && resolvedValues.length > 0) {
            finalType = resolvedValues.join("|");
          }
        }

        fields.push({
          name: propName,
          type: finalType,
          required: info.required,
          validators: info.validators,
          example: info.example,
        });
      }

      if (fields.length > 0) {
        registry.set(className, {
          source: "class-validator",
          fields,
          rawSchemaRef: className,
        });
      }
    });
  }

  return registry;
}

/**
 * Resolve a DTO class name from the registry (compatibility shim).
 */
export function resolveClassValidatorSchema(
  schemaName: string,
  registry: Map<string, RequestBodySchema>
): RequestBodySchema | null {
  return registry.get(schemaName) ?? null;
}
