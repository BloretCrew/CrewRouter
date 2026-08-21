#!/usr/bin/env python3
"""Final gap-fill: wrap the real user-facing leftovers.

Targets:
1. html-literal (94): >中文< inside quoted HTML strings → t() concat (pass-2 logic, line-safe)
2. in-template/other ternaries (L576, L9097, L10070): wrap each branch
3. console-log (54) + comments + selector: intentionally skipped (dev-facing)
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path('/data/CrewRouter')
TARGET = ROOT / 'public/js/app.js'
ZH_PATH = ROOT / 'lang/zh.json'
EN_PATH = ROOT / 'lang/en.json'
ZH = json.loads(ZH_PATH.read_text(encoding='utf-8'))
EN = json.loads(EN_PATH.read_text(encoding='utf-8'))
src = TARGET.read_text(encoding='utf-8')
CJK = re.compile(r'[\u4e00-\u9fff]')
STR_RE = re.compile(r"""(['"])((?:\\.|(?!\1).)*?)\1""")
INNER_RE = re.compile(r">([^<>]{1,80})<")
def unesc(b): return b.replace("\\'", "'").replace('\\"','"').replace('\\n','\n').replace('\\t','\t').replace('\\\\','\\')

new_keys = set()
out_lines = []
stats = {'html': 0, 'ternary': 0}

for line in src.split('\n'):
    s = line.strip()
    if not CJK.search(line) or s.startswith('//') or s.startswith('*') or s.startswith('/*'):
        out_lines.append(line); continue
    is_console = bool(re.match(r'^\s*console\.', line))
    if is_console:
        out_lines.append(line); continue

    new_line = line
    # process matches right-to-left to keep offsets
    matches = list(STR_RE.finditer(new_line))
    for m in reversed(matches):
        q, body = m.group(1), m.group(2)
        raw = unesc(body)
        if not CJK.search(raw) or '\n' in raw: continue
        start, end = m.span()
        left = new_line[max(0, start-40):start]
        if re.search(r'(?:\bt|I18N\.t)\s*\(\s*$', left): continue
        if raw.startswith(('.', '#', '[')) or 'querySelector' in left: continue
        if raw.strip().startswith('//'): continue

        # case A: plain short UI text inside template ternary (no HTML)
        if '<' not in raw and '>' not in raw and '${' not in raw and len(raw) <= 40:
            key = raw.strip()
            if not key or any(c in raw for c in ('\\', '"')): continue
            if q == '"':  # only touch single-quoted to avoid attribute mess
                continue
            new_keys.add(key)
            new_line = new_line[:start] + f"t('{key}')" + new_line[end:]
            stats['ternary'] += 1
            continue

        # case B: HTML literal → split >中文< spans
        if '<' in raw and '>' in raw and "'" not in raw and '"' not in raw and '\\' not in body:
            spans = []
            okflag = True
            for im in INNER_RE.finditer(raw):
                text = im.group(1)
                if not CJK.search(text): continue
                key = text.strip()
                if not key or len(key) > 80 or any(c in text for c in ('\\', '"', "'")):
                    okflag = False; break
                s_, e_ = im.span(1)
                spans.append((s_, e_, key))
            if not okflag or not spans: continue
            bits, cur = [], 0
            for s_, e_, key in spans:
                if s_ > cur: bits.append(f"{q}{raw[cur:s_]}{q}")
                new_keys.add(key)
                bits.append(f"t('{key}')")
                cur = e_
            if cur < len(raw): bits.append(f"{q}{raw[cur:]}{q}")
            new_line = new_line[:start] + ' + '.join(bits) + new_line[end:]
            stats['html'] += 1

    out_lines.append(new_line)

result = '\n'.join(out_lines)
TARGET.write_text(result, encoding='utf-8')
chk = subprocess.run(['node', '--check', str(TARGET)], capture_output=True, text=True)
if chk.returncode != 0:
    TARGET.write_text(src, encoding='utf-8')
    print('SYNTAX ERROR — reverted'); print(chk.stderr[:1500]); sys.exit(1)

for k in new_keys:
    ZH.setdefault(k, k); EN.setdefault(k, k)
ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
EN_PATH.write_text(json.dumps(EN, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f"OK html={stats['html']} ternary={stats['ternary']} new_keys={len(new_keys)}")
for k in sorted(new_keys)[:30]: print('  KEY:', k)
