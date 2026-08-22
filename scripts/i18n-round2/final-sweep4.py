#!/usr/bin/env python3
"""Sweep 4: L5589 tail + L10849 confirm()."""
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


p = ROOT / 'public/js/admin.js'
src = p.read_text(encoding='utf-8')
backup = src

fixes = [
    ("</strong>本供应商下 <strong>${staleModels.length}",
     "</strong>${t('本供应商下')} <strong>${staleModels.length}"),
]
n = 0
for old, new in fixes:
    if old in src:
        src = src.replace(old, new)
        n += 1
        for m in re.finditer(r"t\('([^']*[\u4e00-\u9fff][^']*)'\)", new):
            add(m.group(1))

# confirm line: find actual form
m = re.search(r"confirm\('模型测试将发送一条真实请求[^\n]*\)", src)
if m:
    line = m.group(0)
    inner = line[len("confirm('"):-len("')")]
    # inner contains \" escapes already; build t() call with same escaping
    new_call = "confirm(t('" + inner + "'))"
    src = src.replace(line, new_call)
    n += 1
    key = inner.replace('\\"', '"').replace('\\n', '\n')
    add(key)

if n:
    p.write_text(src, encoding='utf-8')
    c = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
    if c.returncode != 0:
        p.write_text(backup, encoding='utf-8')
        print('SYNTAX ERROR reverted:', c.stderr[:250])
        raise SystemExit(1)
print(f'{n} applied')
(ROOT / 'lang/zh.json').write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(ROOT / 'lang/en.json').write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                                   encoding='utf-8')
print(f'zh={len(ZH)}')
