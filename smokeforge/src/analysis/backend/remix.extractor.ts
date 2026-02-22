import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import type { PackageDetection } from "../../ingestion/detector";
import type { IFrameworkExtractor } from "./index";
import type {
  ExtractedEndpoint,
  PathParam,
  QueryParam,
  RequestBodySchema,
  ResponseSchema,
  BodyField,
} from "../../blueprint/types";
import { extractZodSchemas } from "../schemas/zod.extractor";
import { extractJoiSchemas } from "../schemas/joi.extractor";

// ─── Remix Extractor ──────────────────────────────────────────────────────────
// File-based routing: app/routes/**.(tsx|ts|jsx|js)
// loader() → GET, action() → POST (or detected method from request.method checks)
// Flat file v2 convention: dots → slashes, $ → :param, _ → layout (strip)

export const remixExtractor: IFrameworkExtractor = {
  framework: "remix",

  canHandle(detection: PackageDetection): boolean {
    return (
      detection.backendFrameworks.includes("remix") ||
      detection.frontendFrameworks.includes("remix")
    );
  },

  async extract(
    files: ParsedFile[],
    _detection: PackageDetection
  ): Promise<ExtractedEndpoint[]> {
    _remixEpCounter = 0; // reset so IDs are stable per analyze run
    const routeFiles = files.filter((f) => isRemixRouteFile(f.filePath));
    const endpoints: ExtractedEndpoint[] = [];

    // Build schema registries across ALL project files (not just route files).
    // This resolves imported schemas like `import { CreatePatientSchema } from '~/schemas'`.
    const zodRegistry = extractZodSchemas(files);
    const joiRegistry = extractJoiSchemas(files);
    const schemaRegistry = new Map<string, RequestBodySchema>([...zodRegistry, ...joiRegistry]);

    for (const file of routeFiles) {
      const routePath = filePathToRoutePath(file.filePath);
      if (!routePath) continue;

      const extracted = extractFromRouteFile(file, routePath, schemaRegistry);
      endpoints.push(...extracted);
    }

    // Post-processing: propagate auth from parent layout routes to child routes.
    // Remix layout routes (e.g. app/routes/dashboard.tsx) act as layout parents
    // for all children (e.g. /dashboard/settings, /dashboard/profile). If the
    // parent route requires auth, the children inherit it.
    propagateLayoutAuth(endpoints);

    return endpoints;
  },
};

// ─── Route File Detection ─────────────────────────────────────────────────────

function isRemixRouteFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    /\/app\/routes\/[^/]+\.(tsx?|jsx?)$/.test(normalized) ||
    /\/app\/routes\/.+\.(tsx?|jsx?)$/.test(normalized)
  );
}

// ─── File Path → URL Route Conversion ────────────────────────────────────────
// Remix v2 flat file convention:
//   users._index.tsx      → /users
//   users.$userId.tsx     → /users/:userId
//   users.$userId.edit.tsx → /users/:userId/edit
//   api.products.tsx      → /api/products
//   _layout.users.tsx     → /users (strip leading _ segment)
//   users.($optional).tsx → /users/:optional?

function filePathToRoutePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/\/app\/routes\/(.+)\.(tsx?|jsx?)$/);
  if (!match) return null;

  let name = match[1];

  // Strip leading underscore layout routes: _layout.users → users
  // But not $ prefixes — those are params
  // _index → index page (strip the _ prefix, keep "index" which resolves to "")
  name = name
    .split("/")
    .map((segment) => (segment.startsWith("_") ? segment.slice(1) : segment))
    .join("/");

  // Split on dots (flat file convention)
  const segments = name.split(".");

  // Convert each segment:
  // $userId → :userId (dynamic param)
  // _index  → empty string (index route)
  // regular → keep as-is
  const urlParts: string[] = [];
  for (const seg of segments) {
    if (seg === "_index" || seg === "index") {
      // index route — contributes no segment
      continue;
    }
    if (seg.startsWith("$")) {
      urlParts.push(`:${seg.slice(1)}`);
    } else if (seg.startsWith("(") && seg.endsWith(")")) {
      // optional segment
      urlParts.push(`:${seg.slice(1, -1)}?`);
    } else {
      urlParts.push(seg);
    }
  }

  return `/${urlParts.join("/")}`;
}

