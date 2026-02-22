import * as fs from "fs";
import * as path from "path";
import type { TSESTree } from "@typescript-eslint/typescript-estree";
import type { ParsedFile } from "../parser";
import type { AuthConfig, AuthType, ExtractedEndpoint } from "../../blueprint/types";
import { walk, extractStringValue } from "../../utils/ast-utils";
import { warn } from "../../utils/logger";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LOGIN_PATH_RE =
  /\/(auth\/login|login|auth\/signin|signin|api\/auth\/login|api\/v\d+\/auth\/login|api\/auth\/token|token)$/i;
const REFRESH_PATH_RE = /\/(auth\/refresh|refresh|refresh-token|api\/auth\/refresh)$/i;

/** Walk all nodes and look for string literals matching pattern */
function containsStringPattern(ast: TSESTree.Node, pattern: RegExp): boolean {
  let found = false;
  walk(ast, (node) => {
    if (found) return;
    if (node.type === "Literal" && typeof (node as TSESTree.Literal).value === "string") {
      if (pattern.test((node as TSESTree.Literal).value as string)) found = true;
    }
  });
  return found;
}

// ─── SSO / OAuth package & env detection (runs before AST walking) ─────────────

/**
 * Detects SSO/OAuth auth by scanning:
 *  1. package.json dependencies for SAML/OIDC/OAuth packages  (reads from disk directly)
 *  2. .env/.env.example for SSO-specific config keys          (reads from disk directly)
 *  3. Route filenames for OAuth callback patterns             (AST file list)
 *  4. Import statements in parsed TypeScript/JS files        (AST import scan)
 *
 * Works for any framework — Express, Remix, Next.js, Hono, Koa, etc.
 * Should be called BEFORE AST-based detection since SSO takes priority.
 *
 * @param files     Parsed TS/JS source files (ANALYZABLE_EXTENSIONS only)
 * @param repoPath  Root of the repo on disk — lets us read package.json / .env directly
 */
function detectSSOFromRawFiles(files: ParsedFile[], repoPath?: string): AuthType | null {
  const ssoPackageRe =
    /^(passport-saml|passport-azure-ad|passport-openidconnect|passport-okta|passport-oauth2?|openid-client|@azure\/msal-node|@azure\/msal-browser|@auth0\/nextjs-auth0|@auth0\/auth0-spa-js|node-saml|samlify|passport-wsfed-saml2|oidc-client|oidc-client-ts|@okta\/oidc-middleware|keycloak-connect|aws-amplify)$/;
  const ssoEnvKeyRe =
    /^(SAML_|AZURE_AD_|AZURE_CLIENT_|OKTA_DOMAIN|OKTA_CLIENT|OIDC_ISSUER|OIDC_CLIENT|AUTH0_DOMAIN|AUTH0_CLIENT|KEYCLOAK_|COGNITO_|CLIENT_SECRET|OAUTH_CLIENT|OAUTH_SECRET|SSO_)/im;

  // ── 1a. package.json — read directly from disk (most reliable) ────────────
  if (repoPath) {
    // Scan the repo root + up to 2 workspace subdirs for package.json
    const searchDirs = [repoPath];
    try {
      const entries = fs.readdirSync(repoPath, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !/(node_modules|\.git|dist|build)/.test(e.name)) {
          searchDirs.push(path.join(repoPath, e.name));
        }
      }
    } catch { /* ignore */ }

    for (const dir of searchDirs) {
      const pkgPath = path.join(dir, "package.json");
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
        const allDeps = {
          ...((pkg["dependencies"] as Record<string, string>) ?? {}),
          ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
          ...((pkg["peerDependencies"] as Record<string, string>) ?? {}),
        };
        if (Object.keys(allDeps).some((k) => ssoPackageRe.test(k))) {
          return "oauth_sso";
        }
      } catch { /* file absent or invalid JSON — skip */ }
    }

    // .env / .env.example / .env.local — read directly from disk
    const envFileNames = [".env", ".env.example", ".env.local", ".env.production"];
    for (const dir of [repoPath]) {
      for (const envName of envFileNames) {
        try {
          const content = fs.readFileSync(path.join(dir, envName), "utf-8");
          if (ssoEnvKeyRe.test(content)) return "oauth_sso";
        } catch { /* not found — skip */ }
      }
    }
  }

  // ── 1b. package.json — fallback: search in already-parsed JSON files ───────
  // (covers cases where repoPath is not passed)
  const pkgFile = files.find((f) => /[/\\]package\.json$/.test(f.filePath));
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.code) as Record<string, unknown>;
      const allDeps = {
        ...((pkg["dependencies"] as Record<string, string>) ?? {}),
        ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
        ...((pkg["peerDependencies"] as Record<string, string>) ?? {}),
      };
      if (Object.keys(allDeps).some((k) => ssoPackageRe.test(k))) {
        return "oauth_sso";
      }
    } catch { /* not valid JSON — skip */ }
  }

  // ── 2. .env / .env.example key scan (fallback from parsed files) ─────────
  const envFiles = files.filter((f) =>
    /\.env(\.\w+)?$/.test(path.basename(f.filePath))
  );
  for (const envFile of envFiles) {
    if (ssoEnvKeyRe.test(envFile.code)) return "oauth_sso";
  }

  // ── 3. OAuth callback route filename pattern (from AST file list) ─────────
  const ssoCallbackRouteRe =
    /auth\.(saml|oidc|azure|okta|oauth|callback|sso|google|github|facebook|microsoft)\./i;
  if (files.some((f) => ssoCallbackRouteRe.test(path.basename(f.filePath)))) {
    return "oauth_sso";
  }

  // ── 4. Import statement scan — import from SSO packages ───────────────────
  for (const file of files) {
    for (const node of (file.ast as any).body ?? []) {
      if (node.type === "ImportDeclaration") {
        const src = String(node.source?.value ?? "");
        if (ssoPackageRe.test(src.replace(/\/.*$/, ""))) return "oauth_sso";
      }
    }
  }

  return null;
}

