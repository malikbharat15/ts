"""
Comprehensive chunk validation for smokeforge-output remix-healthcare chunks.
Validates: endpoints, locators, request body, response schema, parameters.
"""
import json, re, glob, os

CHUNKS_DIR = "/Users/bharatmalik/Documents/GitHub/JSSmoketest/smokeforge/smokeforge-output/remix-healthcare-tests/chunks"

files = sorted(glob.glob(f"{CHUNKS_DIR}/*.json"))
all_chunks = []
for fpath in files:
    with open(fpath) as fh:
        raw = json.load(fh)
        all_chunks.append((os.path.basename(fpath), raw))

LEGITIMATELY_EMPTY_BODY = {
    "POST /auth/logout",
    "POST /api/session/refresh",
    "POST /api/prescriptions/:prescriptionId/fill",
}

VALID_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}

issues_all = []
rows = []

for fname, raw in all_chunks:
    c = raw.get("chunk", {})
    eps      = c.get("endpoints", [])
    pages    = c.get("pages", [])
    auth     = c.get("auth", {})
    hints    = c.get("testDataHints", {})
    domain   = c.get("domain", "?")

    for ep in eps:
        eid          = ep.get("id", "?")
        method       = ep.get("method", "?")
        path         = ep.get("path", "?")
        path_params  = ep.get("pathParams", [])
        query_params = ep.get("queryParams", [])
        body         = ep.get("requestBody")
        resp_schema  = ep.get("responseSchema")
        auth_req     = ep.get("authRequired", False)
        auth_type    = ep.get("authType", "")
        roles        = ep.get("roles", [])
        confidence   = ep.get("confidence", 0)
        flags        = ep.get("flags", [])
        ep_key       = f"{method} {path}"
        row_issues   = []

        if method not in VALID_METHODS:
            row_issues.append(f"BAD_METHOD:{method}")

        url_tokens = re.findall(r":(\w+)", path)
        for t in url_tokens:
            if not any(p.get("name") == t for p in path_params):
                row_issues.append(f"PATH_PARAM_NOT_DECLARED:{t}")

        for p in path_params:
            if p.get("name") not in url_tokens:
                row_issues.append(f"ORPHAN_PATH_PARAM:{p.get('name')}")

        if method in {"POST", "PUT", "PATCH"} and ep_key not in LEGITIMATELY_EMPTY_BODY:
            if body is None:
                row_issues.append("REQ_BODY_NULL")
            elif isinstance(body, dict) and not body.get("fields"):
                row_issues.append("REQ_BODY_FIELDS_EMPTY")

        if isinstance(body, dict) and body.get("fields"):
            for bf in body["fields"]:
                if not bf.get("type"):
                    row_issues.append(f"BODY_FIELD_NO_TYPE:{bf.get('name')}")
                if not bf.get("example"):
                    row_issues.append(f"BODY_FIELD_NO_EXAMPLE:{bf.get('name')}")

        if method != "DELETE" and resp_schema is None:
            row_issues.append("RESP_SCHEMA_NULL")

        if auth_req and not auth_type:
            row_issues.append("AUTH_REQ_BUT_NO_AUTH_TYPE")

        if auth_req and not auth.get("tokenType"):
            row_issues.append("AUTH_REQ_BUT_CHUNK_AUTH_MISSING")

        if confidence < 0.6:
            row_issues.append(f"LOW_CONFIDENCE:{confidence}")

        rows.append({
            "file": fname, "domain": domain, "kind": "endpoint",
            "id": eid, "key": ep_key,
            "auth_req": auth_req, "auth_type": auth_type, "roles": roles,
            "path_params": path_params, "query_params": query_params,
            "body": body, "resp_schema": resp_schema,
            "confidence": confidence, "flags": flags,
            "issues": row_issues
        })
        if row_issues:
            issues_all.append({"file": fname, "id": eid, "key": ep_key, "issues": row_issues})

    for page in pages:
        pid         = page.get("id", "?")
        route       = page.get("route", "?")
        auth_req    = page.get("authRequired", False)
        roles       = page.get("roles", [])
        is_dynamic  = page.get("isDynamic", False)
        route_params = page.get("routeParams", [])
        locators    = page.get("locators", [])
        form_flows  = page.get("formFlows", [])
        nav_links   = page.get("navigationLinks", [])
        linked_eps  = page.get("linkedEndpoints", [])
        confidence  = page.get("confidence", 0)
        row_issues  = []

        if not locators:
            row_issues.append("NO_LOCATORS")

        for loc in locators:
            name    = loc.get("name", "?")
            pw_code = loc.get("playwrightCode", "").strip()
            confidence_loc = loc.get("confidence", 0)

            if not pw_code:
                row_issues.append(f"LOCATOR_NO_PW_CODE:{name}")
            else:
                if not any(kw in pw_code for kw in [
                    "getByRole", "getByLabel", "getByText", "getByTestId",
                    "getByPlaceholder", "locator(", "page."
                ]):
                    row_issues.append(f"LOCATOR_SUSPECT_PW_CODE:{name}={pw_code[:50]}")

            if confidence_loc < 0.5:
                row_issues.append(f"LOCATOR_LOW_CONFIDENCE:{name}:{confidence_loc}")

        if is_dynamic and not route_params:
            row_issues.append("DYNAMIC_ROUTE_NO_PARAMS")

        route_tokens = re.findall(r":(\w+)", route)
        for rp in route_params:
            if rp.get("name") not in route_tokens:
                row_issues.append(f"ORPHAN_ROUTE_PARAM:{rp.get('name')}")

        if auth_req and not auth.get("tokenType"):
            row_issues.append("PAGE_AUTH_REQ_BUT_NO_CHUNK_AUTH")

        if confidence < 0.6:
            row_issues.append(f"PAGE_LOW_CONFIDENCE:{confidence}")

        rows.append({
            "file": fname, "domain": domain, "kind": "page",
            "id": pid, "key": f"PAGE {route}",
            "auth_req": auth_req, "roles": roles,
            "locators": locators, "form_flows": form_flows,
            "nav_links": nav_links, "linked_eps": linked_eps,
            "route_params": route_params, "is_dynamic": is_dynamic,
            "confidence": confidence,
            "issues": row_issues
        })
        if row_issues:
            issues_all.append({"file": fname, "id": pid, "key": f"PAGE {route}", "issues": row_issues})