// ─── Module-level ID counter (shared across all route files per extract() run) ─
let _remixEpCounter = 0;

// ─── Route File Analysis ──────────────────────────────────────────────────────

function extractFromRouteFile(
  file: ParsedFile,
  routePath: string,
  schemaRegistry: Map<string, RequestBodySchema> = new Map()
): ExtractedEndpoint[] {
  if (!file.ast) return [];

  const endpoints: ExtractedEndpoint[] = [];
  const pathParams = extractPathParams(routePath);

  const nextId = () => `remix_${++_remixEpCounter}`;

  // Detect whether this route file is a PAGE ROUTE (has a default React component export).
  // Page routes return HTML (React SSR) — never JSON. Resource routes (.ts files, no default
  // export) return JSON. This distinction is critical for test generation: calling
  // response.json() on a page route throws "SyntaxError: Unexpected token '<'".
  const isPageRoute = file.ast.body.some(
    (node) => node.type === "ExportDefaultDeclaration"
  );

  // Find exported functions: loader, action
  let loaderNode: TSESTree.FunctionLike | null = null;
  let actionNode: TSESTree.FunctionLike | null = null;

  for (const node of file.ast.body) {
    // export async function loader(...) { }
    if (
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration"
    ) {
      const fn = node.declaration;
      if (fn.id?.name === "loader") loaderNode = fn;
      else if (fn.id?.name === "action") actionNode = fn;
    }

    // export const loader = async (...) => { }
    if (
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "VariableDeclaration"
    ) {
      for (const decl of node.declaration.declarations) {
        if (
          decl.id.type === "Identifier" &&
          decl.init &&
          isFunctionLike(decl.init)
        ) {
          if (decl.id.name === "loader") loaderNode = decl.init as TSESTree.FunctionLike;
          else if (decl.id.name === "action") actionNode = decl.init as TSESTree.FunctionLike;
        }
      }
    }
  }

  // Build loader endpoint (GET)
  if (loaderNode) {
    const queryParams = extractQueryParamsFromLoader(loaderNode);
    const authRequired = checkFnAuth(loaderNode);
    endpoints.push({
      id: nextId(),
      method: "GET",
      path: routePath,
      pathParams,
      queryParams,
      requestBody: null,
      responseSchema: extractResponseSchemaFromFn(loaderNode),
      authRequired,
      authType: authRequired ? "session_cookie" : null,
      roles: [],
      confidence: 0.75,
      sourceLine: 0,
      flags: [],
      sourceFile: file.filePath,
      framework: "remix",
      isPageRoute,
    });
  }

  // Build action endpoints (POST / method-specific)
  if (actionNode) {
    const methodsUsed = detectActionMethods(actionNode);
    const { fields: bodyFields, resolvedSchema } = extractBodyFieldsFromAction(actionNode, schemaRegistry);
    const authRequired = checkFnAuth(actionNode);
    const roles = extractRolesFromAction(actionNode);

    // Prefer resolved schema (from Zod/Joi registry) over inferred fields —
    // it has correct types, validators and examples from the actual schema definition.
    const requestBody: RequestBodySchema | null =
      resolvedSchema ?? (bodyFields.length > 0
        ? { source: "inferred", rawSchemaRef: null, fields: bodyFields }
        : null);

    const actionResponseSchema = extractResponseSchemaFromFn(actionNode);
    for (const rawMethod of methodsUsed) {
      const method = rawMethod as ExtractedEndpoint["method"];
      endpoints.push({
        id: nextId(),
        method,
        path: routePath,
        pathParams,
        queryParams: [],
        requestBody,
        responseSchema: actionResponseSchema,
        authRequired,
        authType: authRequired ? "session_cookie" : null,
        roles,
        confidence: 0.75,
        sourceLine: 0,
        flags: [],
        sourceFile: file.filePath,
        framework: "remix",
      });
    }
  }

  return endpoints;
}

// ─── Path Param Extraction ────────────────────────────────────────────────────

