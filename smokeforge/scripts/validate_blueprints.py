#!/usr/bin/env python3
"""
Deep blueprint validation: cross-references blueprint.json against actual source code
for all 3 enterprise repos.
Checks:
  1. All routes present in blueprint
  2. Methods correct
  3. Query params match searchParams.get() calls
  4. Body fields match Zod schemas / destructuring
  5. Path params present
  6. Pages + locators reported
  7. LLM prompt completeness (auth, seed creds, fields flagged required)
"""
import os, re, json, sys
from pathlib import Path

BASE = Path(__file__).parent.parent.parent

REPOS = {
    "nextjs": {
        "repo": BASE / "enterprise-repos/enterprise-nextjs-saas",
        "blueprint": BASE / "smokeforge-output/dry-run-nextjs/blueprint.json",
        "api_dir": "src/app/api",
        "route_file": "route.ts",
        "framework": "nextjs",
    },
    "express": {
        "repo": BASE / "enterprise-repos/enterprise-express-hr",
        "blueprint": BASE / "smokeforge-output/dry-run-express/blueprint.json",
        "api_dir": "src",  # express uses router files
        "framework": "express",
    },
    "remix": {
        "repo": BASE / "enterprise-repos/enterprise-remix-healthcare",
        "blueprint": BASE / "smokeforge-output/dry-run-remix/blueprint.json",
        "api_dir": "app",
        "framework": "remix",
    },
}

DIVIDER = "=" * 72
PASS = "  ✅"
WARN = "  ⚠️ "
FAIL = "  ❌"

issues_total = 0

def issue(label, msg):
    global issues_total
    issues_total += 1
    print(f"{FAIL} [{label}] {msg}")

def warn(label, msg):
    print(f"{WARN} [{label}] {msg}")

def ok(msg):
    print(f"{PASS} {msg}")


# ─── Next.js specific validation ────────────────────────────────────────────

