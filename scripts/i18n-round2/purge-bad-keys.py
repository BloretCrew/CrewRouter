#!/usr/bin/env python3
"""Purge bad keys (HTML/markup swallowed into i18n keys) from zh.json/en.json,
and locate where each bad key is referenced in JS so those call sites can be
re-wrapped correctly.

Bad key = contains HTML tags or attr syntax. For each bad key:
1. find t('<key>') occurrences in public/js
2. print file:line + full line for manual/automated repair
"""
import json
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')
zh = json.loads((ROOT / 'lang' / 'zh.json').read_text(encoding='utf-8'))
en = json.loads((ROOT / 'lang' / 'en.json').read_text(encoding='utf-8'))
BAD = re.compile(r'<[a-zA-Z/][^>]*>|\btitle=|\bstyle=|\bclass=|</|\'>|">')

bad_keys = [k for k in zh if BAD.search(k)]
print(f"bad keys: {len(bad_keys)}")

# find references
js_files = sorted((ROOT / 'public' / 'js').glob('*.js'))
refs = {}
for k in bad_keys:
    pat = re.compile(r"\bt\(" + re.escape("'" + k.replace("'", "\\'") + "'") + r"\)")
    hits = []
    for f in js_files:
        for i, line in enumerate(f.read_text(encoding='utf-8').split('\n'), 1):
            if pat.search(line):
                hits.append((f.name, i, line.strip()[:180]))
    refs[k] = hits

n_refs = sum(len(v) for v in refs.values())
print(f"total bad references: {n_refs}")
out = Path('/tmp/bad-refs.txt')
with out.open('w', encoding='utf-8') as fh:
    for k, hits in refs.items():
        fh.write(f"KEY: {k!r}\n")
        for name, i, line in hits:
            fh.write(f"  {name}:L{i}: {line}\n")
        if not hits:
            fh.write("  (no JS reference — orphan)\n")
print(f"details → {out}")

# remove bad keys from catalogs
for k in bad_keys:
    zh.pop(k, None)
    en.pop(k, None)
(ROOT / 'lang' / 'zh.json').write_text(json.dumps(zh, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(ROOT / 'lang' / 'en.json').write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f"purged; zh={len(zh)} en={len(en)}")
