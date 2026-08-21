#!/usr/bin/env python3
"""Re-run full audit after gap-fill."""
import json
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')
CJK = re.compile(r'[\u4e00-\u9fff]')

zh = json.loads((ROOT / 'lang/zh.json').read_text(encoding='utf-8'))
en = json.loads((ROOT / 'lang/en.json').read_text(encoding='utf-8'))
untrans = [k for k in zh if en.get(k, k) == k and CJK.search(k)]
print(f'catalog: zh={len(zh)} en={len(en)} untranslated={len(untrans)}')
for k in untrans[:10]: print('  ', repr(k[:50]))

src = (ROOT / 'public/js/app.js').read_text(encoding='utf-8')
STR_RE = re.compile(r"""(')((?:\\.|(?!').)*?)'""")
def unesc(b): return b.replace("\\'", "'").replace('\\n','\n').replace('\\\\','\\')
leftover = []
for ln, line in enumerate(src.split('\n'), 1):
    s = line.strip()
    if not CJK.search(line) or s.startswith('//') or s.startswith('*') or s.startswith('/*'): continue
    is_console = bool(re.match(r'^\s*console\.', line))
    if '`' in line: continue
    for m in STR_RE.finditer(line):
        raw = unesc(m.group(2))
        if not CJK.search(raw) or '\n' in raw: continue
        left = line[max(0, m.start()-40):m.start()]
        if re.search(r"(?:\bt|I18N\.t)\s*\(\s*$", left): continue
        if is_console: tag='console'
        elif raw.startswith(('.', '#', '[')) or 'querySelector' in left: tag='selector'
        elif raw.strip().startswith('//'): tag='comment'
        elif '<' in raw: tag='html-mixed'
        else: tag='OTHER'
        if tag in ('OTHER',): leftover.append((ln, raw))
print('app.js real leftovers (non-console/selector/comment/html):', len(leftover))
for ln, s in leftover[:10]: print(f'  L{ln}:', repr(s[:60]))