ep_count  = sum(1 for r in rows if r["kind"] == "endpoint")
pg_count  = sum(1 for r in rows if r["kind"] == "page")
ok_count  = sum(1 for r in rows if not r["issues"])
bad_count = sum(1 for r in rows if r["issues"])

W = 115
print(f"\n{'='*W}")
print(f"  SMOKEFORGE CHUNK VALIDATION REPORT")
print(f"  {len(all_chunks)} chunks | {ep_count} endpoints | {pg_count} pages | OK={ok_count} | ISSUES={bad_count}")
print(f"{'='*W}\n")

current_file = None
for row in rows:
    if row["file"] != current_file:
        current_file = row["file"]
        for cn, cd in all_chunks:
            if cn == current_file:
                ca = cd["chunk"].get("auth", {})
                th = cd["chunk"].get("testDataHints", {})
                break
        auth_str = (f"tokenType={ca.get('tokenType','MISSING')} | loginEp={ca.get('loginEndpoint','?')} "
                    f"| cookie={ca.get('authCookieName','?')} "
                    f"| tokenResponsePath={ca.get('tokenResponsePath','?')}")
        creds = th.get("credentials", {})
        print(f"\n{'─'*W}")
        print(f"  CHUNK: {current_file}")
        print(f"  AUTH:  {auth_str}")
        if creds:
            print(f"  CREDS: {creds}")
        print(f"{'─'*W}")

    sym = "OK" if not row["issues"] else "!!"

    if row["kind"] == "endpoint":
        auth_badge = ("LOCKED:" + ",".join(row["roles"])) if row["auth_req"] else "PUBLIC"
        body       = row["body"]

        if isinstance(body, dict) and body.get("fields"):
            bf_str = ", ".join(
                f"{f.get('name')}:{f.get('type','?')}{'*' if f.get('required') else ''}(ex:{f.get('example','')})"
                for f in body["fields"]
            )
        elif body is None:
            bf_str = "NULL"
        else:
            bf_str = "EMPTY_FIELDS"

        pp = [p.get("name") for p in row["path_params"]]
        qp = []
        for qpar in row["query_params"]:
            req_mark = "" if qpar.get("required") else "?"
            qp.append(f"{qpar.get('name')}{req_mark}")

        rs = row["resp_schema"]
        if isinstance(rs, dict):
            status_code = rs.get("statusCode", rs.get("status", "?"))
            schema_inner = rs.get("schema") or {}
            if isinstance(schema_inner, dict):
                rs_fields_raw = schema_inner.get("fields", schema_inner.get("properties", []))
            else:
                rs_fields_raw = []
            if isinstance(rs_fields_raw, list):
                rs_f_names = [f.get("name") if isinstance(f, dict) else str(f) for f in rs_fields_raw]
            elif isinstance(rs_fields_raw, dict):
                rs_f_names = list(rs_fields_raw.keys())
            else:
                rs_f_names = []
            rs_str = f"statusCode={status_code} | fields={rs_f_names}"
        elif rs is None:
            rs_str = "NULL"
        else:
            rs_str = str(rs)[:100]

        print(f"\n  [{sym}] [{row['id']:<12}] {row['key']:<60} [{auth_badge}]")
        if pp:
            print(f"         pathParams : {pp}")
        if qp:
            print(f"         queryParams: {qp}")
        print(f"         reqBody    : {bf_str}")
        print(f"         respSchema : {rs_str}")
        if row["flags"]:
            print(f"         flags      : {row['flags']}")
        if row["issues"]:
            for iss in row["issues"]:
                print(f"         ISSUE: {iss}")

    else:
        auth_badge = ("LOCKED:" + ",".join(row["roles"])) if row["auth_req"] else "PUBLIC"
        locs = row["locators"]
        ff   = row["form_flows"]
        rp   = row.get("route_params", [])
        le   = row.get("linked_eps", [])

        print(f"\n  [{sym}] [{row['id']:<12}] {row['key']:<60} [{auth_badge}]")
        if rp:
            print(f"         routeParams: {[p.get('name') for p in rp]}")
        if le:
            print(f"         linkedEps  : {le}")
        for loc in locs:
            pw      = loc.get("playwrightCode", "").strip()
            interac = "INTERACT" if loc.get("isInteractive") else "VIEW"
            cond    = "[COND]" if loc.get("isConditional") else ""
            dyn     = "[DYN]"  if loc.get("isDynamic") else ""
            extra   = " ".join(filter(None, [cond, dyn]))
            conf_loc = loc.get("confidence", 0)
            print(f"         loc[{interac}][{loc.get('strategy','?'):<10}] {loc.get('name','?'):<40} conf={conf_loc} {extra}")
            if pw:
                print(f"               pw: {pw[:95]}")
        for flow in ff:
            steps = flow.get("steps", [])
            print(f"         formFlow: {flow.get('name','?')} ({len(steps)} steps)")
            for s in steps:
                print(f"           step: {s.get('action','?')} locator={s.get('locator','?')} value={s.get('value','')!r}")
        if row["issues"]:
            for iss in row["issues"]:
                print(f"         ISSUE: {iss}")

print(f"\n\n{'='*W}")
print(f"  ISSUES SUMMARY: {len(issues_all)} items")
print(f"{'='*W}")

if not issues_all:
    print("  ALL CLEAR -- no issues found\n")
else:
    cats = {}
    for iss in issues_all:
        for it in iss["issues"]:
            cat = it.split(":")[0]
            cats.setdefault(cat, []).append((iss["file"], iss["key"]))

    for cat, items in sorted(cats.items(), key=lambda x: -len(x[1])):
        print(f"\n  [{cat}] -- {len(items)} occurrence(s)")
        for fname, key in items:
            print(f"    {fname}  ->  {key}")

print(f"\n{'='*W}")
print(f"  TOTALS: {ep_count} endpoints | {pg_count} pages | OK={ok_count} | ISSUES={bad_count}")
print(f"{'='*W}\n")