function extractPathParams(routePath: string): PathParam[] {
  const params: PathParam[] = [];
  const regex = /:([^/?]+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(routePath)) !== null) {
    params.push({ name: m[1], type: "string", example: m[1] });
  }
  return params;
}

// ─── Loader Analysis ──────────────────────────────────────────────────────────

function extractQueryParamsFromLoader(fn: TSESTree.FunctionLike): QueryParam[] {
  const params: QueryParam[] = [];
  const body = getFunctionBody(fn);
  if (!body) return params;

  // url.searchParams.get('page') → queryParam: page
  // searchParams.get('page') → queryParam: page
  // const { page } = Object.fromEntries(url.searchParams)
  walkAst(body, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "get"
    ) {
      const obj = node.callee.object;
      const isSearchParams =
        (obj.type === "Identifier" && /searchparams/i.test((obj as TSESTree.Identifier).name)) ||
        (obj.type === "MemberExpression" &&
          obj.property.type === "Identifier" &&
          obj.property.name === "searchParams");

      if (isSearchParams && node.arguments[0]?.type === "Literal") {
        const name = String((node.arguments[0] as TSESTree.Literal).value);
        if (!params.find((p) => p.name === name)) {
          params.push({ name, type: "string", required: false });
        }
      }
    }
  });

  return params;
}

function checkFnAuth(fn: TSESTree.FunctionLike): boolean {
  const body = getFunctionBody(fn);
  if (!body) return false;

  let auth = false;
  walkAst(body, (node) => {
    // requireUser(request), requireAuth(request), etc. ─ any call
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      /require|authenticate|protect/i.test((node.callee as TSESTree.Identifier).name)
    ) {
      auth = true;
    }
    // await requireX(request) ─ await expression form
    if (
      node.type === "AwaitExpression" &&
      node.argument.type === "CallExpression"
    ) {
      const callee = (node.argument as TSESTree.CallExpression).callee;
      if (
        callee.type === "Identifier" &&
        /require|authenticate|protect/i.test((callee as TSESTree.Identifier).name)
      ) {
        auth = true;
      }
    }
    // throw redirect('/login')  — only an auth guard when target is a login/auth destination.
    // Avoids false-positives like: if (user) throw redirect('/dashboard') on the login page.
    if (node.type === "ThrowStatement") {
      const arg = (node as TSESTree.ThrowStatement).argument as TSESTree.Node | null;
      if (arg && arg.type === "CallExpression") {
        const call = arg as TSESTree.CallExpression;
        if (
          call.callee.type === "Identifier" &&
          (call.callee as TSESTree.Identifier).name === "redirect"
        ) {
          const firstArg = call.arguments[0];
          if (firstArg?.type === "Literal") {
            const target = String((firstArg as TSESTree.Literal).value);
            if (/\/login|\/signin|\/auth\/login|\/auth$|\/forbidden|\/401|\/403/i.test(target)) {
              auth = true;
            }
          } else {
            // Dynamic target (e.g. variable) — conservatively treat as auth guard
            auth = true;
          }
        }
      }
    }
    // if (!user) return redirect('/login')  ─ guard pattern only.
    // We only treat `return redirect(url)` as auth when it is the consequent
    // of an if-statement whose test is a negation check (if (!x) ...), AND
    // the redirect target looks like a login/auth destination.
    // This avoids flagging success redirects like: return redirect(`/items/${id}`).
    if (node.type === "IfStatement") {
      const ifNode = node as TSESTree.IfStatement;
      const test = ifNode.test;
      // Accept: !x, x === null, x === undefined, x == null
      const isNegation =
        (test.type === "UnaryExpression" && (test as TSESTree.UnaryExpression).operator === "!") ||
        (test.type === "BinaryExpression" &&
          ["===", "=="].includes((test as TSESTree.BinaryExpression).operator) &&
          ((test as TSESTree.BinaryExpression).right.type === "Literal" &&
            ((test as TSESTree.BinaryExpression).right as TSESTree.Literal).value == null));

      if (isNegation) {
        // Unwrap block or direct return
        let retArg: TSESTree.Node | null | undefined = null;
        const consequent = ifNode.consequent;
        if (consequent.type === "ReturnStatement") {
          retArg = (consequent as TSESTree.ReturnStatement).argument;
        } else if (consequent.type === "BlockStatement") {
          const stmts = (consequent as TSESTree.BlockStatement).body;
          if (stmts.length === 1 && stmts[0].type === "ReturnStatement") {
            retArg = (stmts[0] as TSESTree.ReturnStatement).argument;
          }
        }
        if (retArg && retArg.type === "CallExpression") {
          const retCall = retArg as TSESTree.CallExpression;
          if (
            retCall.callee.type === "Identifier" &&
            (retCall.callee as TSESTree.Identifier).name === "redirect" &&
            retCall.arguments[0]?.type === "Literal"
          ) {
            const target = String((retCall.arguments[0] as TSESTree.Literal).value);
            if (/\/login|\/signin|\/auth\/login|\/auth$|\/forbidden|\/401|\/403/i.test(target)) {
              auth = true;
            }
          }
        }
      }
    }
  });

  return auth;
}

