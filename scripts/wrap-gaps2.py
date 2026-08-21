#!/usr/bin/env python3
"""HTML-literal gap fill, v2: handle double-quoted HTML inside single-quoted JS strings.

The body contains " chars (attributes) — split >中文< spans and rebuild with the
ORIGINAL quote char for non-CJK parts; CJK spans become t('…').
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

new_keys = set()
stats = {'html': 0}
out_lines = []

for line in src.split('\n'):
    s = line.strip()
    if not CJK.search(line) or s.startswith('//') or s.startswith('*') or s.startswith('/*') \
       or re.match(r'^\s*console\.', line):
        out_lines.append(line); continue
    if '`' in line:
        out_lines.append(line); continue  # template lines untouched

    new_line = line
    for m in reversed(list(STR_RE.finditer(new_line))):
        q, body = m.group(1), m.group(2)
        start, end = m.span()
        left = new_line[max(0, start-40):start]
        if re.search(r'(?:\bt|I18N\.t)\s*\(\s*$', left): continue
        if '${' in body or '\n' in body: continue
        if not ('<' in body and '>' in body and CJK.search(body)): continue
        # must contain escaped quotes (\" ) meaning HTML attrs inside
        if '\\"' not in body: continue

        spans, okflag = [], True
        for im in INNER_RE.finditer(body):
            text = im.group(1)
            if not CJK.search(text): continue
            key = text.strip()
            if not key or len(key) > 80 or '\\' in text or q in text:
                okflag = False; break
            s_, e_ = im.span(1)
            spans.append((s_, e_, key))
        if not okflag or not spans: continue

        bits, cur = [], 0
        for s_, e_, key in spans:
            if s_ > cur: bits.append(f"{q}{body[cur:s_]}{q}")
            new_keys.add(key)
            bits.append(f"t('{key}')")
            cur = e_
        if cur < len(body): bits.append(f"{q}{body[cur:]}{q}")
        new_line = new_line[:start] + ' + '.join(bits) + new_line[end:]
        stats['html'] += 1
    out_lines.append(new_line)

result = '\n'.join(out_lines)
TARGET.write_text(result, encoding='utf-8')
chk = subprocess.run(['node', '--check', str(TARGET)], capture_output=True, text=True)
if chk.returncode != 0:
    TARGET.write_text(src, encoding='utf-8')
    print('SYNTAX ERROR — reverted'); print(chk.stderr[:1200]); sys.exit(1)

for k in new_keys:
    ZH.setdefault(k, k); EN.setdefault(k, k)
ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
EN_PATH.write_text(json.dumps(EN, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f"OK html={stats['html']} new_keys={len(new_keys)}")
for k in sorted(new_keys): print('  KEY:', k)