// ─── Per-library auth type detection ─────────────────────────────────────────

function detectAuthTypeForFile(file: ParsedFile): AuthType | null {
  let detected: AuthType | null = null;

  walk(file.ast, (node) => {
    if (detected) return;

    // ── Remix/session: createCookieSessionStorage / createSessionStorage → session_cookie
    // This must fire BEFORE any bearer_jwt heuristic, since Remix apps also use bcrypt
    // and may contain string literals like "authorization" in error messages.
    if (node.type === "CallExpression") {
      const call = node as TSESTree.CallExpression;
      if (
        call.callee.type === "Identifier" &&
        /^createCookieSessionStorage$|^createSessionStorage$/.test(
          (call.callee as TSESTree.Identifier).name
        )
      ) {
        detected = "session_cookie";
        return;
      }
    }

    // ── Remix: import { createCookieSessionStorage } from "@remix-run/node"
    if (
      node.type === "ImportDeclaration" &&
      /^@remix-run\/(node|server-runtime)$/.test(
        (node as TSESTree.ImportDeclaration).source.value as string
      )
    ) {
      const decl = node as TSESTree.ImportDeclaration;
      const hasSessionImport = decl.specifiers.some(
        (s) =>
          s.type === "ImportSpecifier" &&
          /createCookieSessionStorage|createSessionStorage|commitSession|getSession/.test(
            (s as TSESTree.ImportSpecifier).imported.type === "Identifier"
              ? ((s as TSESTree.ImportSpecifier).imported as TSESTree.Identifier).name
              : ""
          )
      );
      if (hasSessionImport) {
        detected = "session_cookie";
        return;
      }
    }

    // passport.use(new XxxStrategy(...)) — covers all strategy types
    if (
      node.type === "CallExpression" &&
      (node as TSESTree.CallExpression).callee.type === "MemberExpression"
    ) {
      const call = node as TSESTree.CallExpression;
      const callee = call.callee as TSESTree.MemberExpression;
      if (
        callee.property.type === "Identifier" &&
        callee.property.name === "use" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "passport"
      ) {
        const firstArg = call.arguments[0];
        if (
          firstArg?.type === "NewExpression" &&
          (firstArg as TSESTree.NewExpression).callee.type === "Identifier"
        ) {
          const ctorName = ((firstArg as TSESTree.NewExpression).callee as TSESTree.Identifier).name;
          if (/SamlStrategy|OIDCStrategy|OAuthStrategy|OAuth2Strategy|AzureAdOAuth2Strategy|GoogleStrategy|GithubStrategy|FacebookStrategy|TwitterStrategy|MicrosoftStrategy|KeycloakStrategy|CognitoStrategy|Auth0Strategy|WsFedStrategy/i.test(ctorName)) {
            detected = "oauth_sso";
          } else if (/JwtStrategy/i.test(ctorName)) {
            detected = "bearer_jwt";
          } else if (/LocalStrategy/i.test(ctorName)) {
            detected = "session_cookie";
          } else if (/BearerStrategy/i.test(ctorName)) {
            detected = "bearer_jwt";
          }
        }
        return;
      }

      // passport.authenticate('saml'|'oidc'|'google'|...) → oauth_sso
      // passport.authenticate('jwt') → bearer_jwt
      if (
        callee.property.type === "Identifier" &&
        callee.property.name === "authenticate" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "passport"
      ) {
        const firstArg = call.arguments[0];
        if (firstArg) {
          const stratName = extractStringValue(firstArg as TSESTree.Node);
          if (stratName) {
            if (/^(saml|oidc|google|github|facebook|twitter|microsoft|azure|okta|auth0|oauth|oauth2|keycloak|cognito|wsfed|sso)$/i.test(stratName)) {
              detected = "oauth_sso";
            } else if (stratName === "jwt" || stratName === "bearer") {
              detected = "bearer_jwt";
            } else if (stratName === "local") {
              detected = "session_cookie";
            }
          }
        }
        return;
      }
    }

    // import from SSO-related packages → oauth_sso
    // import express-session / koa-session → session_cookie
    if (node.type === "ImportDeclaration") {
      const src = (node as TSESTree.ImportDeclaration).source.value as string;
      if (
        /^(passport-saml|passport-azure-ad|passport-openidconnect|passport-okta|passport-oauth2?|openid-client|@azure\/msal-node|@azure\/msal-browser|@auth0\/nextjs-auth0|@auth0\/auth0-spa-js|node-saml|samlify|oidc-client|oidc-client-ts|@okta\/oidc-middleware|keycloak-connect|aws-amplify)/.test(src)
      ) {
        detected = "oauth_sso";
        return;
      }
      // Plain session-based auth (express-session, koa-session, iron-session, etc.)
      if (/^(express-session|koa-session|@fastify\/session|iron-session|cookie-session)$/.test(src)) {
        detected = "session_cookie";
        return;
      }
    }

    // jwt.verify(token, secret) → bearer_jwt
    if (node.type === "CallExpression") {
      const call = node as TSESTree.CallExpression;
      if (
        call.callee.type === "MemberExpression" &&
        (call.callee as TSESTree.MemberExpression).property.type === "Identifier" &&
        ((call.callee as TSESTree.MemberExpression).property as TSESTree.Identifier).name === "verify"
      ) {
        const obj = (call.callee as TSESTree.MemberExpression).object;
        if (obj.type === "Identifier" && /jwt|jose/i.test(obj.name)) {
          detected = "bearer_jwt";
          return;
        }
      }
    }

    // getServerSession → next_auth
    if (
      node.type === "CallExpression" &&
      (node as TSESTree.CallExpression).callee.type === "Identifier" &&
      /getServerSession|getToken/i.test(
        ((node as TSESTree.CallExpression).callee as TSESTree.Identifier).name
      )
    ) {
      detected = "next_auth";
      return;
    }

    // Manual header detection: req.headers.authorization → bearer_jwt
    if (
      node.type === "MemberExpression" &&
      (node as TSESTree.MemberExpression).property.type === "Identifier"
    ) {
      const prop = ((node as TSESTree.MemberExpression).property as TSESTree.Identifier).name;
      if (prop === "authorization") {
        detected = "bearer_jwt";
        return;
      }
    }

    // Manual header detection: req.headers['x-api-key'] → api_key_header
    if (
      node.type === "MemberExpression" &&
      (node as TSESTree.MemberExpression).computed
    ) {
      const propNode = (node as TSESTree.MemberExpression).property;
      const val = extractStringValue(propNode as TSESTree.Node);
      if (val && /x-api-key|apikey|api.key/i.test(val)) {
        detected = "api_key_header";
        return;
      }
    }

    // req.query.api_key → api_key_query
    if (
      node.type === "MemberExpression" &&
      (node as TSESTree.MemberExpression).property.type === "Identifier"
    ) {
      const mem = node as TSESTree.MemberExpression;
      const prop = (mem.property as TSESTree.Identifier).name;
      if (/api_key|apikey/i.test(prop) && mem.object.type === "MemberExpression") {
        const parent = mem.object as TSESTree.MemberExpression;
        if (
          parent.property.type === "Identifier" &&
          parent.property.name === "query"
        ) {
          detected = "api_key_query";
          return;
        }
      }
    }

    // Firebase detection: firebase-admin / firebase usage
    if (
      node.type === "ImportDeclaration" &&
      /firebase/i.test(((node as TSESTree.ImportDeclaration).source.value as string))
    ) {
      detected = "firebase";
      return;
    }

    // Supabase detection
    if (
      node.type === "ImportDeclaration" &&
      /supabase/i.test(((node as TSESTree.ImportDeclaration).source.value as string))
    ) {
      detected = "supabase";
      return;
    }

    // Clerk detection
    if (
      node.type === "ImportDeclaration" &&
      /clerk/i.test(((node as TSESTree.ImportDeclaration).source.value as string))
    ) {
      detected = "clerk";
      return;
    }

    // express-jwt / koa-jwt: jwt({ secret }) → bearer_jwt
    if (node.type === "CallExpression") {
      const call = node as TSESTree.CallExpression;
      if (
        call.callee.type === "Identifier" &&
        (call.callee as TSESTree.Identifier).name === "jwt"
      ) {
        detected = "bearer_jwt";
        return;
      }
    }
  });

  return detected;
}