// ─── Action Analysis ──────────────────────────────────────────────────────────

function detectActionMethods(fn: TSESTree.FunctionLike): string[] {
  const body = getFunctionBody(fn);
  if (!body) return ["POST"];

  const methods = new Set<string>();

  walkAst(body, (node) => {
    // if (request.method === 'DELETE') ...
    // if (request.method !== 'POST') ...
    if (
      node.type === "BinaryExpression" &&
      (node.operator === "===" || node.operator === "==") &&
      node.right.type === "Literal"
    ) {
      const left = node.left;
      if (
        left.type === "MemberExpression" &&
        left.property.type === "Identifier" &&
        left.property.name === "method"
      ) {
        const val = String((node.right as TSESTree.Literal).value).toUpperCase();
        if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(val)) {
          methods.add(val);
        }
      }
    }
  });

  return methods.size > 0 ? Array.from(methods) : ["POST"];
}

// Noise field names that are not real request body fields
const BODY_FIELD_NOISE = new Set([
  "success", "error", "message", "status", "data", "code", "ok", "type",
  "flatten", "fieldErrors", "formErrors", "id", "createdAt", "updatedAt",
  "length", "size", "name", "prepare", "run", "get", "all", "changes",
]);

function isJsonCallExpression(node: TSESTree.Node): boolean {
  // request.json()
  if (
    node.type === "CallExpression" &&
    (node as TSESTree.CallExpression).callee.type === "MemberExpression"
  ) {
    const prop = ((node as TSESTree.CallExpression).callee as TSESTree.MemberExpression).property;
    return prop.type === "Identifier" && (prop as TSESTree.Identifier).name === "json";
  }
  return false;
}

function isFormDataCallExpression(node: TSESTree.Node): boolean {
  // request.formData()
  if (
    node.type === "CallExpression" &&
    (node as TSESTree.CallExpression).callee.type === "MemberExpression"
  ) {
    const prop = ((node as TSESTree.CallExpression).callee as TSESTree.MemberExpression).property;
    return prop.type === "Identifier" && (prop as TSESTree.Identifier).name === "formData";
  }
  return false;
}

function isFromEntriesCall(node: TSESTree.Node): boolean {
  // Object.fromEntries(...)
  if (node.type !== "CallExpression") return false;
  const callee = (node as TSESTree.CallExpression).callee;
  if (callee.type !== "MemberExpression") return false;
  const obj  = (callee as TSESTree.MemberExpression).object;
  const prop = (callee as TSESTree.MemberExpression).property;
  return (
    obj.type === "Identifier" && (obj as TSESTree.Identifier).name === "Object" &&
    prop.type === "Identifier" && (prop as TSESTree.Identifier).name === "fromEntries"
  );
}

