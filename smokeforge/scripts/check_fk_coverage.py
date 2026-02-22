#!/usr/bin/env python3
"""
Cross-reference FK fields in each chunk.
Separate REQUIRED FK gaps (will cause test failures) from optional ones.
"""
import json
import glob
import os

BASE = "/Users/bharatmalik/Documents/GitHub/JSSmoketest/smokeforge-output"

for bp_path in sorted(glob.glob(BASE + "/dry-run-*/blueprint.json")):
    name = bp_path.split("dry-run-")[1].split("/")[0]
    b    = json.load(open(bp_path))
    eps  = b["endpoints"]

    chunk_dir = bp_path.replace("blueprint.json", "chunks/")
    ep_to_domain = {}
    for cf in sorted(os.listdir(chunk_dir)):
        if not cf.endswith(".json"):
            continue
        c = json.load(open(os.path.join(chunk_dir, cf)))
        for ep in c["chunk"]["endpoints"]:
            ep_to_domain[ep["id"]] = c["chunk"]["domain"]

    required_gaps = []
    optional_gaps = []

    for ep in eps:
        body   = ep.get("requestBody") or {}
        fields = body.get("fields", [])
        domain = ep_to_domain.get(ep["id"], "?")

        same_chunk_gets = [
            e for e in eps
            if ep_to_domain.get(e["id"]) == domain and e["method"] == "GET"
        ]
        get_paths = [e["path"] for e in same_chunk_gets]

        for f in fields:
            fname = f["name"]
            if not (fname.endswith("Id") or fname.endswith("ID")):
                continue
            resource = fname.replace("Id", "").replace("ID", "").lower()
            can_resolve = any(resource in p.lower() for p in get_paths)
            if can_resolve:
                continue

            entry = "  {:6} {}  fk={}  (GET endpoints in chunk: {})".format(
                ep["method"], ep["path"], fname, get_paths or ["none"]
            )
            if f.get("required"):
                required_gaps.append(entry)
            else:
                optional_gaps.append(entry)

    print("\n" + "=" * 70)
    print("REPO: {}  ({} endpoints)".format(name, len(eps)))
    print("=" * 70)

    if required_gaps:
        print("  REQUIRED FK — no same-chunk GET  →  HIGH RISK OF TEST FAILURE:")
        for r in required_gaps:
            print("    ❌" + r)
    else:
        print("  ✅ No REQUIRED FK gaps")

    if optional_gaps:
        print("  Optional FK — no same-chunk GET  →  LLM can omit (tests pass without them):")
        for r in optional_gaps:
            print("    ⚠️ " + r)

print()
