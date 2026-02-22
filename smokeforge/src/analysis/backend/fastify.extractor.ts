import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { IFrameworkExtractor } from "./index";
import type { ParsedFile } from "../parser";
import type { PackageDetection } from "../../ingestion/detector";
import type {
  ExtractedEndpoint,
  PathParam,
  QueryParam,
  RequestBodySchema,
  BodyField,
  ExtractorFlag,
  AuthType,
} from "../../blueprint/types";
import { walk, extractStringValue, collectImports } from "../../utils/ast-utils";
import { resolveImportPath } from "../../utils/file-utils";
import { extractZodSchemas, extractInlineZodSchema } from "../schemas/zod.extractor";

// ─── Counter ──────────────────────────────────────────────────────────────────

let epCounter = 0;
function nextId(): string {
  return `fastify_ep_${String(++epCounter).padStart(3, "0")}`;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const AUTH_HOOK_RE = /auth|authenticate|verify|protect|jwt|bearer|requireAuth/i;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePath(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .map((p) => p.replace(/^\/+/, "").replace(/\/+$/, ""))
    .join("/");
  return "/" + joined.replace(/\/+/g, "/");
}

function extractPathParams(route: string): PathParam[] {
  const params: PathParam[] = [];
  for (const seg of route.split("/")) {
    // Fastify uses :param style
    if (seg.startsWith(":")) {
      const name = seg.slice(1).replace(/[?*+]$/, "");
      params.push({ name, type: "string", example: `test-${name}` });
    }
    // Fastify also supports wildcard *
  }
  return params;
}

function methodFromString(s: string): ExtractedEndpoint["method"] {
  const up = s.toUpperCase();
  const valid = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"];
  return valid.includes(up) ? (up as ExtractedEndpoint["method"]) : "GET";
}

// ─── JSON Schema → BodyField[] ────────────────────────────────────────────────

function jsonSchemaToBodyFields(node: TSESTree.Node): BodyField[] {
  if (node.type !== "ObjectExpression") return [];
  const fields: BodyField[] = [];

  // Find "properties" key
  let propertiesNode: TSESTree.ObjectExpression | null = null;
  let requiredNode: TSESTree.ArrayExpression | null = null;

  for (const prop of node.properties) {
    if (prop.type !== "Property") continue;
    if (prop.key.type !== "Identifier") continue;
    if (prop.key.name === "properties" && prop.value.type === "ObjectExpression") {
      propertiesNode = prop.value;
    }
    if (prop.key.name === "required" && prop.value.type === "ArrayExpression") {
      requiredNode = prop.value;
    }
  }

  if (!propertiesNode) return fields;

  const requiredFields = new Set<string>();
  if (requiredNode) {
    for (const el of requiredNode.elements) {
      if (!el) continue;
      const v = extractStringValue(el as TSESTree.Node);
      if (v) requiredFields.add(v);
    }
  }

  for (const prop of propertiesNode.properties) {
    if (prop.type !== "Property") continue;
    if (prop.key.type !== "Identifier" && prop.key.type !== "Literal") continue;

    const fieldName =
      prop.key.type === "Identifier"
        ? prop.key.name
        : String((prop.key as TSESTree.Literal).value);

    let fieldType = "string";
    let format: string | null = null;

    if (prop.value.type === "ObjectExpression") {
      for (const innerProp of prop.value.properties) {
        if (innerProp.type !== "Property") continue;
        if (innerProp.key.type !== "Identifier") continue;
        if (innerProp.key.name === "type") {
          const t = extractStringValue(innerProp.value as TSESTree.Node);
          if (t) fieldType = t;
        }
        if (innerProp.key.name === "format") {
          format = extractStringValue(innerProp.value as TSESTree.Node);
        }
      }
    }

    if (format === "email") fieldType = "email";
    else if (format === "uuid") fieldType = "uuid";
    else if (format === "uri") fieldType = "url";

    fields.push({
      name: fieldName,
      type: fieldType,
      required: requiredFields.has(fieldName),
      validators: format ? [format] : [],
      example: null,
    });
  }

  return fields;
}

// ─── JSON Schema → QueryParam[] ───────────────────────────────────────────────

function jsonSchemaToQueryParams(node: TSESTree.Node): QueryParam[] {
  if (node.type !== "ObjectExpression") return [];
  const params: QueryParam[] = [];
  let propertiesNode: TSESTree.ObjectExpression | null = null;
  let requiredNode: TSESTree.ArrayExpression | null = null;

  for (const prop of node.properties) {
    if (prop.type !== "Property" || prop.key.type !== "Identifier") continue;
    if (prop.key.name === "properties" && prop.value.type === "ObjectExpression") {
      propertiesNode = prop.value;
    }
    if (prop.key.name === "required" && prop.value.type === "ArrayExpression") {
      requiredNode = prop.value;
    }
  }

  if (!propertiesNode) return params;

  const requiredSet = new Set<string>();
  if (requiredNode) {
    for (const el of requiredNode.elements) {
      if (!el) continue;
      const v = extractStringValue(el as TSESTree.Node);
      if (v) requiredSet.add(v);
    }
  }

  for (const prop of propertiesNode.properties) {
    if (prop.type !== "Property") continue;
    if (prop.key.type !== "Identifier" && prop.key.type !== "Literal") continue;
    const name =
      prop.key.type === "Identifier"
        ? prop.key.name
        : String((prop.key as TSESTree.Literal).value);
    let qType = "string";
    if (prop.value.type === "ObjectExpression") {
      for (const p of prop.value.properties) {
        if (p.type === "Property" && p.key.type === "Identifier" && p.key.name === "type") {
          const t = extractStringValue(p.value as TSESTree.Node);
          if (t) qType = t;
        }
      }
    }
    params.push({ name, type: qType, required: requiredSet.has(name) });
  }

  return params;
}

// ─── Route options schema extraction ─────────────────────────────────────────

interface RouteSchema {
  requestBody: RequestBodySchema | null;
  queryParams: QueryParam[];
  pathParams: PathParam[];
  hasResponse: boolean;
}

function extractRouteSchema(
  schemaNode: TSESTree.ObjectExpression,
  zodSchemas: Map<string, RequestBodySchema>
): RouteSchema {
  let requestBody: RequestBodySchema | null = null;
  let queryParams: QueryParam[] = [];
  const pathParams: PathParam[] = [];
  let hasResponse = false;

  for (const prop of schemaNode.properties) {
    if (prop.type !== "Property" || prop.key.type !== "Identifier") continue;

    const key = prop.key.name;

    if (key === "body") {
      // JSON Schema object
      if (prop.value.type === "ObjectExpression") {
        const fields = jsonSchemaToBodyFields(prop.value);
        if (fields.length > 0) {
          requestBody = { source: "inferred", fields, rawSchemaRef: null };
        }
      }
      // TypeBox: Type.Object({ ... }) — callee is MemberExpression with "Object"
      if (
        prop.value.type === "CallExpression" &&
        prop.value.callee.type === "MemberExpression" &&
        prop.value.callee.property.type === "Identifier" &&
        prop.value.callee.property.name === "Object"
      ) {
        // Extract TypeBox Type.Object fields — treat like JSON schema
        if (prop.value.arguments.length > 0 && prop.value.arguments[0].type === "ObjectExpression") {
          const fields = extractTypeBoxFields(prop.value.arguments[0] as TSESTree.ObjectExpression);
          if (fields.length > 0) {
            requestBody = { source: "inferred", fields, rawSchemaRef: null };
          }
        }
      }
      // Zod schema ref
      if (prop.value.type === "Identifier") {
        const schemaName = prop.value.name;
        const zod = zodSchemas.get(schemaName);
        if (zod) requestBody = zod;
      }
      // Inline Zod call expression
      if (prop.value.type === "CallExpression") {
        const inlineZod = extractInlineZodSchema(prop.value);
        if (inlineZod) requestBody = inlineZod;
      }
    }

    if (key === "querystring" || key === "query") {
      if (prop.value.type === "ObjectExpression") {
        queryParams = jsonSchemaToQueryParams(prop.value);
      }
    }

    if (key === "response") {
      hasResponse = true;
    }
  }

  return { requestBody, queryParams, pathParams, hasResponse };
}

// ─── TypeBox field extraction ─────────────────────────────────────────────────

function extractTypeBoxFields(obj: TSESTree.ObjectExpression): BodyField[] {
  const fields: BodyField[] = [];

  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    if (prop.key.type !== "Identifier" && prop.key.type !== "Literal") continue;

    const fieldName =
      prop.key.type === "Identifier"
        ? prop.key.name
        : String((prop.key as TSESTree.Literal).value);

    let fieldType = "string";

    if (prop.value.type === "CallExpression") {
      const callee = prop.value.callee;
      if (
        callee.type === "MemberExpression" &&
        callee.property.type === "Identifier"
      ) {
        const typeName = callee.property.name;
        if (typeName === "String") fieldType = "string";
        else if (typeName === "Number" || typeName === "Integer") fieldType = "number";
        else if (typeName === "Boolean") fieldType = "boolean";
        else if (typeName === "Array") fieldType = "array";
        else if (typeName === "Object") fieldType = "object";

        // Check format option: Type.String({ format: 'email' })
        if (prop.value.arguments.length > 0 && prop.value.arguments[0].type === "ObjectExpression") {
          for (const innerProp of (prop.value.arguments[0] as TSESTree.ObjectExpression).properties) {
            if (
              innerProp.type === "Property" &&
              innerProp.key.type === "Identifier" &&
              innerProp.key.name === "format"
            ) {
              const fmt = extractStringValue(innerProp.value as TSESTree.Node);
              if (fmt === "email") fieldType = "email";
              else if (fmt === "uuid") fieldType = "uuid";
            }
          }
        }
      }
    }

    fields.push({
      name: fieldName,
      type: fieldType,
      required: true,
      validators: [],
      example: null,
    });
  }

  return fields;
}