function extractBodyFieldsFromAction(
  fn: TSESTree.FunctionLike,
  schemaRegistry: Map<string, RequestBodySchema> = new Map()
): { fields: BodyField[]; resolvedSchema: RequestBodySchema | null } {
  const fields: BodyField[] = [];
  const body = getFunctionBody(fn);
  if (!body) return { fields, resolvedSchema: null };

  // bodyObjVarNames: variable names whose properties are request body fields.
  // Populated from: await request.json(), Object.fromEntries(formData), result.data
  const bodyObjVarNames     = new Set<string>();
  // formDataVarNames: intermediate formData variables
  const formDataVarNames    = new Set<string>();
  // safeParseResultVarNames: variables from SomeSchema.safeParse(...)
  const safeParseResultVarNames = new Set<string>();
  // safeParseSchemaNames: resultVar → schemaName (for registry lookup)
  const safeParseSchemaNames = new Map<string, string>();

  walkAst(body, (node) => {
    // ── formData.get('fieldName') → body field (explicit get) ───────────────
    if (
      node.type === "CallExpression" &&
      (node as TSESTree.CallExpression).callee.type === "MemberExpression"
    ) {
      const call = node as TSESTree.CallExpression;
      const callee = call.callee as TSESTree.MemberExpression;
      if (
        callee.property.type === "Identifier" &&
        (callee.property as TSESTree.Identifier).name === "get" &&
        callee.object.type === "Identifier" &&
        (formDataVarNames.has((callee.object as TSESTree.Identifier).name) ||
          /formdata|form/i.test((callee.object as TSESTree.Identifier).name)) &&
        call.arguments[0]?.type === "Literal"
      ) {
        const fname = String((call.arguments[0] as TSESTree.Literal).value);
        if (!fields.find((f) => f.name === fname)) {
          fields.push({ name: fname, type: "string", required: false, validators: [], example: null });
        }
      }
    }

    // ── VariableDeclarator: all binding detections ────────────────────────────
    if (node.type !== "VariableDeclarator") {
      // ── result.data.fieldName direct access ───────────────────────────────
      if (
        node.type === "MemberExpression" &&
        !(node as TSESTree.MemberExpression).computed &&
        (node as TSESTree.MemberExpression).property.type === "Identifier" &&
        (node as TSESTree.MemberExpression).object.type === "MemberExpression"
      ) {
        const outer = node as TSESTree.MemberExpression;
        const inner = outer.object as TSESTree.MemberExpression;
        if (
          !inner.computed &&
          inner.property.type === "Identifier" &&
          (inner.property as TSESTree.Identifier).name === "data" &&
          inner.object.type === "Identifier" &&
          safeParseResultVarNames.has((inner.object as TSESTree.Identifier).name)
        ) {
          const fname = (outer.property as TSESTree.Identifier).name;
          if (!BODY_FIELD_NOISE.has(fname) && !fields.find((f) => f.name === fname)) {
            fields.push({ name: fname, type: "string", required: false, validators: [], example: null });
          }
        }
      }

      // ── bodyObjVar.fieldName member access ───────────────────────────────
      if (
        node.type === "MemberExpression" &&
        !(node as TSESTree.MemberExpression).computed &&
        (node as TSESTree.MemberExpression).property.type === "Identifier" &&
        (node as TSESTree.MemberExpression).object.type === "Identifier"
      ) {
        const mem = node as TSESTree.MemberExpression;
        const objName = (mem.object as TSESTree.Identifier).name;
        if (bodyObjVarNames.has(objName)) {
          const fname = (mem.property as TSESTree.Identifier).name;
          if (!BODY_FIELD_NOISE.has(fname) && !fields.find((f) => f.name === fname)) {
            fields.push({ name: fname, type: "string", required: false, validators: [], example: null });
          }
        }
      }
      return;
    }

    const decl = node as TSESTree.VariableDeclarator;
    const init = decl.init;
    if (!init) return;

    // ── const { email, password } = await request.json()  (destructure) ─────
    if (decl.id.type === "ObjectPattern" && init.type === "AwaitExpression") {
      const awaitArg = (init as TSESTree.AwaitExpression).argument;
      if (isJsonCallExpression(awaitArg)) {
        for (const prop of (decl.id as TSESTree.ObjectPattern).properties) {
          if (prop.type === "Property" && (prop as TSESTree.Property).key.type === "Identifier") {
            const fname = ((prop as TSESTree.Property).key as TSESTree.Identifier).name;
            if (!fields.find((f) => f.name === fname)) {
              fields.push({ name: fname, type: "string", required: false, validators: [], example: null });
            }
          }
        }
      }
      return;
    }
    // ── const { email, password } = result.data  (destructure from safeParse) ─
    if (decl.id.type === "ObjectPattern" && init.type === "MemberExpression") {
      const mem = init as TSESTree.MemberExpression;
      if (
        !mem.computed &&
        mem.property.type === "Identifier" &&
        (mem.property as TSESTree.Identifier).name === "data" &&
        mem.object.type === "Identifier" &&
        safeParseResultVarNames.has((mem.object as TSESTree.Identifier).name)
      ) {
        for (const prop of (decl.id as TSESTree.ObjectPattern).properties) {
          if (prop.type === "Property" && (prop as TSESTree.Property).key.type === "Identifier") {
            const fname = ((prop as TSESTree.Property).key as TSESTree.Identifier).name;
            if (!BODY_FIELD_NOISE.has(fname) && !fields.find((f) => f.name === fname)) {
              fields.push({ name: fname, type: "string", required: false, validators: [], example: null });
            }
          }
        }
      }
      return;
    }

    // ── const { field1, field2 } = rawVar  (destructure from body object var) ─
    if (decl.id.type === "ObjectPattern" && init.type === "Identifier") {
      const rawName = (init as TSESTree.Identifier).name;
      if (bodyObjVarNames.has(rawName)) {
        for (const prop of (decl.id as TSESTree.ObjectPattern).properties) {
          if (prop.type === "Property" && (prop as TSESTree.Property).key.type === "Identifier") {
            const fname = ((prop as TSESTree.Property).key as TSESTree.Identifier).name;
            if (!BODY_FIELD_NOISE.has(fname) && !fields.find((f) => f.name === fname)) {
              fields.push({ name: fname, type: "string", required: false, validators: [], example: null });
            }
          }
        }
      }
      return;
    }
    if (decl.id.type !== "Identifier") return;
    const varName = (decl.id as TSESTree.Identifier).name;

    // ── const formData = await request.formData() ───────────────────────────
    if (init.type === "AwaitExpression") {
      const awaitArg = (init as TSESTree.AwaitExpression).argument;
      if (isFormDataCallExpression(awaitArg)) {
        formDataVarNames.add(varName);
        return;
      }

      // ── const body = await request.json()  OR  .json().catch(...) ────────
      // Direct json
      if (isJsonCallExpression(awaitArg)) {
        bodyObjVarNames.add(varName);
        return;
      }
      // json().catch(...)
      if (
        awaitArg.type === "CallExpression" &&
        (awaitArg as TSESTree.CallExpression).callee.type === "MemberExpression"
      ) {
        const catchCallee = (awaitArg as TSESTree.CallExpression).callee as TSESTree.MemberExpression;
        if (
          catchCallee.property.type === "Identifier" &&
          (catchCallee.property as TSESTree.Identifier).name === "catch" &&
          isJsonCallExpression(catchCallee.object)
        ) {
          bodyObjVarNames.add(varName);
        }
      }
      return;
    }

    // ── const raw = Object.fromEntries(formData) ────────────────────────────
    if (isFromEntriesCall(init)) {
      bodyObjVarNames.add(varName);
      return;
    }

    // ── const result = SomeSchema.safeParse(rawVar)  OR  SomeSchema.validate(rawVar) ──
    if (
      init.type === "CallExpression" &&
      (init as TSESTree.CallExpression).callee.type === "MemberExpression" &&
      ((init as TSESTree.CallExpression).callee as TSESTree.MemberExpression).property.type === "Identifier" &&
      /^(safeParse|parseAsync|parse|validate|validateAsync)$/.test(
        (((init as TSESTree.CallExpression).callee as TSESTree.MemberExpression).property as TSESTree.Identifier).name
      )
    ) {
      safeParseResultVarNames.add(varName);
      // ── Capture the schema name so we can look it up in the registry ───────
      // e.g.  const result = CreatePatientSchema.safeParse(raw)
      //       schemaName = "CreatePatientSchema"
      const spCallee = (init as TSESTree.CallExpression).callee as TSESTree.MemberExpression;
      if (spCallee.object.type === "Identifier") {
        safeParseSchemaNames.set(varName, (spCallee.object as TSESTree.Identifier).name);
      }
      return;
    }

    // ── const data = result.data ─────────────────────────────────────────────
    if (
      init.type === "MemberExpression" &&
      !(init as TSESTree.MemberExpression).computed &&
      (init as TSESTree.MemberExpression).property.type === "Identifier" &&
      ((init as TSESTree.MemberExpression).property as TSESTree.Identifier).name === "data" &&
      (init as TSESTree.MemberExpression).object.type === "Identifier"
    ) {
      const resultName = ((init as TSESTree.MemberExpression).object as TSESTree.Identifier).name;
      if (safeParseResultVarNames.has(resultName)) {
        bodyObjVarNames.add(varName);
      }
    }
  });

  // ── Resolve schema from registry (highest priority) ──────────────────────
  // If any safeParse/validate call referenced a named schema, look it up in
  // the Zod/Joi registry (built from all project files). This gives us the
  // exact field names, types, validators and examples from the actual schema
  // definition — far more accurate than the usage-inferred fields above.
  let resolvedSchema: RequestBodySchema | null = null;
  for (const [, schemaName] of safeParseSchemaNames) {
    const schema = schemaRegistry.get(schemaName);
    if (schema && schema.fields.length > 0) {
      resolvedSchema = { ...schema, rawSchemaRef: schemaName };
      break;
    }
  }

  return { fields, resolvedSchema };
}
// ─── Layout Route Auth Propagation ───────────────────────────────────────────
// In Remix, a route file like `dashboard.tsx` is the layout parent for all
// child routes matching `/dashboard/*`. If the parent requires auth, children
// inherit it — even if the child file itself has no explicit auth check.
//
// Algorithm: build a path→authRequired map, then for each unauthenticated
// endpoint walk up its path hierarchy (strip one segment at a time) looking
// for an authenticated parent.

