import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { IFrameworkExtractor } from "./index";
import type { ParsedFile } from "../parser";
import type { PackageDetection } from "../../ingestion/detector";
import type {
  ExtractedEndpoint,
  PathParam,
  QueryParam,
  RequestBodySchema,
  ExtractorFlag,
  AuthType,
} from "../../blueprint/types";
import { walk, extractStringValue, getDecorators } from "../../utils/ast-utils";

// ─── Constants ────────────────────────────────────────────────────────────────

const HTTP_METHOD_DECORATORS = new Set([
  "Get", "Post", "Put", "Patch", "Delete", "Head", "Options", "All",
]);

const AUTH_GUARD_RE = /auth|jwt|bearer|session/i;

let epCounter = 0;
function nextId(): string {
  return `nestjs_ep_${String(++epCounter).padStart(3, "0")}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePath(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .map((p) => p.replace(/^\/+/, "").replace(/\/+$/, ""))
    .join("/");
  return "/" + joined.replace(/\/+/g, "/");
}

function nestHttpMethod(decorator: string): ExtractedEndpoint["method"] {
  const map: Record<string, ExtractedEndpoint["method"]> = {
    Get: "GET",
    Post: "POST",
    Put: "PUT",
    Patch: "PATCH",
    Delete: "DELETE",
    Head: "HEAD",
    Options: "OPTIONS",
    All: "ALL",
  };
  return map[decorator] ?? "GET";
}

function extractDecoratorStringArg(decorator: TSESTree.Decorator): string | null {
  const expr = decorator.expression;
  if (expr.type !== "CallExpression") return null;
  const args = expr.arguments;
  if (args.length === 0) return null;
  const first = args[0];
  if (first.type === "Literal" && typeof first.value === "string") return first.value;
  if (first.type === "ObjectExpression") {
    for (const prop of first.properties) {
      if (
        prop.type === "Property" &&
        prop.key.type === "Identifier" &&
        prop.key.name === "path" &&
        prop.value.type === "Literal" &&
        typeof prop.value.value === "string"
      ) {
        return prop.value.value;
      }
    }
  }
  return null;
}

function extractDecoratorObjectProp(
  decorator: TSESTree.Decorator,
  prop: string
): string | null {
  const expr = decorator.expression;
  if (expr.type !== "CallExpression") return null;
  const args = expr.arguments;
  if (args.length === 0) return null;
  const arg = args[0];
  if (arg.type !== "ObjectExpression") return null;
  for (const p of arg.properties) {
    if (
      p.type === "Property" &&
      p.key.type === "Identifier" &&
      p.key.name === prop &&
      p.value.type === "Literal" &&
      typeof p.value.value === "string"
    ) {
      return p.value.value;
    }
  }
  return null;
}

function getDecoratorName(decorator: TSESTree.Decorator): string | null {
  const expr = decorator.expression;
  if (expr.type === "Identifier") return expr.name;
  if (expr.type === "CallExpression") {
    if (expr.callee.type === "Identifier") return expr.callee.name;
    if (
      expr.callee.type === "MemberExpression" &&
      expr.callee.property.type === "Identifier"
    ) {
      return expr.callee.property.name;
    }
  }
  return null;
}

function extractParamsFromPath(routePath: string): PathParam[] {
  const params: PathParam[] = [];
  for (const seg of routePath.split("/")) {
    if (seg.startsWith(":")) {
      const name = seg.slice(1).replace(/[?*+]$/, "");
      params.push({ name, type: "string", example: `test-${name}` });
    } else if (seg.startsWith(":")) {
      // NestJS style :paramName
      const name = seg.slice(1);
      params.push({ name, type: "string", example: `test-${name}` });
    }
  }
  return params;
}

// ─── DTO extraction ───────────────────────────────────────────────────────────

interface DtoField {
  name: string;
  type: string;
  required: boolean;
  validators: string[];
  example: string | null;
}

const CLASS_VALIDATOR_FIELD_DECORATORS = new Set([
  "IsString", "IsNumber", "IsInt", "IsBoolean", "IsEmail", "IsUUID",
  "IsEnum", "IsDate", "IsArray", "IsObject",
  "IsOptional", "IsNotEmpty", "MinLength", "MaxLength", "Min", "Max",
  "IsUrl", "IsPhoneNumber", "IsPositive", "IsNegative",
]);

function extractDtoFromClass(
  className: string,
  allFiles: ParsedFile[],
  visited = new Set<string>()
): RequestBodySchema | null {
  if (visited.has(className)) return null;
  visited.add(className);

  for (const pf of allFiles) {
    const fields: DtoField[] = [];
    let found = false;

    walk(pf.ast, (node) => {
      if (
        node.type !== "ClassDeclaration" ||
        !node.id ||
        node.id.name !== className
      ) {
        return;
      }
      found = true;

      for (const member of node.body.body) {
        if (member.type !== "PropertyDefinition") continue;
        if (!member.key || member.key.type !== "Identifier") continue;

        const fieldName = member.key.name;
        const decorators = getDecorators(member);
        const decoratorNames = decorators.map((d) => getDecoratorName(d)).filter(Boolean) as string[];

        const isOptional = decoratorNames.includes("IsOptional");
        const validators: string[] = decoratorNames.filter((d) => CLASS_VALIDATOR_FIELD_DECORATORS.has(d));

        // Determine type
        let fieldType = "string";
        if (member.typeAnnotation?.typeAnnotation) {
          const ta = member.typeAnnotation.typeAnnotation;
          if (ta.type === "TSStringKeyword") fieldType = "string";
          else if (ta.type === "TSNumberKeyword") fieldType = "number";
          else if (ta.type === "TSBooleanKeyword") fieldType = "boolean";
          else if (ta.type === "TSTypeReference" && ta.typeName.type === "Identifier") {
            fieldType = ta.typeName.name;
          }
        }
        if (decoratorNames.includes("IsEmail")) fieldType = "email";
        if (decoratorNames.includes("IsUUID")) fieldType = "uuid";
        if (decoratorNames.includes("IsNumber") || decoratorNames.includes("IsInt")) fieldType = "number";
        if (decoratorNames.includes("IsBoolean")) fieldType = "boolean";

        // Example from @ApiProperty({ example: ... })
        let example: string | null = null;
        for (const dec of decorators) {
          if (getDecoratorName(dec) === "ApiProperty") {
            const expr = dec.expression;
            if (expr.type === "CallExpression" && expr.arguments.length > 0) {
              const arg = expr.arguments[0];
              if (arg.type === "ObjectExpression") {
                for (const prop of arg.properties) {
                  if (
                    prop.type === "Property" &&
                    prop.key.type === "Identifier" &&
                    prop.key.name === "example"
                  ) {
                    example = extractStringValue(prop.value as TSESTree.Node);
                  }
                }
              }
            }
          }
        }

        fields.push({
          name: fieldName,
          type: fieldType,
          required: !isOptional && !member.optional,
          validators,
          example,
        });
      }
    });

    if (found && fields.length > 0) {
      return {
        source: "class-validator",
        fields: fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required,
          validators: f.validators,
          example: f.example,
        })),
        rawSchemaRef: className,
      };
    }
  }

  return null;
}

// ─── Phase E: Global prefix + versioning from main.ts ────────────────────────

interface BootstrapConfig {
  globalPrefix: string;
  versioningEnabled: boolean;
  versioningType: "URI" | "HEADER" | "MEDIA_TYPE" | null;
}

function extractBootstrapConfig(allFiles: ParsedFile[]): BootstrapConfig {
  const config: BootstrapConfig = {
    globalPrefix: "",
    versioningEnabled: false,
    versioningType: null,
  };

  // Search for main.ts / bootstrap function
  const mainFiles = allFiles.filter((f) =>
    f.filePath.endsWith("main.ts") || f.filePath.endsWith("main.js")
  );

  for (const pf of mainFiles) {
    walk(pf.ast, (node) => {
      if (node.type !== "ExpressionStatement") return;
      const expr = node.expression;
      if (expr.type !== "CallExpression") return;
      if (expr.callee.type !== "MemberExpression") return;
      const prop = expr.callee.property;
      if (prop.type !== "Identifier") return;

      if (prop.name === "setGlobalPrefix" && expr.arguments.length > 0) {
        const val = extractStringValue(expr.arguments[0] as TSESTree.Node);
        if (val) config.globalPrefix = val;
      }

      if (prop.name === "enableVersioning") {
        config.versioningEnabled = true;
        // Try to detect type
        if (expr.arguments.length > 0) {
          const arg = expr.arguments[0];
          if (arg.type === "ObjectExpression") {
            for (const p of arg.properties) {
              if (
                p.type === "Property" &&
                p.key.type === "Identifier" &&
                p.key.name === "type"
              ) {
                const val = extractStringValue(p.value as TSESTree.Node);
                if (val) {
                  if (val.includes("URI") || val.includes("uri")) {
                    config.versioningType = "URI";
                  } else if (val.includes("HEADER") || val.includes("header")) {
                    config.versioningType = "HEADER";
                  } else if (val.includes("MEDIA") || val.includes("media")) {
                    config.versioningType = "MEDIA_TYPE";
                  }
                }
                // Check MemberExpression like VersioningType.URI
                if (
                  p.value.type === "MemberExpression" &&
                  p.value.property.type === "Identifier"
                ) {
                  const name = p.value.property.name;
                  if (name === "URI") config.versioningType = "URI";
                  else if (name === "HEADER") config.versioningType = "HEADER";
                  else if (name === "MEDIA_TYPE") config.versioningType = "MEDIA_TYPE";
                }
              }
            }
          }
        }
        if (!config.versioningType) config.versioningType = "URI";
      }
    });
  }

  return config;
}

// ─── Main Extractor ───────────────────────────────────────────────────────────

interface ControllerInfo {
  className: string;
  basePath: string;
  version: string | null;
  classGuards: string[];
  classIsPublic: boolean;
  classRoles: string[];
  sourceFile: string;
}

interface MethodInfo {
  methodName: string;
  httpDecorator: string;
  routePath: string;
  version: string | null;
  guards: string[];
  isPublic: boolean;
  roles: string[];
  pathParams: PathParam[];
  queryParams: QueryParam[];
  requestBody: RequestBodySchema | null;
  sourceLine: number;
}

function extractControllers(files: ParsedFile[]): ControllerInfo[] {
  const controllers: ControllerInfo[] = [];

  for (const pf of files) {
    walk(pf.ast, (node) => {
      if (node.type !== "ClassDeclaration" || !node.id) return;

      const decorators = getDecorators(node);
      const controllerDec = decorators.find((d) => getDecoratorName(d) === "Controller");
      if (!controllerDec) return;

      const basePath = extractDecoratorStringArg(controllerDec) ?? "";
      const version = extractDecoratorObjectProp(controllerDec, "version");

      // Class-level guards
      const classGuards: string[] = [];
      let classIsPublic = false;
      const classRoles: string[] = [];

      for (const dec of decorators) {
        const name = getDecoratorName(dec);
        if (name === "UseGuards") {
          const expr = dec.expression;
          if (expr.type === "CallExpression") {
            for (const arg of expr.arguments) {
              if (arg.type === "Identifier") classGuards.push(arg.name);
            }
          }
        }
        if (name === "Public") classIsPublic = true;
        if (name === "Roles") {
          const expr = dec.expression;
          if (expr.type === "CallExpression") {
            for (const arg of expr.arguments) {
              const v = extractStringValue(arg as TSESTree.Node);
              if (v) classRoles.push(v);
            }
          }
        }
      }

      controllers.push({
        className: node.id.name,
        basePath,
        version,
        classGuards,
        classIsPublic,
        classRoles,
        sourceFile: pf.filePath,
      });
    });
  }

  return controllers;
}

function extractMethods(
  controllerInfo: ControllerInfo,
  files: ParsedFile[],
  allFiles: ParsedFile[]
): MethodInfo[] {
  const methods: MethodInfo[] = [];

  const sourceFile = files.find((f) => f.filePath === controllerInfo.sourceFile);
  if (!sourceFile) return methods;

  walk(sourceFile.ast, (node) => {
    if (node.type !== "ClassDeclaration" || !node.id) return;
    if (node.id.name !== controllerInfo.className) return;

    for (const member of node.body.body) {
      if (
        member.type !== "MethodDefinition" &&
        member.type !== "PropertyDefinition"
      ) continue;
      if (member.type !== "MethodDefinition") continue;

      const decorators = getDecorators(member);

      // Find HTTP method decorator
      const httpDec = decorators.find((d) => {
        const name = getDecoratorName(d);
        return name !== null && HTTP_METHOD_DECORATORS.has(name);
      });
      if (!httpDec) continue;

      const httpDecName = getDecoratorName(httpDec)!;
      const routePath = extractDecoratorStringArg(httpDec) ?? "";

      // Method-level version override
      const versionDec = decorators.find((d) => getDecoratorName(d) === "Version");
      const version = versionDec ? extractDecoratorStringArg(versionDec) : null;

      // Method guards, @Public, @Roles
      const guards: string[] = [];
      let isPublic = false;
      const roles: string[] = [];

      for (const dec of decorators) {
        const name = getDecoratorName(dec);
        if (name === "UseGuards") {
          const expr = dec.expression;
          if (expr.type === "CallExpression") {
            for (const arg of expr.arguments) {
              if (arg.type === "Identifier") guards.push(arg.name);
            }
          }
        }
        if (name === "Public") isPublic = true;
        if (name === "Roles") {
          const expr = dec.expression;
          if (expr.type === "CallExpression") {
            for (const arg of expr.arguments) {
              const v = extractStringValue(arg as TSESTree.Node);
              if (v) roles.push(v);
            }
          }
        }
      }

      // Phase D: Extract parameter decorators from method params
      const pathParams: PathParam[] = [];
      const queryParams: QueryParam[] = [];
      let requestBody: RequestBodySchema | null = null;

      if (member.value && member.value.type === "FunctionExpression") {
        for (const param of member.value.params) {
          const paramDecorators = getDecorators(param);
          for (const dec of paramDecorators) {
            const decName = getDecoratorName(dec);
            const argVal = extractDecoratorStringArg(dec);

            if (decName === "Param") {
              // Get TypeScript type annotation
              let pType: PathParam["type"] = "string";
              if (
                param.type === "Identifier" &&
                param.typeAnnotation?.typeAnnotation
              ) {
                const ta = param.typeAnnotation.typeAnnotation;
                if (ta.type === "TSNumberKeyword") pType = "number";
                if (ta.type === "TSStringKeyword") pType = "string";
              }
              if (argVal) {
                pathParams.push({
                  name: argVal,
                  type: pType,
                  example: pType === "number" ? "1" : `test-${argVal}`,
                });
              }
            }

            if (decName === "Query") {
              let qType = "string";
              let dtoName: string | null = null;
              if (
                param.type === "Identifier" &&
                param.typeAnnotation?.typeAnnotation
              ) {
                const ta = param.typeAnnotation.typeAnnotation;
                if (ta.type === "TSNumberKeyword") qType = "number";
                else if (ta.type === "TSBooleanKeyword") qType = "boolean";
                else if (
                  ta.type === "TSTypeReference" &&
                  ta.typeName.type === "Identifier"
                ) {
                  dtoName = ta.typeName.name;
                }
              }
              if (argVal) {
                queryParams.push({ name: argVal, type: qType, required: false });
              } else if (dtoName) {
                const schema = extractDtoFromClass(dtoName, allFiles);
                if (schema) {
                  for (const f of schema.fields) {
                    queryParams.push({
                      name: f.name,
                      type: f.type,
                      required: f.required,
                    });
                  }
                }
              }
            }

            if (decName === "Body") {
              // Determine DTO class name from type annotation
              let dtoName: string | null = null;
              if (
                param.type === "Identifier" &&
                param.typeAnnotation?.typeAnnotation
              ) {
                const ta = param.typeAnnotation.typeAnnotation;
                if (
                  ta.type === "TSTypeReference" &&
                  ta.typeName.type === "Identifier"
                ) {
                  dtoName = ta.typeName.name;
                }
              }
              if (dtoName) {
                requestBody = extractDtoFromClass(dtoName, allFiles);
                if (!requestBody && argVal) {
                  // Partial body field from @Body('email') email: string
                  requestBody = {
                    source: "inferred",
                    fields: [
                      {
                        name: argVal,
                        type: "string",
                        required: true,
                        validators: [],
                        example: null,
                      },
                    ],
                    rawSchemaRef: null,
                  };
                }
              } else if (argVal) {
                requestBody = {
                  source: "inferred",
                  fields: [
                    {
                      name: argVal,
                      type: "string",
                      required: true,
                      validators: [],
                      example: null,
                    },
                  ],
                  rawSchemaRef: null,
                };
              }
            }
          }
        }
      }

      // Merge path params from route string
      const routePathParams = extractParamsFromPath(routePath);
      for (const rp of routePathParams) {
        if (!pathParams.find((p) => p.name === rp.name)) {
          pathParams.push(rp);
        }
      }

      methods.push({
        methodName:
          member.key.type === "Identifier" ? member.key.name : "unknown",
        httpDecorator: httpDecName,
        routePath,
        version,
        guards,
        isPublic,
        roles,
        pathParams,
        queryParams,
        requestBody,
        sourceLine: member.loc?.start.line ?? 0,
      });
    }
  });

  return methods;
}

// ─── NestJS Extractor Class ───────────────────────────────────────────────────

class NestJSExtractor implements IFrameworkExtractor {
  readonly framework = "nestjs" as const;

  canHandle(detection: PackageDetection): boolean {
    return detection.backendFrameworks.includes("nestjs");
  }

  async extract(
    files: ParsedFile[],
    _detection: PackageDetection
  ): Promise<ExtractedEndpoint[]> {
    const endpoints: ExtractedEndpoint[] = [];

    // Phase E: Get global prefix + versioning config
    const bootstrapConfig = extractBootstrapConfig(files);

    // Phase A: Find all controllers
    const controllers = extractControllers(files);

    // Phase B + C + D: Extract methods per controller
    for (const ctrl of controllers) {
      const methods = extractMethods(ctrl, files, files);

      for (const method of methods) {
        // Determine effective version
        const version = method.version ?? ctrl.version;
        let versionPrefix = "";
        if (
          version &&
          bootstrapConfig.versioningEnabled &&
          bootstrapConfig.versioningType === "URI"
        ) {
          versionPrefix = `v${version}`;
        }

        // Full path: globalPrefix / versionPrefix / controllerBase / methodRoute
        const fullPath = normalizePath(
          bootstrapConfig.globalPrefix,
          versionPrefix,
          ctrl.basePath,
          method.routePath
        );

        // Phase C: Resolve auth
        const combinedGuards = [...ctrl.classGuards, ...method.guards];
        const isPublic = method.isPublic || ctrl.classIsPublic;
        const combinedRoles = [...ctrl.classRoles, ...method.roles];

        let authRequired = combinedGuards.length > 0 && !isPublic;
        let authType: AuthType | null = null;

        if (authRequired) {
          const guardStr = combinedGuards.join(" ");
          if (AUTH_GUARD_RE.test(guardStr)) {
            authType = "bearer_jwt";
          }
        }

        // Confidence scoring
        const flags: ExtractorFlag[] = [];
        let confidence = 0.85;
        if (fullPath.includes("*")) {
          flags.push("WILDCARD_HANDLER");
          confidence -= 0.1;
        }
        if (method.requestBody === null && ["POST", "PUT", "PATCH"].includes(nestHttpMethod(method.httpDecorator))) {
          confidence -= 0.05;
        }

        endpoints.push({
          id: nextId(),
          method: nestHttpMethod(method.httpDecorator),
          path: fullPath,
          pathParams: method.pathParams,
          queryParams: method.queryParams,
          requestBody: method.requestBody,
          responseSchema: null,
          authRequired,
          authType,
          roles: combinedRoles,
          sourceFile: ctrl.sourceFile,
          sourceLine: method.sourceLine,
          framework: "nestjs",
          confidence,
          flags,
        });
      }
    }

    return endpoints;
  }
}

export const nestjsExtractor = new NestJSExtractor();
