import json, glob, os, re

BASE = "/Users/bharatmalik/Documents/GitHub/JSSmoketest"

stats = {"total_pages": 0, "pages_with_locators": 0, "pages_no_locators": 0, "total_locators": 0, "bad_locators": []}

valid_strategies = {'role', 'label', 'text', 'testid', 'placeholder', 'css', 'xpath', 'heading', 'button', 'link', 'input', 'custom', 'aria'}

for output_dir in [f'{BASE}/smokeforge-output/dry-run-nextjs', f'{BASE}/smokeforge-output/dry-run-express', f'{BASE}/smokeforge-output/dry-run-remix']:
    repo = output_dir.split('-')[-1]
    for cf in sorted(glob.glob(f'{output_dir}/chunks/*.json')):
        data = json.load(open(cf))
        chunk = data.get('chunk', {})
        chunk_name = cf.split('/')[-1]

        for page in chunk.get('pages', []):
            stats["total_pages"] += 1
            locators = page.get('locators', [])

            if not locators:
                stats["pages_no_locators"] += 1
                continue

            stats["pages_with_locators"] += 1

            for loc in locators:
                stats["total_locators"] += 1
                code = loc.get('playwrightCode', '')
                name = loc.get('name', '')
                strategy = loc.get('strategy', '')

                if not code or code.strip() == '':
                    stats["bad_locators"].append(f"[{repo}] {chunk_name} | {page['route']} | EMPTY playwrightCode for '{name}'")

                if 'undefined' in code or code.strip() == 'null':
                    stats["bad_locators"].append(f"[{repo}] {chunk_name} | {page['route']} | undefined/null in: {code[:120]}")

                # Dynamic segment [param] leaking into locator code
                # Valid CSS selectors always have an operator: [name="x"], [type="y"]
                # Bad dynamic segments are bare: [id], [appointmentId], [dynamicRoute]
                if re.search(r'\[[a-zA-Z][a-zA-Z0-9_-]*\]', code):
                    stats["bad_locators"].append(f"[{repo}] {chunk_name} | {page['route']} | DYNAMIC SEGMENT IN LOCATOR CODE: {code[:120]}")

                # Unknown strategy
                if strategy and strategy.lower() not in valid_strategies:
                    stats["bad_locators"].append(f"[{repo}] {chunk_name} | {page['route']} | UNKNOWN strategy '{strategy}' for '{name}'")

                # Locator code missing page. prefix (would crash)
                if code and not code.startswith('page.') and not code.startswith('//') and not code.startswith('#'):
                    stats["bad_locators"].append(f"[{repo}] {chunk_name} | {page['route']} | MISSING page. prefix: {code[:120]}")

print(f"Pages total:       {stats['total_pages']}")
print(f"  With locators:   {stats['pages_with_locators']}")
print(f"  No locators:     {stats['pages_no_locators']}  (LLM uses getByRole/getByLabel fallback)")
print(f"Total locators:    {stats['total_locators']}")
print(f"Bad locators:      {len(stats['bad_locators'])}")

if stats['bad_locators']:
    print("\nISSUES:")
    for b in stats['bad_locators']:
        print(" ", b)
else:
    print("\n[OK] All locators pass validation")

# Sample 5 locators from each repo for human review
print("\n--- SAMPLE LOCATORS (5 per repo) ---")
for output_dir in [f'{BASE}/smokeforge-output/dry-run-nextjs', f'{BASE}/smokeforge-output/dry-run-express', f'{BASE}/smokeforge-output/dry-run-remix']:
    repo = output_dir.split('-')[-1]
    print(f"\n[{repo}]")
    shown = 0
    for cf in sorted(glob.glob(f'{output_dir}/chunks/*.json')):
        if shown >= 5:
            break
        data = json.load(open(cf))
        for page in data.get('chunk', {}).get('pages', []):
            for loc in page.get('locators', [])[:2]:
                if shown >= 5:
                    break
                print(f"  route={page['route']}  name={loc.get('name')}  strategy={loc.get('strategy')}")
                print(f"    code: {loc.get('playwrightCode', '')[:100]}")
                shown += 1