// ─── Variable → ObjectExpression resolution ──────────────────────────────────

/**
 * Scan an AST for `const varName = { ... }` / `let varName = { ... }`
 * and return the initialiser ObjectExpression, or null if not found.
 */
function resolveVarToObject(
  varName: string,
  ast: TSESTree.Program
): TSESTree.ObjectExpression | null {
  let result: TSESTree.ObjectExpression | null = null;
  walk(ast, (node) => {
    if (result) return;
    if (node.type !== "VariableDeclaration") return;
    for (const decl of (node as TSESTree.VariableDeclaration).declarations) {
      if (decl.type !== "VariableDeclarator") continue;
      if (decl.id.type !== "Identifier") continue;
      if ((decl.id as TSESTree.Identifier).name !== varName) continue;
      if (decl.init?.type === "ObjectExpression") {
        result = decl.init as TSESTree.ObjectExpression;
      }
    }
  });
  return result;
}

/**
 * Return true if an options ObjectExpression contains a `preHandler` or
 * `onRequest` hook whose handler name matches the auth regex.
 * Handles both:
 *   { preHandler: authenticateUser }
 *   { onRequest: [authenticateUser] }
 *   { onRequest: [(fastify as any).authenticate] }
 */
function objectHasAuthHook(obj: TSESTree.ObjectExpression): boolean {
  for (const prop of obj.properties) {
    if (prop.type !== "Property" || prop.key.type !== "Identifier") continue;
    const keyName = (prop.key as TSESTree.Identifier).name;
    if (keyName !== "preHandler" && keyName !== "onRequest") continue;

    const val = prop.value;
    // Direct identifier: authenticate
    if (val.type === "Identifier" && AUTH_HOOK_RE.test((val as TSESTree.Identifier).name)) {
      return true;
    }
    // Array of handlers
    if (val.type === "ArrayExpression") {
      for (const el of (val as TSESTree.ArrayExpression).elements) {
        if (!el) continue;
        // Bare identifier: [authenticate]
        if (el.type === "Identifier" && AUTH_HOOK_RE.test((el as TSESTree.Identifier).name)) {
          return true;
        }
        // MemberExpression: fastify.authenticate  OR  (fastify as any).authenticate
        if (el.type === "MemberExpression") {
          const member = el as TSESTree.MemberExpression;
          if (
            member.property.type === "Identifier" &&
            AUTH_HOOK_RE.test((member.property as TSESTree.Identifier).name)
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * After extractZodSchemas(), scan each source file for derived schemas:
 *   const updateFooSchema = createFooSchema.partial()
 *   const patchFooSchema = createFooSchema.pick({...})
 *   const editFooSchema   = createFooSchema.extend({...})
 * and add them into `zodSchemas` by inheriting (and all-optionalising for
 * .partial()) the parent's fields.  This ensures extractBodyFromHandlerFn
 * can resolve schemas that aren't direct `z.object({})` literals.
 */
function enrichWithDerivedSchemas(
  files: ParsedFile[],
  zodSchemas: Map<string, RequestBodySchema>
): void {
  const DERIVE_METHODS = ["partial", "omit", "pick", "extend", "merge", "passthrough", "strict"];
  for (const file of files) {
    const ast = file.ast; // already parsed — no re-parse needed
    for (const stmt of ast.body) {
      // Look for: const X = Y.partial() / Y.partial().partial() etc.
      if (
        stmt.type !== "VariableDeclaration" ||
        (stmt as TSESTree.VariableDeclaration).kind !== "const"
      ) continue;
      for (const decl of (stmt as TSESTree.VariableDeclaration).declarations) {
        if (!decl.id || decl.id.type !== "Identifier") continue;
        const name = (decl.id as TSESTree.Identifier).name;
        if (!decl.init) continue;
        if (zodSchemas.has(name)) continue; // already known

        // Unwrap chain: e.g. createFooSchema.partial().omit({...})
        // We just need the root identifier — look for the leftmost object
        let node: TSESTree.Expression = decl.init;
        let isZodDerived = false;
        let rootName: string | null = null;

        while (node.type === "CallExpression") {
          const call = node as TSESTree.CallExpression;
          if (call.callee.type !== "MemberExpression") break;
          const callee = call.callee as TSESTree.MemberExpression;
          const method =
            callee.property.type === "Identifier"
              ? (callee.property as TSESTree.Identifier).name
              : null;
          if (method && DERIVE_METHODS.includes(method)) {
            isZodDerived = true;
          }
          // Descend into the object of the member expression
          node = callee.object as TSESTree.Expression;
        }
        if (!isZodDerived) continue;

        // `node` should now be the root identifier
        if (node.type === "Identifier") {
          rootName = (node as TSESTree.Identifier).name;
        }
        if (!rootName) continue;

        const parent = zodSchemas.get(rootName);
        if (!parent) continue;

        // Inherit the parent fields, mark all as optional (safe fallback)
        const derived: RequestBodySchema = {
          source: parent.source,
          rawSchemaRef: parent.rawSchemaRef,
          fields: parent.fields.map((f) => ({ ...f, required: false })),
        };
        zodSchemas.set(name, derived);
      }
    }
  }
}

/**
 * Scan a handler function body for `someZodSchema.parse(request.body)` and
 * return the matching RequestBodySchema from zodSchemas, or null.
 * Also handles `.safeParse(request.body)` and `req.body`.
 */
function extractBodyFromHandlerFn(
  fn: TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression,
  zodSchemas: Map<string, RequestBodySchema>
): RequestBodySchema | null {
  const body = fn.body;
  if (!body || body.type !== "BlockStatement") return null;

  let found: RequestBodySchema | null = null;
  walk(body as TSESTree.Node, (node) => {
    if (found) return;
    if (node.type !== "CallExpression") return;
    const call = node as TSESTree.CallExpression;

    // Pattern: someSchema.parse(...)  OR  someSchema.safeParse(...)
    if (call.callee.type !== "MemberExpression" || call.arguments.length < 1) return;
    const callee = call.callee as TSESTree.MemberExpression;
    const method =
      callee.property.type === "Identifier"
        ? (callee.property as TSESTree.Identifier).name
        : null;
    if (method !== "parse" && method !== "safeParse") return;

    // Argument must be `request.body` or `req.body`
    const arg = call.arguments[0];
    if (
      arg.type !== "MemberExpression" ||
      arg.property.type !== "Identifier" ||
      (arg.property as TSESTree.Identifier).name !== "body"
    ) return;

    // Get the schema variable name, e.g., createProductSchema
    // Get the schema variable name — handle both patterns:
    //   identifier.parse(request.body)             (named variable)
    //   identifier.method().parse(request.body)    (inline chain, e.g. schema.partial().parse(...))
    let rootObj: TSESTree.Node = callee.object;
    while (rootObj.type === "CallExpression") {
      const inner = rootObj as TSESTree.CallExpression;
      if (inner.callee.type !== "MemberExpression") break;
      rootObj = (inner.callee as TSESTree.MemberExpression).object;
    }
    if (rootObj.type === "Identifier") {
      const schemaName = (rootObj as TSESTree.Identifier).name;
      const zodSchema = zodSchemas.get(schemaName);
      if (zodSchema) found = zodSchema;
    }
  });
  return found;
}

// ─── Plugin tree ──────────────────────────────────────────────────────────────

interface RawRoute {
  method: ExtractedEndpoint["method"];
  path: string;
  schema: RouteSchema | null;
  routeAuthRequired: boolean; // from preHandler option on this route
  sourceLine: number;
  sourceFile: string;
}

// ─── Per-file route extraction ────────────────────────────────────────────────

function extractRoutesFromAst(
  ast: TSESTree.Program,
  filePath: string,
  prefixStack: string[],
  scopeAuthRequired: boolean,
  allFiles: ParsedFile[],
  zodSchemas: Map<string, RequestBodySchema>,
  imports: Map<string, string>,
  visited: Set<string>,
  out: Array<RawRoute & { prefixStack: string[]; scopeAuth: boolean }>
): void {
  const currentPrefix = normalizePath(...prefixStack);

  walk(ast, (node) => {
    if (node.type !== "ExpressionStatement") return;
    const expr = node.expression;
    if (expr.type !== "CallExpression") return;
    if (expr.callee.type !== "MemberExpression") return;

    const callee = expr.callee;
    if (callee.property.type !== "Identifier") return;

    const methodName = callee.property.name;

    // ── fastify.register(fn, { prefix }) ─────────────────────────────────────
    if (methodName === "register" && expr.arguments.length >= 1) {
      let prefix = "";
      if (
        expr.arguments.length >= 2 &&
        expr.arguments[1].type === "ObjectExpression"
      ) {
        for (const prop of (expr.arguments[1] as TSESTree.ObjectExpression).properties) {
          if (
            prop.type === "Property" &&
            prop.key.type === "Identifier" &&
            prop.key.name === "prefix"
          ) {
            prefix = extractStringValue(prop.value as TSESTree.Node) ?? "";
          }
        }
      }

      const pluginArg = expr.arguments[0];
      let scopeHasHook = false;

      // Inline plugin function
      if (
        pluginArg.type === "FunctionExpression" ||
        pluginArg.type === "ArrowFunctionExpression"
      ) {
        const body =
          pluginArg.body.type === "BlockStatement" ? pluginArg.body : null;
        if (body) {
          // Check for scoped addHook inside this function
          walk(body, (n) => {
            if (
              n.type === "ExpressionStatement" &&
              n.expression.type === "CallExpression" &&
              n.expression.callee.type === "MemberExpression" &&
              n.expression.callee.property.type === "Identifier" &&
              n.expression.callee.property.name === "addHook"
            ) {
              const hookArgs = n.expression.arguments;
              if (hookArgs.length >= 2) {
                const hookName = extractStringValue(hookArgs[0] as TSESTree.Node);
                if (hookName === "preHandler" || hookName === "onRequest") {
                  // Check if the handler looks auth-related
                  if (hookArgs[1].type === "Identifier" && AUTH_HOOK_RE.test(hookArgs[1].name)) {
                    scopeHasHook = true;
                  }
                  if (hookArgs[1].type === "ArrayExpression") {
                    for (const el of hookArgs[1].elements) {
                      if (el && el.type === "Identifier" && AUTH_HOOK_RE.test(el.name)) {
                        scopeHasHook = true;
                      }
                    }
                  }
                }
              }
            }
          });

          // Create a temp Program-like wrapper to recurse
          const tempAst = {
            type: "Program" as const,
            body: body.body,
            comments: [],
            sourceType: "module" as const,
            range: body.range,
            loc: body.loc,
            tokens: [],
          } as unknown as TSESTree.Program;
          extractRoutesFromAst(
            tempAst,
            filePath,
            [...prefixStack, prefix],
            scopeHasHook || scopeAuthRequired,
            allFiles,
            zodSchemas,
            imports,
            visited,
            out
          );
        }
      }

      // Imported plugin function: resolve via imports map
      if (pluginArg.type === "Identifier") {
        const importedPath = imports.get(pluginArg.name);
        if (importedPath && !visited.has(importedPath)) {
          visited.add(importedPath);
          const pluginFile = allFiles.find((f) => f.filePath === importedPath);
          if (pluginFile) {
            const pluginImports = collectImports(pluginFile.ast);
            const resolvedPluginImports = resolveImports(pluginImports, importedPath, allFiles);
            extractRoutesFromAst(
              pluginFile.ast,
              importedPath,
              [...prefixStack, prefix],
              scopeHasHook || scopeAuthRequired,
              allFiles,
              zodSchemas,
              resolvedPluginImports,
              visited,
              out
            );
          }
        }
      }

      return;
    }

    // ── fastify.addHook('preHandler', ...) — global level ─────────────────────
    // (handled at outer scope — we check during route collection)

    // ── HTTP method routes ────────────────────────────────────────────────────
    if (HTTP_METHODS.has(methodName)) {
      // fastify.get(path, [opts,] handler)
      if (expr.arguments.length < 1) return;

      const routePath = extractStringValue(expr.arguments[0] as TSESTree.Node) ?? "/";
      const fullPath = normalizePath(currentPrefix, routePath);

      let schema: RouteSchema | null = null;
      let routeAuthRequired = false;

      // ── Resolve options object ────────────────────────────────────────────
      // Supported patterns:
      //   fastify.post('/path', handler)                      — 2 args, no opts
      //   fastify.post('/path', { ...opts }, handler)         — 3 args, inline opts
      //   fastify.post('/path', optVar, handler)              — 3 args, variable opts
      // When optsArg is an Identifier, resolve it to its ObjectExpression.
      let resolvedOptsObj: TSESTree.ObjectExpression | null = null;

      const rawOptsArg =
        expr.arguments.length === 3
          ? expr.arguments[1]
          : expr.arguments.length === 2 &&
            expr.arguments[1].type === "ObjectExpression"
          ? expr.arguments[1]
          : null;

      if (rawOptsArg?.type === "ObjectExpression") {
        resolvedOptsObj = rawOptsArg as TSESTree.ObjectExpression;
      } else if (rawOptsArg?.type === "Identifier") {
        resolvedOptsObj = resolveVarToObject(
          (rawOptsArg as TSESTree.Identifier).name,
          ast
        );
      }

      // ── Extract schema + auth from resolved opts ──────────────────────────
      if (resolvedOptsObj) {
        // Auth detection via preHandler / onRequest
        if (objectHasAuthHook(resolvedOptsObj)) {
          routeAuthRequired = true;
        }

        for (const prop of resolvedOptsObj.properties) {
          if (prop.type !== "Property" || prop.key.type !== "Identifier") continue;
          const pname = prop.key.name;

          if (pname === "schema" && prop.value.type === "ObjectExpression") {
            schema = extractRouteSchema(prop.value, zodSchemas);
          }
          // Explicit preHandler / onRequest identifier check (redundant but safe)
          if (pname === "preHandler" || pname === "onRequest") {
            if (
              prop.value.type === "Identifier" &&
              AUTH_HOOK_RE.test((prop.value as TSESTree.Identifier).name)
            ) {
              routeAuthRequired = true;
            }
            if (prop.value.type === "ArrayExpression") {
              for (const el of (prop.value as TSESTree.ArrayExpression).elements) {
                if (el?.type === "Identifier" && AUTH_HOOK_RE.test((el as TSESTree.Identifier).name)) {
                  routeAuthRequired = true;
                }
                if (el?.type === "MemberExpression") {
                  const m = el as TSESTree.MemberExpression;
                  if (
                    m.property.type === "Identifier" &&
                    AUTH_HOOK_RE.test((m.property as TSESTree.Identifier).name)
                  ) {
                    routeAuthRequired = true;
                  }
                }
              }
            }
          }
        }
      }

      // ── Fallback: extract body schema from handler function body ──────────
      // Handles:  const body = createProductSchema.parse(request.body)
      // when no `schema: { body: ... }` is present in the opts object.
      if (!schema?.requestBody) {
        const handlerArg = expr.arguments[expr.arguments.length - 1];
        if (
          handlerArg?.type === "FunctionExpression" ||
          handlerArg?.type === "ArrowFunctionExpression"
        ) {
          const handlerBody = extractBodyFromHandlerFn(
            handlerArg as TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression,
            zodSchemas
          );
          if (handlerBody) {
            schema = {
              requestBody: handlerBody,
              queryParams: schema?.queryParams ?? [],
              pathParams: schema?.pathParams ?? [],
              hasResponse: schema?.hasResponse ?? false,
            };
          }
        }
      }

      out.push({
        method: methodFromString(methodName),
        path: fullPath,
        schema,
        routeAuthRequired,
        sourceLine: node.loc?.start.line ?? 0,
        sourceFile: filePath,
        prefixStack,
        scopeAuth: scopeAuthRequired,
      });

      return;
    }

    // ── fastify.route({ method, url, schema, handler }) ───────────────────────
    if (methodName === "route" && expr.arguments.length >= 1) {
      const arg = expr.arguments[0];
      if (arg.type !== "ObjectExpression") return;

      let method: ExtractedEndpoint["method"] = "GET";
      let routePath = "/";
      let schema: RouteSchema | null = null;
      let routeAuthRequired = false;

      for (const prop of arg.properties) {
        if (prop.type !== "Property" || prop.key.type !== "Identifier") continue;
        if (prop.key.name === "method") {
          const m = extractStringValue(prop.value as TSESTree.Node);
          if (m) method = methodFromString(m);
          // Handle array of methods: ['GET', 'HEAD']
          if (prop.value.type === "ArrayExpression") {
            // Use first method; caller can expand
            const first = prop.value.elements[0];
            if (first) {
              const mv = extractStringValue(first as TSESTree.Node);
              if (mv) method = methodFromString(mv);
            }
          }
        }
        if (prop.key.name === "url" || prop.key.name === "path") {
          routePath = extractStringValue(prop.value as TSESTree.Node) ?? "/";
        }
        if (prop.key.name === "schema" && prop.value.type === "ObjectExpression") {
          schema = extractRouteSchema(prop.value, zodSchemas);
        }
        if (prop.key.name === "preHandler" || prop.key.name === "onRequest") {
          if (prop.value.type === "Identifier" && AUTH_HOOK_RE.test(prop.value.name)) {
            routeAuthRequired = true;
          }
          if (prop.value.type === "ArrayExpression") {
            for (const el of prop.value.elements) {
              if (el && el.type === "Identifier" && AUTH_HOOK_RE.test(el.name)) {
                routeAuthRequired = true;
              }
              if (el && el.type === "MemberExpression") {
                const m = el as TSESTree.MemberExpression;
                if (
                  m.property.type === "Identifier" &&
                  AUTH_HOOK_RE.test((m.property as TSESTree.Identifier).name)
                ) {
                  routeAuthRequired = true;
                }
              }
            }
          }
        }
      }

      const fullPath = normalizePath(currentPrefix, routePath);
      out.push({
        method,
        path: fullPath,
        schema,
        routeAuthRequired,
        sourceLine: node.loc?.start.line ?? 0,
        sourceFile: filePath,
        prefixStack,
        scopeAuth: scopeAuthRequired,
      });
    }
  });
}

// ─── Detect global auth hooks ─────────────────────────────────────────────────

function hasGlobalAuthHook(ast: TSESTree.Program): boolean {
  let found = false;
  walk(ast, (node) => {
    if (
      node.type === "ExpressionStatement" &&
      node.expression.type === "CallExpression" &&
      node.expression.callee.type === "MemberExpression" &&
      node.expression.callee.property.type === "Identifier" &&
      node.expression.callee.property.name === "addHook"
    ) {
      const args = node.expression.arguments;
      if (args.length >= 2) {
        const hookName = extractStringValue(args[0] as TSESTree.Node);
        if (hookName === "preHandler" || hookName === "onRequest") {
          if (args[1].type === "Identifier" && AUTH_HOOK_RE.test(args[1].name)) {
            found = true;
          }
          if (args[1].type === "ArrayExpression") {
            for (const el of args[1].elements) {
              if (el && el.type === "Identifier" && AUTH_HOOK_RE.test(el.name)) {
                found = true;
              }
            }
          }
        }
      }
    }
  });
  return found;
}

// ─── Import helpers ───────────────────────────────────────────────────────────

function resolveImports(
  rawImports: TSESTree.ImportDeclaration[],
  fromFile: string,
  allFiles: ParsedFile[]
): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const imp of rawImports) {
    const src = imp.source.value as string;
    if (!src.startsWith(".")) continue;
    const abs = resolveImportPath(src, fromFile);
    if (!abs) continue;
    if (!allFiles.find((f) => f.filePath === abs)) continue;
    for (const spec of imp.specifiers) {
      resolved.set(spec.local.name, abs);
    }
  }
  return resolved;
}

// ─── Fastify Extractor ────────────────────────────────────────────────────────

class FastifyExtractor implements IFrameworkExtractor {
  readonly framework = "fastify" as const;

  canHandle(detection: PackageDetection): boolean {
    return detection.backendFrameworks.includes("fastify");
  }

  async extract(
    files: ParsedFile[],
    detection: PackageDetection
  ): Promise<ExtractedEndpoint[]> {
    const endpoints: ExtractedEndpoint[] = [];
    const zodSchemas = extractZodSchemas(files);
    enrichWithDerivedSchemas(files, zodSchemas); // augment with .partial()/.omit()/.pick() derived schemas

    // Find entry files: main.ts, server.ts, app.ts, index.ts
    const entryFilePatterns = /\/(main|server|app|index)\.(ts|js)$/;
    const entryFiles = files.filter(
      (f) =>
        entryFilePatterns.test(f.filePath) &&
        !f.filePath.includes("node_modules") &&
        f.filePath.startsWith(detection.rootPath)
    );

    const rawRoutes: Array<
      RawRoute & { prefixStack: string[]; scopeAuth: boolean }
    > = [];

    for (const entryFile of entryFiles) {
      const globalAuth = hasGlobalAuthHook(entryFile.ast);
      const imports = collectImports(entryFile.ast);
      const resolvedImports = resolveImports(imports, entryFile.filePath, files);

      extractRoutesFromAst(
        entryFile.ast,
        entryFile.filePath,
        [],
        globalAuth,
        files,
        zodSchemas,
        resolvedImports,
        new Set([entryFile.filePath]),
        rawRoutes
      );
    }

    // If no routes from entry files, scan all files for fastify patterns
    if (rawRoutes.length === 0) {
      for (const pf of files) {
        if (pf.filePath.includes("node_modules")) continue;
        if (!pf.filePath.startsWith(detection.rootPath)) continue;
        const globalAuth = hasGlobalAuthHook(pf.ast);
        const imports = collectImports(pf.ast);
        const resolvedImports = resolveImports(imports, pf.filePath, files);

        extractRoutesFromAst(
          pf.ast,
          pf.filePath,
          [],
          globalAuth,
          files,
          zodSchemas,
          resolvedImports,
          new Set([pf.filePath]),
          rawRoutes
        );
      }
    }

    // Convert raw routes to ExtractedEndpoint[]
    for (const rr of rawRoutes) {
      const authRequired = rr.routeAuthRequired || rr.scopeAuth;
      let authType: AuthType | null = authRequired ? "bearer_jwt" : null;

      const pathParams = extractPathParams(rr.path);
      // Merge schema-derived path params
      if (rr.schema?.pathParams) {
        for (const p of rr.schema.pathParams) {
          if (!pathParams.find((pp) => pp.name === p.name)) {
            pathParams.push(p);
          }
        }
      }

      const flags: ExtractorFlag[] = [];
      if (rr.path.includes("*")) flags.push("WILDCARD_HANDLER");
      if (rr.path.includes(":")) flags.push("DYNAMIC_PATH");

      let confidence = 0.80;
      if (rr.schema?.requestBody) confidence += 0.05;
      if (!authRequired && ["POST", "PUT", "PATCH", "DELETE"].includes(rr.method)) confidence -= 0.05;
      confidence = Math.min(0.95, confidence);

      endpoints.push({
        id: nextId(),
        method: rr.method,
        path: rr.path,
        pathParams,
        queryParams: rr.schema?.queryParams ?? [],
        requestBody: rr.schema?.requestBody ?? null,
        responseSchema: null,
        authRequired,
        authType,
        roles: [],
        sourceFile: rr.sourceFile,
        sourceLine: rr.sourceLine,
        framework: "fastify",
        confidence,
        flags,
      });
    }

    return endpoints;
  }
}

export const fastifyExtractor = new FastifyExtractor();
