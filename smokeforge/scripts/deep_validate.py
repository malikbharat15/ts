#!/usr/bin/env python3
"""
Deep validator for smokeforge blueprint + chunk outputs.
Analyses each repo's dry-run output and reports:
  - Framework & auth detection
  - Endpoints (method / path / auth / request params / body fields)
  - Pages (route / auth / locator count / locator quality)
  - Chunks (domain / endpoint count / page count / issues)
  - Cross-checks: every endpoint appears in a chunk, every page appears in a chunk
  - Issues: missing bodies, missing locators, brittle locators, missing auth flags
"""

import json
import os
import sys
from pathlib import Path
from collections import defaultdict

BASE = Path("/Users/bharatmalik/Documents/GitHub/JSSmoketest/smokeforge-output")

REPOS = [
    ("react-vite-crm",    "dry-run-react-vite",     "enterprise-react-vite-crm"),
    ("fastify-inventory",  "dry-run-fastify",         "enterprise-fastify-inventory"),
    ("remix-ecommerce",    "dry-run-remix-ecom",      "enterprise-remix-ecommerce"),
    ("remix-fintech",      "dry-run-remix-fintech",   "enterprise-remix-fintech"),
]

# ─── helpers ──────────────────────────────────────────────────────────────────

def load_json(p):
    with open(p) as f:
        return json.load(f)

def pct(n, d):
    return f"{n}/{d} ({100*n//d if d else 0}%)"

def sep(title=""):
    width = 72
    if title:
        pad = (width - len(title) - 2) // 2
        print("\n" + "═"*pad + f" {title} " + "═"*(width - pad - len(title) - 2))
    else:
        print("─"*width)

def flag(ok, msg):
    return f"  {'✅' if ok else '❌'}  {msg}"

def warn(ok, msg):
    return f"  {'✅' if ok else '⚠️ '} {msg}"

# ─── main analysis ────────────────────────────────────────────────────────────