// ─── Login endpoint detection ─────────────────────────────────────────────────

/**
 * Detect whether the login endpoint reads credentials from a form body or JSON body.
 * Signals for "form": request.formData(), formData.get(), c.req.formData(), ctx.request.formData()
 * Signals for "json": request.json(), req.body (JSON middleware), await req.json()
 * Falls back to "json" when ambiguous — the safer default for API frameworks.
 */
function detectLoginBodyFormat(loginFile: ParsedFile | undefined, tokenType: AuthType): "json" | "form" {
  // next_auth / session_cookie apps that use standard HTML forms use formData
  // but only if the handler source confirms it — check the source text directly
  if (!loginFile) {
    // No source available — guess from tokenType
    return tokenType === "session_cookie" || tokenType === "next_auth" ? "form" : "json";
  }
  const src = loginFile.code;
  // Strong "form" signals
  if (/\.formData\s*\(/.test(src)) return "form";
  if (/formData\.get\s*\(/.test(src)) return "form";
  // Strong "json" signals
  if (/request\.json\s*\(/.test(src)) return "json";
  if (/req\.json\s*\(/.test(src)) return "json";
  if (/await\s+c\.req\.json\s*\(/.test(src)) return "json";
  if (/await\s+ctx\.request\.json\s*\(/.test(src)) return "json";
  // Fallback: session/next_auth apps typically use forms; JWT apps use JSON
  return tokenType === "session_cookie" || tokenType === "next_auth" ? "form" : "json";
}

/** Detect the token response field name from a response expression */
function detectTokenFieldInAST(file: ParsedFile): string | null {
  let tokenField: string | null = null;

  walk(file.ast, (node) => {
    if (tokenField) return;
    if (node.type !== "ObjectExpression") return;
    const obj = node as TSESTree.ObjectExpression;
    for (const prop of obj.properties) {
      if (prop.type !== "Property") continue;
      const p = prop as TSESTree.Property;
      if (p.key.type === "Identifier") {
        const k = (p.key as TSESTree.Identifier).name;
        if (/^(accessToken|token|jwt|idToken|access_token|id_token)$/.test(k)) {
          tokenField = k;
          return;
        }
      }
    }
  });

  return tokenField;
}

/** Look for a json({ data: { accessToken } }) style nested token path */
function detectNestedTokenPath(file: ParsedFile): string | null {
  // Heuristic: search for patterns like { data: { accessToken: ... } }
  let path: string | null = null;

  walk(file.ast, (node) => {
    if (path) return;
    if (node.type !== "ObjectExpression") return;
    const obj = node as TSESTree.ObjectExpression;
    for (const prop of obj.properties) {
      if (prop.type !== "Property") continue;
      const p = prop as TSESTree.Property;
      if (p.key.type !== "Identifier") continue;
      const outerKey = (p.key as TSESTree.Identifier).name;
      if (p.value.type === "ObjectExpression") {
        const inner = p.value as TSESTree.ObjectExpression;
        for (const innerProp of inner.properties) {
          if (innerProp.type !== "Property") continue;
          const ip = innerProp as TSESTree.Property;
          if (ip.key.type === "Identifier") {
            const k = (ip.key as TSESTree.Identifier).name;
            if (/^(accessToken|token|jwt|idToken)$/.test(k)) {
              path = `${outerKey}.${k}`;
              return;
            }
          }
        }
      }
    }
  });

  return path;
}

// ─── Seed credential extraction ──────────────────────────────────────────────
// Scans seed/fixture files (any file with "seed" in the path) for admin credentials.
// Uses raw text patterns — works for any JS/TS project without AST walking.

function extractSeedCredentials(
  files: ParsedFile[]
): { email: string; password: string } | null {
  const seedFiles = files.filter((f) => /seed/i.test(f.filePath));

  for (const file of seedFiles) {
    const code = file.code;

    // ── Password extraction strategies (most explicit first) ──────────────────
    // 1. "all use password: Test1234!" or "password: Test1234!" comment/log
    const pwdAll =
      // const SEED_PASSWORD = "Test1234!" or DEFAULT_PASSWORD = "..."
      code.match(/(?:SEED_PASSWORD|DEFAULT_PASSWORD|SEED_PASS|DEFAULT_PASS|ADMIN_PASS(?:WORD)?)\s*=\s*['"]([^'"]{6,})['"]/i) ??
      // use\s+password: Test1234 (comment or log text)
      code.match(/use\s+password[^"'\n]*['"]([\w!@#$%^&*\-]+)['"]/i) ??
      // password: "SomeValue" (object field)
      code.match(/['"]password['"]\s*:\s*['"]([^'"]{6,})['"]/i) ??
      // bcrypt.hash("SomePassword", ...) or hashSync("SomePassword", ...)
      code.match(/hash\w*\(\s*["']([\w!@#$%^&*\-]{6,})["']/i) ??
      code.match(/bcrypt\.\w+\(\s*["']([\w!@#$%^&*\-]{6,})["']/i) ??
      // Fallback: any ALL_CAPS variable assigned a string that looks like a password
      code.match(/[A-Z_]*PASS(?:WORD)?[A-Z_]*\s*=\s*["']([A-Za-z0-9!@#$%^&*\-]{6,})["']/i);

    const password = pwdAll?.[1] ?? null;

    // ── Admin email extraction strategies ─────────────────────────────────────
    // 1. email field adjacent to role:"admin" in same object literal
    const adminEmailNearRole =
      // { email: "admin@...", ..., role: "admin" }
      code.match(
        /email:\s*["']([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})["'][^}]{0,200}role:\s*["']admin["']/is
      )?.[1] ??
      // { role: "admin", ..., email: "admin@..." }
      code.match(
        /role:\s*["']admin["'][^}]{0,200}email:\s*["']([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})["']/is
      )?.[1] ??
      // Any email string literally containing "admin"
      code.match(/["'](admin[^"'@\s]*@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})["']/i)?.[1];

    const email = adminEmailNearRole ?? null;

    if (email && password) {
      return { email, password };
    }
  }

  return null;
}

// ─── Main: detectAuth ─────────────────────────────────────────────────────────

export async function detectAuth(
  files: ParsedFile[],
  endpoints: ExtractedEndpoint[],
  repoPath?: string
): Promise<AuthConfig | null> {
  // Step 1: Determine global auth type
  // SSO detection runs FIRST (highest priority) — package.json / env file scan
  let globalAuthType: AuthType | null = detectSSOFromRawFiles(files, repoPath);

  // If no SSO package found, fall back to AST-based per-file detection
  if (!globalAuthType) {
    for (const file of files) {
      const authType = detectAuthTypeForFile(file);
      if (authType) {
        globalAuthType = authType;
        break;
      }
    }
  }

  // Step 2: Enrich endpoints in place
  for (const ep of endpoints) {
    if (ep.authRequired && ep.authType === null) {
      ep.authType = globalAuthType;
    }
    // If the endpoint uses next-auth patterns in its source file
    if (!ep.authType && globalAuthType) {
      // Check if auth is signalled at all — only set if endpoint is auth-required
      if (ep.authRequired) ep.authType = globalAuthType;
    }
  }

  // Step 3: Find login endpoint
  const loginEndpointCandidates = endpoints.filter(
    (ep) =>
      ep.method === "POST" &&
      (LOGIN_PATH_RE.test(ep.path) ||
        (ep.requestBody?.fields.some((f) => /email|username/i.test(f.name)) &&
          ep.requestBody?.fields.some((f) => /password/i.test(f.name))))
  );

  if (loginEndpointCandidates.length === 0) {
    // next_auth apps: NextAuth catches all auth via /api/auth/[...nextauth] wildcard,
    // so there may be no extractable login endpoint in the endpoint list.
    // We know the pattern: CSRF token → POST /api/auth/callback/credentials.
    if (globalAuthType === "next_auth") {
      const seedCreds = extractSeedCredentials(files);
      return {
        loginEndpoint: "POST /api/auth/callback/credentials",
        loginBodyFormat: "form",
        credentialsFields: {
          emailField: "email",
          passwordField: "password",
          emailEnvVar: "SMOKE_TEST_EMAIL",
          passwordEnvVar: "SMOKE_TEST_PASSWORD",
        },
        tokenResponsePath: null,
        tokenType: "next_auth",
        tokenHeaderName: "Cookie",
        tokenHeaderFormat: "{cookie}",
        refreshEndpoint: null,
        authCookieName: "next-auth.session-token",
        defaultEmail: seedCreds?.email,
        defaultPassword: seedCreds?.password,
      };
    }

    // SSO / OAuth apps have no traditional form-login endpoint.
    // Return a valid AuthConfig so generated tests know to use storageState.
    if (globalAuthType === "oauth_sso") {
      return {
        loginEndpoint: "N/A — SSO/OAuth redirect flow",
        loginBodyFormat: "json",
        credentialsFields: {
          emailField: "email",
          passwordField: "password",
          emailEnvVar: "SMOKE_TEST_EMAIL",
          passwordEnvVar: "SMOKE_TEST_PASSWORD",
        },
        tokenResponsePath: null,
        tokenType: "oauth_sso",
        tokenHeaderName: "Cookie",
        tokenHeaderFormat: "{storageState}",
        refreshEndpoint: null,
        authCookieName: null,
      };
    }

    warn("No login endpoint detected — auth tests will use placeholder token");
    // Still enrich remaining endpoints
    return null;
  }

  const loginEp = loginEndpointCandidates[0];

  // Step 4: Determine credentials fields
  const emailField =
    loginEp.requestBody?.fields.find((f) => /email/i.test(f.name))?.name ?? "email";
  const passwordField =
    loginEp.requestBody?.fields.find((f) => /password/i.test(f.name))?.name ?? "password";

  // Step 5: Find token response path by scanning login endpoint's source file
  let tokenResponsePath = "accessToken";
  const loginFile = files.find((f) => f.filePath === loginEp.sourceFile);
  if (loginFile) {
    const direct = detectTokenFieldInAST(loginFile);
    const nested = detectNestedTokenPath(loginFile);
    if (nested) tokenResponsePath = nested;
    else if (direct) tokenResponsePath = direct;
  }

  // Step 6: Determine refresh endpoint
  const refreshEp = endpoints.find(
    (ep) => ep.method === "POST" && REFRESH_PATH_RE.test(ep.path)
  );

  // Step 7: Detect auth cookie name (session-based auth)
  let authCookieName: string | null = null;
  if (globalAuthType === "session_cookie" || globalAuthType === "next_auth") {
    authCookieName = "session";
    // Scan for cookie name hints
    for (const file of files) {
      let found = false;
      walk(file.ast, (node) => {
        if (found) return;
        const val = extractStringValue(node as TSESTree.Node);
        if (val && /^[\w.-]+-session$|^[\w.-]+_session$|^[\w.-]+-token$|^[\w.-]+_token$|^next-auth\.session-token$/i.test(val)) {
          authCookieName = val;
          found = true;
        }
      });
      if (found) break;
    }
  }

  // Verify we have usable data before scanning for dummy patterns
  const hasAuthReferences = files.some((f) =>
    containsStringPattern(f.ast, /authorization|bearer|jwt|token|session/i)
  );
  void hasAuthReferences; // used as a quality signal, not blocking

  // Determine tokenHeaderFormat
  const tokenType: AuthType = globalAuthType ?? "bearer_jwt";
  let tokenHeaderName = "Authorization";
  let tokenHeaderFormat = "Bearer {token}";
  // For session_cookie: token lives in the Set-Cookie response header, not the body
  let resolvedTokenResponsePath: string | null = tokenResponsePath;

  if (tokenType === "api_key_header") {
    tokenHeaderName = "x-api-key";
    tokenHeaderFormat = "{token}";
  } else if (tokenType === "basic_auth") {
    tokenHeaderName = "Authorization";
    tokenHeaderFormat = "Basic {token}";
  } else if (tokenType === "session_cookie" || tokenType === "next_auth") {
    // Session cookies are set via Set-Cookie; Playwright stores them automatically.
    // The "token" concept doesn't apply — auth state is managed via cookie jar.
    tokenHeaderName = "Cookie";
    tokenHeaderFormat = "{cookie}";
    resolvedTokenResponsePath = null;
  } else if (tokenType === "oauth_sso") {
    // SSO/OAuth: auth happens via browser redirect to external IdP.
    // No direct login POST is possible — tests must use Playwright storageState.
    tokenHeaderName = "Cookie";
    tokenHeaderFormat = "{storageState}";
    resolvedTokenResponsePath = null;
  }

  // Step 8: Detect login body format (form vs JSON) from the handler source
  const loginBodyFormat = detectLoginBodyFormat(loginFile, tokenType);

  // For next_auth, the login endpoint is ALWAYS the NextAuth credentials callback.
  // Never use a user-facing endpoint (e.g. POST /api/users) as the login endpoint —
  // that creates users, it doesn't authenticate. NextAuth credentials always route
  // through /api/auth/callback/credentials with a CSRF token.
  const resolvedLoginEndpoint = tokenType === "next_auth"
    ? "POST /api/auth/callback/credentials"
    : `POST ${loginEp.path}`;

  const authConfig: AuthConfig = {
    loginEndpoint: resolvedLoginEndpoint,
    loginBodyFormat: tokenType === "next_auth" ? "form" : loginBodyFormat,
    credentialsFields: {
      emailField,
      passwordField,
      emailEnvVar: "SMOKE_TEST_EMAIL",
      passwordEnvVar: "SMOKE_TEST_PASSWORD",
    },
    tokenResponsePath: resolvedTokenResponsePath,
    tokenType,
    tokenHeaderName,
    tokenHeaderFormat,
    refreshEndpoint: refreshEp ? `POST ${refreshEp.path}` : null,
    authCookieName,
  };

  // Enrich endpoints now that we have auth config
  for (const ep of endpoints) {
    if (ep.authRequired && ep.authType === null) {
      ep.authType = tokenType;
    }
  }

  // Attempt to extract admin credentials from seed/fixture files so generated
  // tests use real credentials instead of placeholder defaults.
  const seedCreds = extractSeedCredentials(files);
  if (seedCreds) {
    authConfig.defaultEmail = seedCreds.email;
    authConfig.defaultPassword = seedCreds.password;
  }

  return authConfig;
}
