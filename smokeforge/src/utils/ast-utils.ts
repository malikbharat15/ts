// src/utils/ast-utils.ts
// These helpers are used by EVERY extractor. Implement them once here.

import { TSESTree } from "@typescript-eslint/typescript-estree";

/** Walk every node in the AST, calling visitor for each. */
export function walk(
  node: TSESTree.Node,
  visitor: (node: TSESTree.Node, parent: TSESTree.Node | null) => void,
  parent: TSESTree.Node | null = null
): void {
  visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      child.forEach((c) => {
        if (c && typeof c === "object" && "type" in c)
          walk(c as TSESTree.Node, visitor, node);
      });
    } else if (child && typeof child === "object" && "type" in child) {
      walk(child as TSESTree.Node, visitor, node);
    }
  }
}

/** Extract string literal value from a node (handles Literal + TemplateLiteral). */
export function extractStringValue(node: TSESTree.Node): string | null {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  // Handle simple string concatenation: "/users" + "/" + id → "/users/"
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = extractStringValue(node.left);
    const right = extractStringValue(node.right);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}

/** Get all decorators on a class member or class declaration. */
export function getDecorators(node: TSESTree.Node): TSESTree.Decorator[] {
  // In typescript-estree v6+, decorators are on the node directly
  return (node as { decorators?: TSESTree.Decorator[] }).decorators ?? [];
}

/** Check if identifier resolves to a specific import. */
export function isImportedFrom(
  identifierName: string,
  moduleName: string,
  importDeclarations: TSESTree.ImportDeclaration[]
): boolean {
  return importDeclarations.some(
    (decl) =>
      decl.source.value === moduleName &&
      decl.specifiers.some(
        (s) => s.local.name === identifierName
      )
  );
}

/** Collect all import declarations from a file's AST. */
export function collectImports(program: TSESTree.Program): TSESTree.ImportDeclaration[] {
  return program.body.filter(
    (node): node is TSESTree.ImportDeclaration => node.type === "ImportDeclaration"
  );
}

/** Resolve require() calls to module paths. */
export function extractRequirePath(node: TSESTree.CallExpression): string | null {
  if (
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments.length === 1
  ) {
    return extractStringValue(node.arguments[0]);
  }
  return null;
}