def validate_nextjs(info):
    print(f"\n{DIVIDER}")
    print("REPO: enterprise-nextjs-saas  (next_auth, App Router)")
    print(DIVIDER)

    bp = json.loads(info["blueprint"].read_text())
    api_dir = info["repo"] / info["api_dir"]

    # Build ground truth from source files
    source_routes = {}
    for rts in api_dir.rglob("route.ts"):
        rel = str(rts.relative_to(api_dir)).replace("/route.ts", "")
        # Normalise [param] → :param
        norm = re.sub(r'\[([^\]]+)\]', lambda m: ':' + m.group(1).lstrip('...'), rel)
        content = rts.read_text()

        methods = re.findall(r'^export async function (GET|POST|PUT|PATCH|DELETE)', content, re.MULTILINE)
        qps = re.findall(r"searchParams\.get\(['\"]([^'\"]+)['\"]\)", content)
        # Zod shape fields
        zod_fields = re.findall(r'^\s{2,6}(\w+):\s*z\.', content, re.MULTILINE)
        # Two-step destructure: const {a, b} = body;
        two_step = re.findall(r'const\s*\{([^}]+)\}\s*=\s*body\b', content)
        inferred = []
        for m in two_step:
            inferred += [x.strip().split(':')[0].strip() for x in m.split(',') if x.strip()]
        # Direct destructure: const {a,b} = await request.json()
        direct = re.findall(r'const\s*\{([^}]+)\}\s*=\s*await\s+request\.json\(\)', content)
        for m in direct:
            inferred += [x.strip().split(':')[0].strip() for x in m.split(',') if x.strip()]

        source_routes[f"/api/{norm}"] = {
            "methods": methods,
            "qps": sorted(set(qps)),
            "body_fields": sorted(set(zod_fields + inferred)),
        }

    # Blueprint endpoint index
    bp_eps = {}
    for ep in bp["endpoints"]:
        key = (ep["method"], ep["path"])
        bp_eps[key] = ep

    # ── 1. All routes/methods present ───────────────────────────────────────
    print("\n── 1. Routes & Methods ──")
    for path, src in sorted(source_routes.items()):
        for method in src["methods"]:
            if (method, path) in bp_eps:
                ok(f"{method:6} {path}")
            else:
                issue("MISSING_ENDPOINT", f"{method} {path} not in blueprint")

    # Check for blueprint endpoints not in source (false positives)
    for (method, path), ep in bp_eps.items():
        src_path = source_routes.get(path)
        if src_path is None:
            issue("PHANTOM_ENDPOINT", f"{method} {path} in blueprint but no source route found")
        elif method not in src_path["methods"]:
            issue("WRONG_METHOD", f"{method} {path} in blueprint but source only has: {src_path['methods']}")

    # ── 2. Query params ──────────────────────────────────────────────────────
    print("\n── 2. Query Params ──")
    # Only validate QP for read methods — GET/DELETE are the only methods
    # that legitimately use query params. POST/PUT/PATCH use the body instead.
    # A route.ts file exports both GET and POST; searchParams.get() calls in
    # the file apply to GET only.
    READ_METHODS = {"GET", "DELETE", "HEAD"}
    for path, src in sorted(source_routes.items()):
        if not src["qps"]:
            continue
        for method in src["methods"]:
            if method not in READ_METHODS:
                continue
            ep = bp_eps.get((method, path))
            if not ep:
                continue
            bp_qps = sorted(set(q["name"] for q in (ep.get("queryParams") or [])))
            missing = [q for q in src["qps"] if q not in bp_qps]
            extra = [q for q in bp_qps if q not in src["qps"]]
            if missing:
                issue("MISSING_QP", f"{method} {path}: source has qp={src['qps']} but blueprint missing: {missing}")
            elif extra:
                warn("EXTRA_QP", f"{method} {path}: blueprint has extra qp={extra} not in source")
            else:
                ok(f"{method:6} {path}  qp={bp_qps}")

    # ── 3. Body fields ───────────────────────────────────────────────────────
    print("\n── 3. Body Fields ──")
    for path, src in sorted(source_routes.items()):
        if not src["body_fields"]:
            continue
        write_methods = [m for m in src["methods"] if m in ("POST", "PUT", "PATCH")]
        for method in write_methods:
            ep = bp_eps.get((method, path))
            if not ep:
                continue
            rb = ep.get("requestBody")
            if rb is None:
                issue("MISSING_BODY", f"{method} {path}: source has body fields {src['body_fields']} but blueprint requestBody=null")
                continue
            bp_fields = sorted(set(f["name"] for f in rb["fields"]))
            missing = [f for f in src["body_fields"] if f not in bp_fields]
            if missing:
                issue("MISSING_FIELD", f"{method} {path}: source body fields {src['body_fields']} missing from blueprint: {missing}")
            else:
                ok(f"{method:6} {path}  body={bp_fields}")

    # ── 4. Write methods must have body (not None) ───────────────────────────
    print("\n── 4. Write Methods Without Body ──")
    for (method, path), ep in sorted(bp_eps.items()):
        if method not in ("POST", "PUT", "PATCH"):
            continue
        rb = ep.get("requestBody")
        if rb is None:
            warn("NO_BODY", f"{method} {path}: requestBody=null (route may not need body — verify)")
        elif rb["fields"] == []:
            warn("EMPTY_BODY_FIELDS", f"{method} {path}: requestBody present but 0 fields extracted")
        else:
            ok(f"{method:6} {path}  body({rb['source']})=[{', '.join(f['name'] for f in rb['fields'])}]")

    # ── 5. GET/DELETE must NOT have requestBody ──────────────────────────────
    print("\n── 5. GET/DELETE Body Bleed ──")
    bleed_found = False
    for (method, path), ep in sorted(bp_eps.items()):
        if method in ("GET", "DELETE", "HEAD", "OPTIONS"):
            if ep.get("requestBody") is not None:
                issue("BODY_BLEED", f"{method} {path}: has requestBody — should be null")
                bleed_found = True
    if not bleed_found:
        ok("No body bleed on GET/DELETE/HEAD/OPTIONS")

    # ── 6. Path params ───────────────────────────────────────────────────────
    print("\n── 6. Path Params ──")
    for (method, path), ep in sorted(bp_eps.items()):
        dynamic = re.findall(r':(\w+)', path)
        if not dynamic:
            continue
        bp_pp = [p["name"] for p in (ep.get("pathParams") or [])]
        missing = [p for p in dynamic if p not in bp_pp]
        if missing:
            issue("MISSING_PP", f"{method} {path}: dynamic segments {dynamic} missing from pathParams: {missing}")
        else:
            ok(f"{method:6} {path}  pathParams={bp_pp}")

    # ── 7. Auth ──────────────────────────────────────────────────────────────
    print("\n── 7. Auth Config ──")
    auth = bp.get("auth")
    if auth:
        ok(f"type={auth['tokenType']}, login={auth['loginEndpoint']}, format={auth['loginBodyFormat']}")
        ok(f"emailField={auth['credentialsFields']['emailField']}, passField={auth['credentialsFields']['passwordField']}")
        if auth.get("defaultEmail"):
            ok(f"Seed creds extracted: {auth['defaultEmail']} / {auth['defaultPassword']}")
        else:
            warn("NO_SEED_CREDS", "No seed credentials extracted — LLM will use generic fallback")
        if auth.get("authCookieName"):
            ok(f"Cookie name: {auth['authCookieName']}")
    else:
        issue("NO_AUTH", "No auth config in blueprint")

    # ── 8. Pages & Locators ──────────────────────────────────────────────────
    print("\n── 8. Pages & Locators ──")
    for pg in sorted(bp.get("pages", []), key=lambda p: p["route"]):
        locators = pg.get("locators") or []
        title = pg.get("title") or "?"
        is_fs_path = "/" not in pg["route"]  # sanity check
        if is_fs_path:
            issue("BAD_ROUTE", f"Page route looks like filesystem path: {pg['route']}")
        elif not locators:
            warn("NO_LOCATORS", f"{pg['route']} (title={title}) — 0 locators, LLM will guess selectors")
        else:
            ok(f"{pg['route']}  title={title}  locators={len(locators)}: {[l['name'] for l in locators]}")

    # ── 9. LLM prompt completeness spot-check ────────────────────────────────
    print("\n── 9. LLM Prompt Completeness (chunk spot-check) ──")
    chunks_dir = info["blueprint"].parent / "chunks"
    chunk_files = sorted(chunks_dir.glob("*.json"))
    required_sections = ["AUTH USAGE NOTES", "API ENDPOINTS TO TEST", "COVERAGE REQUIREMENTS"]
    for cf in chunk_files:
        chunk = json.loads(cf.read_text())
        msg = chunk.get("llmUserMessage", "")
        for section in required_sections:
            if section not in msg:
                issue("MISSING_PROMPT_SECTION", f"{cf.name}: missing section '{section}' in llmUserMessage")
        # Check FK warnings present for FK fields
        if "⚠️ FK" in msg:
            ok(f"{cf.name}: FK hint present in prompt")
        # Check PATCH/PUT mandatory body hint
        for ep in chunk.get("chunk", {}).get("endpoints", []):
            if ep["method"] in ("PATCH", "PUT"):
                rb = ep.get("requestBody")
                if rb and rb["fields"]:
                    req_fields = [f for f in rb["fields"] if f["required"]]
                    if not req_fields and "MUST still send a body" not in msg:
                        warn("NO_OPTIONAL_BODY_HINT", f"{cf.name}: {ep['method']} {ep['path']} all-optional body but no mandatory-body hint detected")
    ok(f"Spot-checked {len(chunk_files)} chunk prompt files")


