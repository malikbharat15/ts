#!/usr/bin/env python3
"""Deep audit of blueprint data quality across all three repos."""
import json, glob, sys, os

WRITE_METHODS = {"POST", "PUT", "PATCH"}
READ_METHODS  = {"GET", "DELETE", "HEAD"}

total_errors   = 0
total_warnings = 0

for bp_path in sorted(glob.glob("/Users/bharatmalik/Documents/GitHub/JSSmoketest/smokeforge-output/dry-run-*/blueprint.json")):
    name = bp_path.split("dry-run-")[1].split("/")[0]
    b    = json.load(open(bp_path))
    eps  = b["endpoints"]
    auth = b.get("auth") or {}
    pages= b.get("pages", [])

    errors   = []
    warnings = []

    for ep in eps:
        method = ep["method"]
        path   = ep["path"]
        body   = ep.get("requestBody") or {}
        qp     = ep.get("queryParams", [])
        pp     = ep.get("pathParams",  [])
        fields = body.get("fields", [])

        # ── 1. Every path param must have an example ──
        for p2 in pp:
            if not p2.get("example"):
                errors.append(f"NO_PP_EXAMPLE   {method:6} {path}  param={p2['name']}")

        # ── 2. Every body field must have an example ──
        if fields:
            for f in fields:
                if not f.get("example") and f.get("required"):
                    errors.append(f"NO_FIELD_EXAMPLE {method:6} {path}  field={f['name']} (required)")
                elif not f.get("example"):
                    warnings.append(f"WARN_NO_EXAMPLE  {method:6} {path}  field={f['name']} (optional)")

        # ── 3. Write methods should have a body ──
        if method in WRITE_METHODS:
            if body.get("inferred") is False and not fields:
                warnings.append(f"WARN_EMPTY_BODY  {method:6} {path}  (no body detected — action endpoint?)")

        # ── 4. Read methods must NOT have requestBody ──
        if method in READ_METHODS and fields:
            errors.append(f"BODY_BLEED       {method:6} {path}  unexpected body fields={[f['name'] for f in fields]}")

        # ── 5. FK fields must have a hint ──
        for f in fields:
            fname = f["name"]
            if (fname.endswith("Id") or fname.endswith("ID")) and not f.get("example"):
                errors.append(f"FK_NO_EXAMPLE    {method:6} {path}  fk_field={fname}")

    # ── 6. Auth config completeness ──
    token_type = auth.get("tokenType") or auth.get("type") or "MISSING"
    login_ep   = auth.get("loginEndpoint") or "MISSING"
    email_field = auth.get("credentials",{}).get("emailField") or "MISSING"
    pass_field  = auth.get("credentials",{}).get("passwordField") or "MISSING"
    seed_email  = auth.get("credentials",{}).get("email") or "MISSING"
    seed_pass   = auth.get("credentials",{}).get("password") or "MISSING"

    if "MISSING" in [token_type, login_ep]:
        errors.append(f"AUTH_INCOMPLETE  tokenType={token_type}  loginEndpoint={login_ep}")
    if "MISSING" in [seed_email, seed_pass]:
        warnings.append(f"WARN_AUTH_CREDS  email={seed_email}  password={seed_pass}")

    # ── 7. Pages: every page must have at least a title ──
    for pg in pages:
        t = pg.get("title", "")
        r = pg.get("route", "")
        if not t or t.lower() in ["[id]", "index", "page", "unknown"]:
            errors.append(f"BAD_TITLE        page {r}  title={repr(t)}")

    # ── Print results ──
    e_count = len(errors)
    w_count = len(warnings)
    total_errors   += e_count
    total_warnings += w_count

    print(f"\n{'='*70}")
    print(f"REPO: {name}  ({len(eps)} endpoints, {len(pages)} pages)  {e_count} errors / {w_count} warnings")
    print(f"{'='*70}")
    if errors:
        print(" ERRORS:")
        for e in errors:
            print(f"  ❌ {e}")
    if warnings:
        print(" WARNINGS:")
        for w in warnings:
            print(f"  ⚠️  {w}")
    if not errors and not warnings:
        print("  ✅ All endpoint data looks complete")

print(f"\n{'='*70}")
print(f"GRAND TOTAL: {total_errors} ERRORS / {total_warnings} WARNINGS")
print(f"{'='*70}")
sys.exit(1 if total_errors > 0 else 0)
