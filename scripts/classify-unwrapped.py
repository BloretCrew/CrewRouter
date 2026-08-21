#!/usr/bin/env python3
"""Classify the 158 'unwrapped' app.js literals: real UI text vs intentionally skipped."""
import json
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')
src = (ROOT / 'public/js/app.js').read_text(encoding='utf-8')
zh = json.loads((ROOT / 'lang/zh.json').read_text(encoding='utf-8'))
CJK = re.compile(r'[\u4e00-\u9fff]')
STR_RE = re.compile(r"""(['"])((?:\\.|(?!\1).)*?)\1""")
def unesc(b): return b.replace("\\'", "'").replace('\\"','"').replace('\\n','\n').replace('\\t','\t').replace('\\\\','\\')

cats = {'console-log': [], 'selector': [], 'debug-tag': [], 'html-literal': [], 'in-template': [], 'other': []}
for ln, line in enumerate(src.split('\n'), 1):
    s = line.strip()
    if not CJK.search(line) or s.startswith('//') or s.startswith('*') or s.startswith('/*'):
        continue
    in_template = '`' in line
    for m in STR_RE.finditer(line):
        raw = unesc(m.group(2))
        if not CJK.search(raw) or '\n' in raw: continue
        left = line[max(0, m.start()-40):m.start()]
        if re.search(r'(?:\bt|I18N\.t)\s*\(\s*$', left): continue
        if raw in zh and f"t('{raw[:20]}" in line: continue
        if re.match(r'^\s*(console\.(error|warn|log|info))', s):
            cats['console-log'].append((ln, raw))
        elif raw.startswith(('.', '#', '[')) or 'querySelector' in left:
            cats['selector'].append((ln, raw))
        elif raw.strip().startswith('[') and (']' in raw.split(']')[1][:6] if ']' in raw else False):
            cats['debug-tag'].append((ln, raw))
        elif '<' in raw and '>' in raw:
            cats['html-literal'].append((ln, raw))
        elif in_template:
            cats['in-template'].append((ln, raw))
        else:
            cats['other'].append((ln, raw))

for c, items in cats.items():
    print(f'{c}: {len(items)}')
    for ln, s in items[:6]: print(f'   L{ln}:', repr(s[:70]))
