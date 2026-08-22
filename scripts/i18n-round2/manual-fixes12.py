#!/usr/bin/env python3
"""Final batch 2: last admin.js fragments + verify app.js misc lines."""
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
n = 0

fixes = [
    # L5589 tail: </strong>本供应商下 — inside template after expr
    ("</strong>${t('本供应商下')}", None),  # already done? check below
    # L5589 actual: ...永久删除</strong>本供应商下 <strong> — wrap 本供应商下
    ("永久删除</strong>本供应商下 <strong>", "永久删除</strong>${t('本供应商下')} <strong>"),
    # L5994 （约 N 小时后）
    ("`（约 ${Math.ceil(period.resetAfterSeconds / 3600)} 小时后）`",
     "`${t('（约')} ${Math.ceil(period.resetAfterSeconds / 3600)} ${t('小时后）')}`"),
    # L6061 剩余
    ("`剩余 ${formatNumber(q.onDemandLimit", "`${t('剩余')} ${formatNumber(q.onDemandLimit"),
    # L6073 历史周期
    (">历史周期</div>", ">${t('历史周期')}</div>"),
    # L6171/6172 文件通常位于
    ("文件通常位于 <code>~/.grok/auth.json</code>", "${t('文件通常位于')} <code>~/.grok/auth.json</code>"),
    ("文件通常位于 <code>~/.codex/auth.json</code>", "${t('文件通常位于')} <code>~/.codex/auth.json</code>"),
    # L6225 请输入或上传
    ("请输入或上传 auth.json", "${t('请输入或上传 auth.json')}"),
    # L5431 确定要删除此供应商吗？
    ("确定要删除此供应商吗？<br><br>", "${t('确定要删除此供应商吗？')}<br><br>"),
]
for old, new in fixes:
    if new is None:
        continue
    if old in src:
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