# ─── Express specific validation ─────────────────────────────────────────────

def validate_express(info):
    print(f"\n{DIVIDER}")
    print("REPO: enterprise-express-hr  (bearer_jwt)")
    print(DIVIDER)

    bp = json.loads(info["blueprint"].read_text())
    repo = info["repo"]

    # Collect all route registrations from Express router files
    router_files = list(repo.rglob("*.ts")) + list(repo.rglob("*.js"))
    router_files = [f for f in router_files if "node_modules" not in str(f) and "dist" not in str(f)]

    source_routes = set()
    for rf in router_files:
        try:
            content = rf.read_text()
        except:
            continue
        # Look for .get/.post/.put/.patch/.delete route registrations
        for match in re.finditer(r'\.(get|post|put|patch|delete)\s*\(\s*[\'"]([^\'"]+)[\'"]', content, re.IGNORECASE):
            method = match.group(1).upper()
            path = match.group(2)
            # Normalise express :param style (already in that form)
            source_routes.add((method, path))

    bp_eps = {(ep["method"], ep["path"]) for ep in bp["endpoints"]}
    bp_eps_list = {(ep["method"], ep["path"]): ep for ep in bp["endpoints"]}

    print(f"\n── 1. Route Coverage ──")
    print(f"  Source routes found: {len(source_routes)}")
    print(f"  Blueprint endpoints: {len(bp_eps)}")

    # Check all blueprint endpoints have auth flag set correctly
    print(f"\n── 2. Auth on endpoints ──")
    unauthed = [(m, p) for (m, p), ep in bp_eps_list.items() if not ep.get("authRequired")]
    if unauthed:
        for m, p in sorted(unauthed):
            warn("UNAUTHED", f"{m} {p} — auth=False, verify this is correct")
    else:
        ok("All endpoints marked authRequired=True")

    # Body fields present for write methods
    print(f"\n── 3. Write Method Bodies ──")
    for (method, path), ep in sorted(bp_eps_list.items()):
        if method not in ("POST", "PUT", "PATCH"):
            continue
        rb = ep.get("requestBody")
        if rb is None:
            warn("NO_BODY", f"{method} {path}: requestBody=null")
        elif rb["fields"] == []:
            warn("EMPTY_FIELDS", f"{method} {path}: requestBody present but 0 fields")
        else:
            ok(f"{method:6} {path}  body({rb['source']})=[{', '.join(f['name'] for f in rb['fields'])}]")

    # GET/DELETE body bleed
    print(f"\n── 4. GET/DELETE Body Bleed ──")
    bleed = False
    for (method, path), ep in sorted(bp_eps_list.items()):
        if method in ("GET", "DELETE") and ep.get("requestBody") is not None:
            issue("BODY_BLEED", f"{method} {path}: has unexpected requestBody")
            bleed = True
    if not bleed:
        ok("No body bleed on GET/DELETE")

    # Auth config
    print(f"\n── 5. Auth Config ──")
    auth = bp.get("auth")
    if auth:
        ok(f"type={auth['tokenType']}, login={auth['loginEndpoint']}")
        ok(f"emailField={auth['credentialsFields']['emailField']}, passField={auth['credentialsFields']['passwordField']}")
        if auth.get("defaultEmail"):
            ok(f"Seed creds: {auth['defaultEmail']}")
        else:
            warn("NO_SEED_CREDS", "No seed credentials found")
    else:
        issue("NO_AUTH", "No auth in blueprint")

    # Path params
    print(f"\n── 6. Path Params ──")
    for (method, path), ep in sorted(bp_eps_list.items()):
        dynamic = re.findall(r':(\w+)', path)
        if not dynamic:
            continue
        bp_pp = [p2["name"] for p2 in (ep.get("pathParams") or [])]
        missing = [p2 for p2 in dynamic if p2 not in bp_pp]
        if missing:
            issue("MISSING_PP", f"{method} {path}: missing pathParams {missing}")
        else:
            ok(f"{method:6} {path}  pathParams={bp_pp}")

    # LLM prompt
    print(f"\n── 7. LLM Prompt Completeness ──")
    chunks_dir = info["blueprint"].parent / "chunks"
    for cf in sorted(chunks_dir.glob("*.json")):
        chunk = json.loads(cf.read_text())
        msg = chunk.get("llmUserMessage", "")
        if "AUTH USAGE NOTES" not in msg:
            issue("PROMPT", f"{cf.name}: missing AUTH USAGE NOTES")
    ok(f"Checked {len(list(chunks_dir.glob('*.json')))} chunks")


