import json, glob, re, os

BASE = "/Users/bharatmalik/Documents/GitHub/JSSmoketest"

repos = [
    ("nextjs",   f"{BASE}/smokeforge-output/dry-run-nextjs"),
    ("express",  f"{BASE}/smokeforge-output/dry-run-express"),
    ("remix",    f"{BASE}/smokeforge-output/dry-run-remix"),
]

for repo_name, out_dir in repos:
    bp = json.load(open(f"{out_dir}/blueprint.json"))
    chunks = sorted(glob.glob(f"{out_dir}/chunks/*.json"))

    total_ep = 0
    total_pages = 0
    locator_pages = 0
    total_locators = 0

    # Risks
    risks = []

    # Per-endpoint analysis
    ep_with_zero_get_fk = 0       # required FK, no GET anywhere in blueprint
    ep_with_crosschunk_fk = 0     # required FK resolved via cross-chunk hint
    ep_no_body_issues = 0
    ep_path_param_no_hint = 0
    ep_page_routes = 0
    ep_api_routes = 0

    # Auth
    auth = bp.get("auth")
    auth_type = auth.get("tokenType", "NONE") if auth else "NONE"
    auth_login = auth.get("loginEndpoint", "NONE") if auth else "NONE"
    auth_token_path = auth.get("tokenResponsePath", "") if auth else ""
    auth_cookie = auth.get("authCookieName", "") if auth else ""
    auth_body_format = auth.get("loginBodyFormat", "") if auth else ""
    creds = auth.get("defaultEmail", "?") if auth else "?"

    for cf in chunks:
        data = json.load(open(cf))
        chunk = data.get("chunk", {})
        msg = data.get("llmUserMessage", "")

        for ep in chunk.get("endpoints", []):
            total_ep += 1
            if ep.get("isPageRoute"):
                ep_page_routes += 1
            else:
                ep_api_routes += 1

            # Check path params with no hint in message
            if ep.get("pathParams") and len(ep.get("pathParams", [])) > 0:
                ep_path = ep.get("path", "")
                # The chunk message should have "GET the list endpoint" hint
                # This is always present from the extractor

            # Check for FK fields with no GET resolution
            body = ep.get("requestBody", {})
            if body:
                for f in body.get("fields", []):
                    if re.search(r'Id$', f.get("name", ""), re.I) and f.get("required"):
                        # Check what kind of hint is in the message for this field
                        field_line = [l for l in msg.splitlines() if f["name"] in l and "FK" in l]
                        if field_line:
                            line = field_line[0]
                            if "no list endpoint found" in line:
                                ep_with_zero_get_fk += 1
                                risks.append(f"  ⚠ REQUIRED FK with no GET: {ep['method']} {ep['path']} → {f['name']}")
                            elif "CROSS-CHUNK" in line:
                                ep_with_crosschunk_fk += 1

        for page in chunk.get("pages", []):
            total_pages += 1
            locs = page.get("locators", [])
            if locs:
                locator_pages += 1
                total_locators += len(locs)

    # Scoring
    score = 100

    # Auth penalties
    if not auth:
        risks.insert(0, "  ✗ NO auth detected — all endpoints assumed public")
        score -= 20
    else:
        if not auth.get("defaultEmail"):
            risks.insert(0, "  ✗ No defaultEmail in auth — LLM will have to guess credentials")
            score -= 15
        if auth_type == "bearer_jwt" and not auth_token_path:
            risks.append("  ⚠ bearer_jwt but no tokenResponsePath — LLM may use wrong path to extract token")
            score -= 5

    # Required FK with zero resolution
    if ep_with_zero_get_fk > 0:
        score -= ep_with_zero_get_fk * 5
        # already listed in risks above

    # Cross-chunk FK is OK with the new hints but adds complexity
    if ep_with_crosschunk_fk > 0:
        score -= ep_with_crosschunk_fk * 2  # minor risk

    # Page routes vs API routes ratio
    if ep_page_routes > 0:
        # Page routes need browser tests vs APIRequestContext — LLMs sometimes mix these
        score -= min(ep_page_routes * 3, 15)

    # No locators on pages with routes — minor
    no_loc_pages = total_pages - locator_pages
    if no_loc_pages > 0:
        score -= no_loc_pages * 2

    score = max(0, min(100, score))

    # Confidence map
    if score >= 85:
        verdict = "HIGH"
        emoji = "✅"
    elif score >= 70:
        verdict = "MEDIUM-HIGH"
        emoji = "🟡"
    elif score >= 55:
        verdict = "MEDIUM"
        emoji = "🟠"
    else:
        verdict = "LOW"
        emoji = "🔴"

    print(f"\n{'='*65}")
    print(f"  {emoji}  {repo_name.upper():<12} Confidence Score: {score}/100  [{verdict}]")
    print(f"{'='*65}")
    print(f"  Auth:          {auth_type}  login={auth_login}")
    print(f"  Credentials:   email={creds}")
    if auth_type == "bearer_jwt":
        print(f"  Token path:    {auth_token_path or '(none — uses .accessToken default)'}")
    if auth_type == "session_cookie":
        print(f"  Cookie name:   {auth_cookie}  format={auth_body_format}")
    print(f"  Endpoints:     {ep_api_routes} API + {ep_page_routes} page routes = {total_ep} total")
    print(f"  Pages:         {total_pages} ({locator_pages} with locators, {total_locators} locators)")
    print(f"  Chunks:        {len(chunks)}")
    print(f"  Required FKs:  {ep_with_crosschunk_fk} cross-chunk (hinted), {ep_with_zero_get_fk} unresolvable")
    if risks:
        print(f"  RISKS:")
        for r in risks:
            print(f"   {r}")
    else:
        print(f"  No blocking risks detected")
