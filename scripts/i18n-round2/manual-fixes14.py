#!/usr/bin/env python3
"""Fix concat lines (single-quoted) wrongly given ${t()} — convert to + t() +."""
from pathlib import Path
import json, re, subprocess

ROOT = Path('/data/CrewRouter')
ZH = json.loads((ROOT/'lang/zh.json').read_text(encoding='utf-8'))
EN = json.loads((ROOT/'lang/en.json').read_text(encoding='utf-8'))

def add(k):
    if k and re.search(r'[\u4e00-\u9fff]', k):
        ZH.setdefault(k.strip(), k.strip()); EN.setdefault(k.strip(), k.strip())

p = ROOT / 'public/js/admin.js'
src = p.read_text(encoding='utf-8')
backup = src

fixes = [
    ("? '${t('文件通常位于')} <code>~/.grok/auth.json</code>'",
     "? t('文件通常位于') + ' <code>~/.grok/auth.json</code>'"),
    (": '${t('文件通常位于')} <code>~/.codex/auth.json</code>'",
     ": t('文件通常位于') + ' <code>~/.codex/auth.json</code>'"),
]
n = 0
for old, new in fixes:
    if old in src:
        src = src.replace(old, new)
        n += 1
add('文件通常位于')

p.write_text(src, encoding='utf-8')
c = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
if c.returncode != 0:
    p.write_text(backup, encoding='utf-8')
    print('SYNTAX ERROR reverted:', c.stderr[:250])
    raise SystemExit(1)
(ROOT/'lang/zh.json').write_text(json.dumps(ZH, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
(ROOT/'lang/en.json').write_text(json.dumps({k: EN.get(k,k) for k in ZH}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(f'{n} applied')