# ─── Remix specific validation ────────────────────────────────────────────────

def validate_remix(info):
    print(f"\n{DIVIDER}")
    print("REPO: enterprise-remix-healthcare  (session_cookie)")
    print(DIVIDER)

    bp = json.loads(info["blueprint"].read_text())
    repo = info["repo"]

    bp_eps_list = {(ep["method"], ep["path"]): ep for ep in bp["endpoints"]}

    # Methods
    print(f"\n── 1. Route Coverage ──")
    print(f"  Blueprint endpoints: {len(bp_eps_list)}")
    print(f"  Blueprint pages: {len(bp.get('pages', []))}")

    # Body fields on write methods
    print(f"\n── 2. Write Method Bodies ──")
    for (method, path), ep in sorted(bp_eps_list.items()):
        if method not in ("POST", "PUT", "PATCH"):
            continue
        rb = ep.get("requestBody")
        if rb is None:
            warn("NO_BODY", f"{method} {path}: requestBody=null")
        elif rb["fields"] == []:
            warn("EMPTY_FIELDS", f"{method} {path}: 0 fields extracted")
        else:
            ok(f"{method:6} {path}  body({rb['source']})=[{', '.join(f['name'] for f in rb['fields'])}]")

    # GET/DELETE bleed
    print(f"\n── 3. GET/DELETE Body Bleed ──")
    bleed = False
    for (method, path), ep in sorted(bp_eps_list.items()):
        if method in ("GET", "DELETE") and ep.get("requestBody") is not None:
            issue("BODY_BLEED", f"{method} {path}: has unexpected requestBody")
            bleed = True
    if not bleed:
        ok("No body bleed on GET/DELETE")

    # Path params
    print(f"\n── 4. Path Params ──")
    for (method, path), ep in sorted(bp_eps_list.items()):
        dynamic = re.findall(r':(\w+)', path)
        if not dynamic:
            continue
        bp_pp = [p["name"] for p in (ep.get("pathParams") or [])]
        missing = [p for p in dynamic if p not in bp_pp]
        if missing:
            issue("MISSING_PP", f"{method} {path}: missing pathParams {missing}")
        else:
            ok(f"{method:6} {path}  pathParams={bp_pp}")

    # Auth
    print(f"\n── 5. Auth Config ──")
    auth = bp.get("auth")
    if auth:
        ok(f"type={auth['tokenType']}, login={auth['loginEndpoint']}, format={auth['loginBodyFormat']}")
        ok(f"emailField={auth['credentialsFields']['emailField']}, passField={auth['credentialsFields']['passwordField']}")
        if auth.get("defaultEmail"):
            ok(f"Seed creds: {auth['defaultEmail']} / {auth['defaultPassword']}")
        else:
            warn("NO_SEED_CREDS", "No seed credentials found")
        if auth.get("authCookieName"):
            ok(f"Cookie name: {auth['authCookieName']}")
    else:
        issue("NO_AUTH", "No auth in blueprint")

    # Pages & Locators
    print(f"\n── 6. Pages & Locators ──")
    for pg in sorted(bp.get("pages", []), key=lambda p: p["route"]):
        locators = pg.get("locators") or []
        title = pg.get("title") or "?"
        if not pg["route"].startswith("/"):
            issue("BAD_ROUTE", f"Page route looks like filesystem path: {pg['route']}")
        elif not locators:
            warn("NO_LOCATORS", f"{pg['route']} (title={title}) — 0 locators")
        else:
            ok(f"{pg['route']}  title={title}  locators={len(locators)}")

    # LLM prompts
    print(f"\n── 7. LLM Prompt Completeness ──")
    chunks_dir = info["blueprint"].parent / "chunks"
    for cf in sorted(chunks_dir.glob("*.json")):
        chunk = json.loads(cf.read_text())
        msg = chunk.get("llmUserMessage", "")
        if "AUTH USAGE NOTES" not in msg:
            issue("PROMPT", f"{cf.name}: missing AUTH USAGE NOTES")
        if "SESSION COOKIE" not in msg and auth and auth.get("tokenType") == "session_cookie":
            warn("PROMPT", f"{cf.name}: session_cookie app but 'SESSION COOKIE' not in prompt")
    ok(f"Checked {len(list(chunks_dir.glob('*.json')))} chunks")


# ─── Run all ─────────────────────────────────────────────────────────────────
validate_nextjs(REPOS["nextjs"])
validate_express(REPOS["express"])
validate_remix(REPOS["remix"])

print(f"\n{DIVIDER}")
print(f"TOTAL ISSUES: {issues_total}")
print(DIVIDER)
sys.exit(1 if issues_total > 0 else 0)