function propagateLayoutAuth(endpoints: ExtractedEndpoint[]): void {
  // Map from normalized path → whether that path has authRequired:true.
  // Only consider GET endpoints as canonical "layout" sources (loaders define
  // the layout guard; actions inherit from their own loader's parent, not from
  // another action on the same path).
  const authPaths = new Map<string, boolean>();
  for (const ep of endpoints) {
    if (ep.authRequired) {
      authPaths.set(normalizePath(ep.path), true);
    }
  }

  for (const ep of endpoints) {
    if (ep.authRequired) continue;

    const segments = normalizePath(ep.path).split("/").filter(Boolean);
    // Walk from longest prefix down to single-segment prefixes.
    for (let len = segments.length - 1; len >= 1; len--) {
      const parentPath = "/" + segments.slice(0, len).join("/");
      if (authPaths.get(parentPath)) {
        ep.authRequired = true;
        if (!ep.authType) ep.authType = "session_cookie";
        ep.flags = [...(ep.flags ?? []), "AUTH_INHERITED_FROM_LAYOUT"];
        break;
      }
    }
  }
}

/** Strip trailing dynamic-param segments when comparing paths so that
 *  `/patients` matches as parent of `/patients/:patientId`. */
function normalizePath(path: string): string {
  return path.replace(/\/:[^/]+/g, "/:param");
}
// ─── Response Schema Extraction ─────────────────────────────────────────────
// Scans return json(...) calls to infer the primary success response schema.

