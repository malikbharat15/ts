import json, sys

with open('/Users/bharatmalik/Documents/GitHub/JSSmoketest/smokeforge/smokeforge-output/remix-healthcare-blueprint.json') as f:
    bp = json.load(f)

eps = bp['endpoints']
pages = bp.get('pages', [])

print('=== AUTH FIX VERIFICATION ===\n')

# 1. AUTH_INHERITED_FROM_LAYOUT
inherited = [e for e in eps if 'AUTH_INHERITED_FROM_LAYOUT' in e.get('flags', [])]
print(f'[Fix 2: Layout Inheritance]')
if inherited:
    for e in inherited:
        print(f'  INHERITED: {e["method"]} {e["path"]}  authType={e["authType"]}')
else:
    print('  (none) -- correct: this app uses per-route requireUser(), no layout auth parent')

# 2. Public endpoints check (should only be auth pages + session/upload already checked)
print(f'\n[Fix 1: return redirect auth guard]')
public_eps = [e for e in eps if not e['authRequired']]
print(f'  {len(public_eps)} public endpoints:')
for e in public_eps:
    print(f'  PUBLIC: {e["method"]} {e["path"]}')

print(f'\nTotals: {len(eps)} endpoints, {sum(1 for e in eps if e["authRequired"])} auth-required, {len(public_eps)} public')

# 3. Check auth.register action is still public (NOT incorrectly flagged by return redirect fix)
reg = next((e for e in eps if e['path'] == '/auth/register' and e['method'] == 'POST'), None)
if reg:
    flag = 'CORRECT (public)' if not reg['authRequired'] else '*** WRONG (should be public) ***'
    print(f'\n[Regression check] POST /auth/register authRequired={reg["authRequired"]} -> {flag}')

# 4. Check auth.login GET is still public
login_get = next((e for e in eps if e['path'] == '/auth/login' and e['method'] == 'GET'), None)
if login_get:
    flag = 'CORRECT (public)' if not login_get['authRequired'] else '*** WRONG (should be public) ***'
    print(f'[Regression check] GET /auth/login authRequired={login_get["authRequired"]} -> {flag}')
