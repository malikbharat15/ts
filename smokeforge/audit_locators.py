"""
Deep locator audit: checks every locator in the blueprint against
Playwright strictness rules and page uniqueness constraints.
Reads directly from the blueprint (not chunks) so it reflects the latest analyze run.
"""
import json, re, glob
from collections import defaultdict

BLUEPRINT = '/Users/bharatmalik/Documents/GitHub/JSSmoketest/smokeforge/smokeforge-output/remix-healthcare-blueprint.json'

with open(BLUEPRINT) as f:
    bp = json.load(f)

pages_raw = bp.get('pages', [])

page_locators = []
for page in pages_raw:
    page_locators.append({'route': page.get('route', '?'), 'locs': page.get('locators', [])})

PROBLEMS = []

for pg in page_locators:
    route = pg['route']
    locs = pg['locs']

    # Collect pw_code per page for duplicates
    pw_codes_on_page = defaultdict(list)
    for loc in locs:
        pw = loc.get('playwrightCode', '').strip()
        if pw:
            pw_codes_on_page[pw].append(loc.get('name', '?'))

    for loc in locs:
        pw       = loc.get('playwrightCode', '').strip()
        name     = loc.get('name', '?')
        strategy = loc.get('strategy', '?')
        flags    = loc.get('flags', [])
        is_inter = loc.get('isInteractive', False)
        is_cond  = loc.get('isConditional', False)
        is_dyn   = loc.get('isDynamic', False)
        conf     = loc.get('confidence', 0)

        problems = []

        # 1. UNQUALIFIED ROLE — role selectors without { name: } for interactive elements
        #    These will throw "strict mode violation" if >1 exist on page
        unqualified_match = re.search(
            r"getByRole\('(textbox|combobox|spinbutton|button|link|checkbox|radio|tab|menuitem)'\)\s*$",
            pw
        )
        if unqualified_match and is_inter:
            problems.append(f"UNQUALIFIED_ROLE:{unqualified_match.group(1)} — strict mode will fail if >1 on page")

        # 2. DUPLICATE pw code on same page — Playwright strict mode throws if locator matches >1
        if pw and len(pw_codes_on_page[pw]) > 1:
            problems.append(f"DUPLICATE_ON_PAGE — same pw code shared by: {pw_codes_on_page[pw]}")

        # 3. DYNAMIC_LIST + interactive — picking from a list without .first()/.nth() will fail
        if 'DYNAMIC_LIST' in flags and is_inter:
            problems.append("DYNAMIC_LIST_INTERACTIVE — locator matches multiple items, needs .first() or .nth()")

        # 4. DYNAMIC_LIST on view locators — fine for exists checks but .click() will fail
        if 'DYNAMIC_LIST' in flags and not is_inter:
            problems.append("DYNAMIC_LIST_VIEW — safe for count/visible checks, not for .click()")

        # 5. Heading with partial text — trailing '(' means text will only match partial heading
        if 'heading' in pw and re.search(r"name: '.*\($'\)", pw):
            problems.append("HEADING_PARTIAL — heading name ends with '(' which may not fully match")

        # 6. 'main' role — getByRole('main') is document-level, always present but not useful as assertion
        if "getByRole('main')" in pw:
            problems.append("ROLE_MAIN — page.getByRole('main') always exists; useless as assertion")

        # 7. Conditional locators flagged — test must guard with .isVisible() before interacting
        if is_cond:
            problems.append("CONDITIONAL — may not be present on all render paths, needs isVisible() guard")

        if problems:
            PROBLEMS.append({
                'route': route, 'name': name,
                'pw': pw, 'strategy': strategy,
                'interactive': is_inter, 'problems': problems
            })

# ─── REPORT ──────────────────────────────────────────────────────────────────
W = 110
print(f"\n{'='*W}")
print(f"  LOCATOR AUDIT — {sum(len(p['locs']) for p in page_locators)} locators across {len(page_locators)} pages")
print(f"  Issues: {len(PROBLEMS)}")
print(f"{'='*W}\n")

by_cat = defaultdict(list)
for p in PROBLEMS:
    for prob in p['problems']:
        cat = prob.split(' —')[0].split(':')[0]
        by_cat[cat].append(p)

for cat, items in sorted(by_cat.items(), key=lambda x: -len(x[1])):
    print(f"  [{cat}] — {len(items)} occurrence(s)")
    for item in items:
        print(f"    PAGE {item['route']:<45} locator: {item['name']}")
        print(f"      pw: {item['pw']}")
        for prob in item['problems']:
            if cat in prob:
                print(f"      !! {prob}")
    print()

# ─── WILL-IT-PASS VERDICT ────────────────────────────────────────────────────
strict_failures = [p for p in PROBLEMS if any(
    k in prob for prob in p['problems']
    for k in ['UNQUALIFIED_ROLE', 'DUPLICATE_ON_PAGE', 'DYNAMIC_LIST_INTERACTIVE']
)]
likely_failures = [p for p in PROBLEMS if any(
    'CONDITIONAL' in prob for prob in p['problems']
)]

print(f"\n{'='*W}")
print(f"  VERDICT: WILL PLAYWRIGHT UI TESTS PASS ON FIRST RUN?")
print(f"{'='*W}")
print(f"\n  STRICT FAILURES (will throw on first attempt):  {len(strict_failures)}")
for p in strict_failures:
    print(f"    PAGE {p['route']} — {p['name']} — {p['pw']}")

print(f"\n  CONDITIONAL GUARDS NEEDED (intermittent failures): {len(likely_failures)}")
for p in likely_failures:
    print(f"    PAGE {p['route']} — {p['name']}")

harmless  = [p for p in PROBLEMS if p not in strict_failures and p not in likely_failures]
print(f"\n  HARMLESS/ADVISORY (won't break tests):  {len(harmless)}")
for p in harmless:
    print(f"    PAGE {p['route']} — {p['name']}: {p['problems'][0].split(' —')[0]}")

verdict = "NO — fix strict failures first" if strict_failures else ("LIKELY YES — with caveats" if likely_failures else "YES — locators look clean")
print(f"\n  --> {verdict}\n")