function extractResponseSchemaFromFn(fn: TSESTree.FunctionLike): ResponseSchema | null {
  const body = getFunctionBody(fn);
  if (!body) return null;

  const responses: Array<{ statusCode: number; fields: string[] }> = [];

  walkAst(body, (node) => {
    if (node.type !== "ReturnStatement") return;
    const arg = (node as TSESTree.ReturnStatement).argument;
    if (!arg) return;

    let jsonCall: TSESTree.CallExpression | null = null;

    // return json(...) or return Response.json(...)
    if (arg.type === "CallExpression") {
      const callee = (arg as TSESTree.CallExpression).callee;
      const isJsonIdent =
        callee.type === "Identifier" &&
        (callee as TSESTree.Identifier).name === "json";
      const isJsonMember =
        callee.type === "MemberExpression" &&
        (callee as TSESTree.MemberExpression).property.type === "Identifier" &&
        ((callee as TSESTree.MemberExpression).property as TSESTree.Identifier).name === "json";
      if (isJsonIdent || isJsonMember) {
        jsonCall = arg as TSESTree.CallExpression;
      }
    }
    if (!jsonCall) return;

    const args = jsonCall.arguments;
    if (args.length === 0) return;

    // Determine status code from second arg { status: N }
    let statusCode = 200;
    if (args.length >= 2) {
      const optionsArg = args[1];
      if (optionsArg.type === "ObjectExpression") {
        for (const prop of (optionsArg as TSESTree.ObjectExpression).properties) {
          if (
            prop.type === "Property" &&
            (prop as TSESTree.Property).key.type === "Identifier" &&
            ((prop as TSESTree.Property).key as TSESTree.Identifier).name === "status" &&
            (prop as TSESTree.Property).value.type === "Literal"
          ) {
            const val = ((prop as TSESTree.Property).value as TSESTree.Literal).value;
            if (typeof val === "number") statusCode = val;
          }
        }
      }
    }

    // Extract field names from first arg ObjectExpression
    const dataArg = args[0];
    const fields: string[] = [];
    if (dataArg.type === "ObjectExpression") {
      for (const prop of (dataArg as TSESTree.ObjectExpression).properties) {
        if (prop.type === "Property") {
          const key = (prop as TSESTree.Property).key;
          if (key.type === "Identifier") {
            const fname = (key as TSESTree.Identifier).name;
            if (!fields.includes(fname)) fields.push(fname);
          } else if (key.type === "Literal") {
            const fname = String((key as TSESTree.Literal).value);
            if (!fields.includes(fname)) fields.push(fname);
          }
        }
      }
    }

    if (fields.length > 0) {
      responses.push({ statusCode, fields });
    }
  });

  if (responses.length === 0) return null;

  // Pick primary success response (lowest 2xx); fall back to first found
  const successResponses = responses.filter((r) => r.statusCode >= 200 && r.statusCode < 300);
  const primary =
    successResponses.length > 0
      ? successResponses.reduce((prev, curr) => (curr.statusCode < prev.statusCode ? curr : prev))
      : responses[0];

  return {
    statusCode: primary.statusCode,
    schema: { fields: primary.fields },
  };
}