def analyse_repo(label, out_dir, repo_name):
    out_path = BASE / out_dir
    bp_path  = out_path / "blueprint.json"
    chunks_dir = out_path / "chunks"

    sep(label)

    if not bp_path.exists():
        print("  ❌  blueprint.json not found!")
        return

    bp = load_json(bp_path)
    chunks = []
    for cf in sorted(chunks_dir.glob("*.json")):
        chunks.append((cf.name, load_json(cf)))

    # ── top-level meta ──────────────────────────────────────────────────────
    print(f"\n{'REPO':15} {repo_name}")
    print(f"{'OUTPUT DIR':15} {out_dir}")
    fw_raw = bp.get("frameworks") or bp.get("framework", [])
    if isinstance(fw_raw, dict):
        fw_str = json.dumps(fw_raw)
    elif isinstance(fw_raw, list):
        fw_str = ", ".join(fw_raw)
    else:
        fw_str = str(fw_raw)
    print(f"{'FRAMEWORKS':15} {fw_str}")
    print(f"{'FORMAT':15} {bp.get('testFormat', bp.get('outputFormat', 'n/a'))}")
    auth = bp.get("auth") or {}
    auth_type = auth.get("type","none") if auth else "none"
    print(f"{'AUTH TYPE':15} {auth_type}")
    if auth_type and auth_type != "none":
        print(f"{'AUTH LOGIN':15} {auth.get('loginEndpoint','?')} — body: {json.dumps(auth.get('loginBodyFormat',{}))}")
        print(f"{'AUTH CREDS':15} {auth.get('credentialsFields',{})}")

    # ── endpoints ───────────────────────────────────────────────────────────
    endpoints = bp.get("endpoints", [])
    print(f"\n── ENDPOINTS ({len(endpoints)}) ──────────────────────────────────")

    by_method = defaultdict(int)
    issues_ep = []
    ep_ids_in_bp = set()

    for ep in endpoints:
        ep_ids_in_bp.add(ep.get("id",""))
        method = ep.get("method","?").upper()
        path   = ep.get("path", ep.get("route","?"))
        auth_r = ep.get("authRequired", ep.get("requiresAuth", None))
        body   = ep.get("requestBody", {}) or {}
        body_fields = body.get("fields", []) if isinstance(body, dict) else []
        path_params = ep.get("pathParams", [])
        query_params = ep.get("queryParams", [])
        domain  = ep.get("domain","?")
        by_method[method] += 1

        auth_flag = "🔒" if auth_r else ("🔓" if auth_r is False else "❓")
        body_str = ""
        if body_fields:
            body_str = f"  body={[f.get('name','?') for f in body_fields]}"
        pp_str = f"  pathParams={[p.get('name',p) if isinstance(p,dict) else p for p in path_params]}" if path_params else ""
        qp_str = f"  queryParams={[p.get('name',p) if isinstance(p,dict) else p for p in query_params]}" if query_params else ""

        print(f"  {auth_flag} {method:<7} {path:<45} [{domain}]{body_str}{pp_str}{qp_str}")

        # issue: POST/PUT without body
        if method in ("POST","PUT","PATCH") and not body_fields:
            issues_ep.append(f"  ⚠️  {method} {path} — no requestBody.fields defined")
        # issue: path has :param but no pathParams
        import re
        dynamic_segs = re.findall(r":(\w+)|\{(\w+)\}", path)
        if dynamic_segs and not path_params:
            issues_ep.append(f"  ⚠️  {method} {path} — dynamic path but pathParams=[]")
        # issue: auth flag missing
        if auth_r is None:
            issues_ep.append(f"  ⚠️  {method} {path} — authRequired not set (null)")

    print(f"\n  Method distribution: {dict(by_method)}")
    if issues_ep:
        print(f"\n  ENDPOINT ISSUES ({len(issues_ep)}):")
        for i in issues_ep:
            print(i)
    else:
        print("  ✅  No endpoint issues")

    # ── pages ───────────────────────────────────────────────────────────────
    pages = bp.get("pages", [])
    print(f"\n── PAGES ({len(pages)}) ──────────────────────────────────────────")

    issues_pages = []
    page_ids_in_bp = set()
    total_locators = 0
    brittle_locators = 0
    low_conf_locators = 0
    interactive_locators = 0

    for pg in pages:
        page_ids_in_bp.add(pg.get("id",""))
        route = pg.get("route", pg.get("path","?"))
        auth_r = pg.get("authRequired", None)
        dynamic = pg.get("isDynamic", False)
        locs = pg.get("locators", [])
        flows = pg.get("formFlows", [])
        linked = pg.get("linkedEndpoints", [])
        title = pg.get("title","?")
        conf  = pg.get("confidence", 0)

        auth_flag = "🔒" if auth_r else ("🔓" if auth_r is False else "❓")
        dyn_flag  = " [dynamic]" if dynamic else ""
        total_locators += len(locs)

        # locator quality
        brittle  = [l for l in locs if "BRITTLE" in l.get("flags",[]) or l.get("strategy","") == "css"]
        low_conf = [l for l in locs if l.get("confidence",1) < 0.7]
        inter    = [l for l in locs if l.get("isInteractive")]
        brittle_locators  += len(brittle)
        low_conf_locators += len(low_conf)
        interactive_locators += len(inter)

        role_locs  = [l for l in locs if l.get("strategy") == "role"]
        label_locs = [l for l in locs if l.get("strategy") == "label"]
        testid_locs = [l for l in locs if l.get("strategy") in ("testid","data-testid")]
        css_locs    = [l for l in locs if l.get("strategy") == "css"]

        print(f"  {auth_flag} {route:<45}{dyn_flag}")
        print(f"       title={title!r}  locators={len(locs)} (role={len(role_locs)},label={len(label_locs)},testid={len(testid_locs)},css={len(css_locs)})  flows={len(flows)}  linkedEp={len(linked)}  conf={conf}")

        if brittle:
            print(f"       ⚠️  brittle/CSS: {[l['name'] for l in brittle]}")
        if low_conf:
            print(f"       ⚠️  low-confidence (<0.7): {[l['name'] for l in low_conf]}")
        if not locs:
            issues_pages.append(f"  ❌  {route} — 0 locators (LLM will guess all selectors)")
        if auth_r is None:
            issues_pages.append(f"  ⚠️  {route} — authRequired not set")
        if dynamic and not pg.get("routeParams"):
            issues_pages.append(f"  ⚠️  {route} — isDynamic=true but routeParams=[]")

    print(f"\n  Locator totals: {total_locators} total | {interactive_locators} interactive | {brittle_locators} brittle/CSS | {low_conf_locators} low-conf")
    if issues_pages:
        print(f"\n  PAGE ISSUES ({len(issues_pages)}):")
        for i in issues_pages:
            print(i)
    else:
        print("  ✅  No page issues")

    # ── chunks ──────────────────────────────────────────────────────────────
    print(f"\n── CHUNKS ({len(chunks)}) ──────────────────────────────────────────")

    ep_ids_in_chunks = set()
    page_ids_in_chunks = set()
    issues_chunks = []

    for fname, chunk in chunks:
        meta = chunk  # chunk file IS the chunk object (not nested)
        domain    = meta.get("domain","?")
        out_file  = meta.get("outputFileName","?")
        ch_data   = meta.get("chunk", {})
        ep_list   = ch_data.get("endpoints", [])
        pg_list   = ch_data.get("pages", [])
        llm_msg   = meta.get("llmUserMessage","")
        has_pages = meta.get("hasPages", False)

        for ep in ep_list:
            ep_ids_in_chunks.add(ep.get("id",""))
        for pg in pg_list:
            page_ids_in_chunks.add(pg.get("id",""))

        ep_methods = [f"{e.get('method','?').upper()} {e.get('path',e.get('route','?'))}" for e in ep_list]
        pg_routes  = [p.get("route", p.get("path","?")) for p in pg_list]
        llm_len    = len(llm_msg)
        print(f"  📦 {fname}")
        print(f"       domain={domain}  out={out_file}  eps={len(ep_list)}  pgs={len(pg_list)}  llmMsg={llm_len}chars")
        if ep_methods:
            print(f"       endpoints: {ep_methods}")
        if pg_routes:
            print(f"       pages: {pg_routes}")
        if llm_len < 100:
            issues_chunks.append(f"  ⚠️  {fname} — llmUserMessage very short ({llm_len} chars)")

    # cross-check: all BP endpoints in chunks?
    missing_ep  = ep_ids_in_bp - ep_ids_in_chunks
    missing_pg  = page_ids_in_bp - page_ids_in_chunks
    print(f"\n  Cross-check endpoints in chunks: {pct(len(ep_ids_in_bp)-len(missing_ep), len(ep_ids_in_bp))}")
    print(f"  Cross-check pages in chunks:     {pct(len(page_ids_in_bp)-len(missing_pg), len(page_ids_in_bp))}")
    if missing_ep:
        print(f"  ❌  Endpoints NOT in any chunk: {missing_ep}")
    if missing_pg:
        print(f"  ❌  Pages NOT in any chunk: {missing_pg}")
    if issues_chunks:
        print(f"\n  CHUNK ISSUES:")
        for i in issues_chunks:
            print(i)
    else:
        print("  ✅  No chunk issues")

    # ── overall score ───────────────────────────────────────────────────────
    total_issues = len(issues_ep) + len(issues_pages) + len(issues_chunks) + len(missing_ep) + len(missing_pg)
    print(f"\n── OVERALL ──────────────────────────────────────────────────────────")
    print(f"  Endpoints: {len(endpoints)}  |  Pages: {len(pages)}  |  Chunks: {len(chunks)}  |  Total issues: {total_issues}")
    confidence = max(0, 100 - (total_issues * 5))
    bar = "█" * (confidence // 5) + "░" * (20 - confidence // 5)
    print(f"  Blueprint quality: [{bar}] {confidence}%")

# ─── run ─────────────────────────────────────────────────────────────────────

print("\n" + "═"*72)
print("  SMOKEFORGE BLUEPRINT + CHUNK DEEP VALIDATION REPORT")
print("═"*72)

for label, out_dir, repo_name in REPOS:
    if not (BASE / out_dir).exists():
        print(f"\n  ⚠️  {out_dir} not found — skipping")
        continue
    analyse_repo(label, out_dir, repo_name)

sep()
print("Done.\n")
