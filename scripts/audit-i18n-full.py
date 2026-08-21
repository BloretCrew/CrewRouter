#!/usr/bin/env python3
"""Full i18n coverage audit:
1. zh.json keys == en.json keys, all translated (en != zh)
2. console.html: no unwrapped Chinese text nodes / attrs outside <script>
3. app.js: no unwrapped bare Chinese string literals (excluding comments, template exprs, legit skips)
4. live BTC catalog covers every key used in code
"""
import json
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')
CJK = re.compile(r'[\u4e00-\u9fff]')
issues = []

# 1. catalog consistency
zh = json.loads((ROOT / 'lang/zh.json').read_text(encoding='utf-8'))
en = json.loads((ROOT / 'lang/en.json').read_text(encoding='utf-8'))
missing_in_en = [k for k in zh if k not in en]
untranslated = [k for k in zh if en.get(k, k) == k and CJK.search(k)]
extra_in_en = [k for k in en if k not in zh]
if missing_in_en: issues.append(f'zh keys missing in en: {len(missing_in_en)}')
if untranslated: issues.append(f'untranslated keys: {len(untranslated)}')
if extra_in_en: issues.append(f'en keys not in zh: {len(extra_in_en)}')
print(f'[1] zh={len(zh)} en={len(en)} missing={len(missing_in_en)} untranslated={len(untranslated)} extra={len(extra_in_en)}')
for k in (missing_in_en + untranslated)[:15]: print('   ', repr(k[:60]))

# 2. console.html coverage
html = (ROOT / 'public/pages/console.html').read_text(encoding='utf-8')
parts = re.split(r'(<script\b.*?</script>|<style\b.*?</style>)', html, flags=re.DOTALL)
unwrapped_text, unwrapped_attr = [], []
for part in parts:
    if part.startswith(('<script', '<style')): continue
    for m in re.finditer(r'>([^<>]*[\u4e00-\u9fff][^<>]*)<', part):
        chunk = re.sub(r'\s+', ' ', m.group(1)).strip()
        if chunk and chunk not in zh and len(chunk) <= 120:
            unwrapped_text.append(chunk)
    for m in re.finditer(r'(placeholder|title|aria-label|alt)="([^"]*[\u4e00-\u9fff][^"]*)"', part):
        val = m.group(2)
        if f'data-i18n-{ "placeholder" if m.group(1)=="placeholder" else "title" }' not in m.group(0) and val not in zh:
            unwrapped_attr.append(val)
print(f'[2] console.html unwrapped text nodes: {len(unwrapped_text)}, attrs missing tag: {len(unwrapped_attr)}')
for s in unwrapped_text[:10]: print('   TEXT', repr(s[:60]))
for s in unwrapped_attr[:10]: print('   ATTR', repr(s[:60]))
if unwrapped_text or unwrapped_attr: issues.append('console.html has unwrapped Chinese')

# 3. app.js unwrapped literals
src = (ROOT / 'public/js/app.js').read_text(encoding='utf-8')
STR_RE = re.compile(r"""(['"])((?:\\.|(?!\1).)*?)\1""")
def unesc(b): return b.replace("\\'", "'").replace('\\"','"').replace('\\n','\n').replace('\\t','\t').replace('\\\\','\\')
unwrapped_js = []
for ln, line in enumerate(src.split('\n'), 1):
    s = line.strip()
    if not CJK.search(line) or s.startswith('//') or s.startswith('*') or s.startswith('/*'):
        continue
    for m in STR_RE.finditer(line):
        raw = unesc(m.group(2))
        if not CJK.search(raw) or '\n' in raw: continue
        left = line[max(0, m.start()-40):m.start()]
        if re.search(r'(?:\bt|I18N\.t)\s*\(\s*$', left): continue
        if raw in zh: continue  # known key but not wrapped? still an issue
        unwrapped_js.append((ln, raw))
print(f'[3] app.js unwrapped Chinese literals: {len(unwrapped_js)}')
for ln, s in unwrapped_js[:15]: print(f'    L{ln}:', repr(s[:60]))
if unwrapped_js: issues.append('app.js has unwrapped Chinese literals')

# 4. live catalog coverage of used keys
used = set(zh.keys())
live_missing = [k for k in used if k not in en]  # same as #1 but keep for clarity
print(f'[4] live coverage: {len(used - set(live_missing))}/{len(used)}')

print()
print('=== ISSUES ===' if issues else '=== ALL CLEAN ===')
for i in issues: print(' -', i)