// ─── Role Extraction ──────────────────────────────────────────────────────────

function extractRolesFromAction(fn: TSESTree.FunctionLike): string[] {
  const roles: string[] = [];
  const body = getFunctionBody(fn);
  if (!body) return roles;

  walkAst(body, (node) => {
    // requireRole(request, ['admin', 'doctor'])
    // requireRole(request, ["admin"])
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      /requirerole|requirepermission|requireaccess/i.test((node.callee as TSESTree.Identifier).name)
    ) {
      // Second argument should be an array of string literals
      const rolesArg = node.arguments[1];
      if (rolesArg?.type === "ArrayExpression") {
        for (const el of (rolesArg as TSESTree.ArrayExpression).elements) {
          if (el?.type === "Literal" && typeof (el as TSESTree.Literal).value === "string") {
            const role = String((el as TSESTree.Literal).value);
            if (!roles.includes(role)) roles.push(role);
          }
        }
      }
    }
  });

  return roles;
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

function getFunctionBody(
  fn: TSESTree.FunctionLike
): TSESTree.BlockStatement | null {
  if (fn.body?.type === "BlockStatement") {
    return fn.body as TSESTree.BlockStatement;
  }
  return null;
}

function isFunctionLike(node: TSESTree.Node): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  );
}

type AstVisitor = (node: TSESTree.Node) => void;

function walkAst(node: TSESTree.Node, visitor: AstVisitor): void {
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && "type" in item) {
            walkAst(item as TSESTree.Node, visitor);
          }
        }
      } else if ("type" in (child as object)) {
        walkAst(child as TSESTree.Node, visitor);
      }
    }
  }
}

// ─── End of Remix Extractor ──────────────────────────────────────────────────
