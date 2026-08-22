#!/usr/bin/env python3
"""Final batch (v2): concat-safe fixes only. Lines verified by context first."""
from pathlib import Path
import json, re, subprocess

ROOT = Path('/data/CrewRouter')
ZH = json.loads((ROOT/'lang/zh.json').read_text(encoding='utf-8'))
EN = json.loads((ROOT/'lang/en.json').read_text(encoding='utf-8'))

def add(k):
    k = k.strip()
    if k and re.search(r'[\u4e00-\u9fff]', k):
        ZH.setdefault(k, k); EN.setdefault(k, EN.get(k, k))

p = ROOT / 'public/js/admin.js'
src = p.read_text(encoding='utf-8')
backup = src

# Each fix: (old, new, requires_backtick_line)
fixes = [
    # L6171/6172: concat lines → use + t() + form
    ("'文件通常位于 <code>~/.grok/auth.json</code>'",
     "t('文件通常位于') + ' <code>~/.grok/auth.json</code>'", False),
    ("'文件通常位于 <code>~/.codex/auth.json</code>'",
     "t('文件通常位于') + ' <code>~/.codex/auth.json</code>'", False),
    # L6225: alert('...') plain string
    ("alert('请输入或上传 auth.json')",
     "alert(t('请输入或上传 auth.json'))", False),
]
n = 0
for old, new, need_tpl in fixes:
    if old in src:
        idx = src.find(old)
        ls = src.rfind('\n', 0, idx)
        le = src.find('\n', idx)
        line = src[ls:le]
        has_tpl = '`' in line
        uses_expr = '${' in new
        if uses_expr and not has_tpl:
            print(f'SKIP {old[:40]!r} (concat line)')
            continue
        src = src.replace(old, new)
        n += 1
        for m in re.finditer(r"t\('([^']*[\u4e00-\u9fff][^']*)'\)", new):
            add(m.group(1))

p.write_text(src, encoding='utf-8')
c = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
if c.returncode != 0:
    p.write_text(backup, encoding='utf-8')
    print('SYNTAX ERROR reverted:', c.stderr[:250])
    raise SystemExit(1)
(ROOT/'lang/zh.json').write_text(json.dumps(ZH, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
(ROOT/'lang/en.json').write_text(json.dumps({k: EN.get(k,k) for k in ZH}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(f'{n} applied, zh={len(ZH)}')
