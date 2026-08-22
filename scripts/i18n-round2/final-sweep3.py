#!/usr/bin/env python3
"""Sweep 3: remaining title=t(...) broken attrs."""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path('/data/CrewRouter')
ZH = json.loads((ROOT / 'lang/zh.json').read_text(encoding='utf-8'))
EN = json.loads((ROOT / 'lang/en.json').read_text(encoding='utf-8'))


def add(k):
    k = k.strip()
    if k and re.search(r'[\u4e00-\u9fff]', k):
        ZH.setdefault(k, k)
        EN.setdefault(k, EN.get(k, k))


total = 0
# L11097 known shape: title=t(\'添加标签\')> inside a plain JS string
p = ROOT / 'public/js/admin.js'
src = p.read_text(encoding='utf-8')
backup = src
old = "title=t(\\'添加标签\\')>' + '+'"
new = "title=\"' + t('添加标签') + '\">' + '+'"
if old in src:
    src = src.replace(old, new)
    add('添加标签')
    p.write_text(src, encoding='utf-8')
    c = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
    if c.returncode != 0:
        p.write_text(backup, encoding='utf-8')
        print('SYNTAX ERROR reverted:', c.stderr[:200])
    else:
        print('admin.js: 1 fixed (添加标签)')
        total += 1
else:
    print('L11097 pattern not found; searching generic...')

# generic pass: title=t(\\'中文\\') → rebuild as concat
for fname in ['admin.js', 'app.js']:
    p = ROOT / 'public/js' / fname
    src = p.read_text(encoding='utf-8')
    backup = src
    pat = re.compile(r"title=t\(\\'([^']+?)\\'\)")
    cnt = 0
    for m in pat.finditer(src):
        cnt += 1
    if cnt:
        # replace each with: title="' + t('<key>') + '"
        def repl(m):
            key = m.group(1)
            add(key)
            return "title=\"' + t('" + key + "') + '\""
        src2 = pat.sub(repl, src)
        p.write_text(src2, encoding='utf-8')
        c = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
        if c.returncode != 0:
            p.write_text(backup, encoding='utf-8')
            print(fname, 'regex SYNTAX ERROR reverted:', c.stderr[:200])
        else:
            print(f'{fname}: {cnt} title=t() rebuilt')
            total += cnt

print(f'TOTAL: {total}')
(ROOT / 'lang/zh.json').write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(ROOT / 'lang/en.json').write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                                   encoding='utf-8')
print(f'zh={len(ZH)}')
