import type {
  AuthLibrary,
  BackendFramework,
  FrontendFramework,
  RouterLibrary,
  SchemaLibrary,
} from "../ingestion/detector";

// ─── Auth ─────────────────────────────────────────────────────────────────────

export type AuthType =
  | "bearer_jwt"
  | "api_key_header"
  | "api_key_query"
  | "basic_auth"
  | "session_cookie"
  | "next_auth"
  | "firebase"
  | "supabase"
  | "clerk"
  | "oauth_bearer"
  | "oauth_sso"; // SAML / OIDC / OAuth2 (Azure AD, Okta, Auth0, etc.) — requires storageState-based auth

// ─── Extractor primitives ─────────────────────────────────────────────────────

export type ExtractorFlag =
  | "CONDITIONAL_ROUTE"
  | "DYNAMIC_PATH"
  | "UNRESOLVED_PREFIX"
  | "WILDCARD_HANDLER"
  | "PROXY_ROUTE"
  | "FILE_UPLOAD"
  | "WEBSOCKET"
  | "STREAM_RESPONSE"
  | "BRITTLE"
  | "DYNAMIC_TESTID"
  | "CONDITIONAL_ELEMENT"
  | "DYNAMIC_LIST"
  | "AUTH_INHERITED_FROM_LAYOUT"
  | "DYNAMIC_PROP";

export interface PathParam {
  name: string;
  type: "string" | "number" | "uuid" | "unknown";
  example: string;
}

export interface QueryParam {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  enum?: string[];
}

export interface BodyField {
  name: string;
  type: string;
  required: boolean;
  validators: string[];
  example: string | null;
}

export interface RequestBodySchema {
  source:
    | "zod"
    | "joi"
    | "yup"
    | "class-validator"
    | "typescript"
    | "inferred";
  fields: BodyField[];
  rawSchemaRef: string | null;
}

export interface ResponseSchema {
  statusCode: number;
  schema: unknown | null;
}

// ─── Extracted endpoint ───────────────────────────────────────────────────────

export interface ExtractedEndpoint {
  id: string;
  method:
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS"
    | "ALL";
  path: string;
  pathParams: PathParam[];
  queryParams: QueryParam[];
  requestBody: RequestBodySchema | null;
  responseSchema: ResponseSchema | null;
  authRequired: boolean;
  authType: AuthType | null;
  roles: string[];
  sourceFile: string;
  sourceLine: number;
  framework: BackendFramework;
  confidence: number;
  flags: ExtractorFlag[];
  /**
   * true  → Remix/Next.js route file has a default React component export → returns HTML (SSR)
   * false/undefined → resource route → returns JSON
   * NEVER call response.json() on a page route — it returns HTML and will throw a parse error.
   */
  isPageRoute?: boolean;
}

// ─── Auth config ──────────────────────────────────────────────────────────────

export interface AuthConfig {
  loginEndpoint: string;
  /**
   * How the login endpoint reads credentials.
   * - "json"  → reads JSON body (req.body / request.json()) — use Playwright `data:` option
   * - "form"  → reads form-encoded body (request.formData() / urlencoded) — use Playwright `form:` option
   * Detected from the login handler source; defaults to "json" when uncertain.
   */
  loginBodyFormat: "json" | "form";
  credentialsFields: {
    emailField: string;
    passwordField: string;
    emailEnvVar: string;
    passwordEnvVar: string;
  };
  tokenResponsePath: string | null;
  tokenType: AuthType;
  tokenHeaderName: string;
  tokenHeaderFormat: string;
  refreshEndpoint: string | null;
  authCookieName: string | null;
  /** Admin email extracted from repo seed file — use as SMOKE_TEST_EMAIL fallback */
  defaultEmail?: string;
  /** Admin password extracted from repo seed file — use as SMOKE_TEST_PASSWORD fallback */
  defaultPassword?: string;
}

// ─── UI / locator types ───────────────────────────────────────────────────────

export interface NavigationLink {
  text: string;
  href: string;
  locatorCode: string;
}

export interface ExtractedLocator {
  id: string;
  name: string;
  playwrightCode: string;
  strategy:
    | "testId"
    | "role"
    | "label"
    | "placeholder"
    | "altText"
    | "css"
    | "text";
  elementType:
    | "button"
    | "input"
    | "link"
    | "select"
    | "textarea"
    | "form"
    | "heading"
    | "other";
  isInteractive: boolean;
  isConditional: boolean;
  isDynamic: boolean;
  confidence: number;
  flags: ExtractorFlag[];
}

export interface FormStep {
  order: number;
  action:
    | "fill"
    | "click"
    | "check"
    | "uncheck"
    | "select"
    | "upload"
    | "clear";
  locatorCode: string;
  testValue: string | null;
  fieldType: string;
}

export interface FormFlow {
  id: string;
  name: string;
  testId: string | null;
  steps: FormStep[];
  linkedEndpointId: string | null;
  successRedirectHint: string | null;
}

export interface ExtractedPage {
  id: string;
  route: string;
  normalizedRoute: string;
  title: string;
  filePath: string;
  authRequired: boolean;
  roles: string[];
  isDynamic: boolean;
  routeParams: Array<{ name: string; example: string }>;
  locators: ExtractedLocator[];
  formFlows: FormFlow[];
  navigationLinks: NavigationLink[];
  linkedEndpoints: string[];
  confidence: number;
}

// ─── Test data hints ──────────────────────────────────────────────────────────

export interface TestDataHints {
  emailFormat: string;
  passwordFormat: string;
  uuidExample: string;
  numberExample: number;
  stringExample: string;
}

// ─── Top-level blueprint ──────────────────────────────────────────────────────

export interface TestBlueprint {
  repoUrl: string;
  repoName: string;
  analysisTimestamp: string;
  smokeforgeVersion: string;
  frameworks: {
    backend: BackendFramework[];
    frontend: FrontendFramework[];
    schemas: SchemaLibrary[];
    auth: AuthLibrary[];
    router: RouterLibrary[];
  };
  auth: AuthConfig | null;
  endpoints: ExtractedEndpoint[];
  pages: ExtractedPage[];
  baseUrlEnvVar: string;
  testDataHints: TestDataHints;
}
