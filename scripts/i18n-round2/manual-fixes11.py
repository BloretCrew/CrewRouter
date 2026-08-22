#!/usr/bin/env python3
"""Final batch: wrap remaining punctuation-fragment templates in admin.js."""
from pathlib import Path
import json, re, subprocess

ROOT = Path('/data/CrewRouter')
ZH = json.loads((ROOT/'lang/zh.json').read_text(encoding='utf-8'))
EN = json.loads((ROOT/'lang/en.json').read_text(encoding='utf-8'))

def add(k):
    k = k.strip()
    if k and re.search(r'[\u4e00-\u9fff]', k):
        ZH.setdefault(k, k); EN.setdefault(k, EN.get(k, k))

fixes = [
    # (old, new) — template-literal safe forms only
    ("`，已失效 ${staleCount}`", "`${t('，已失效')} ${staleCount}`"),
    ("`，重置于 ${period.resetsAt}`", "`${t('，重置于')} ${period.resetsAt}`"),
    ("`<div>可手动重置：", "`<div>${t('可手动重置：')}"),
    ("} 次</div>` : ''}", "} ${t('次')}</div>` : ''}"),
    ("`${current.startsAt} 至 ${current.resetsAt}`", "`${current.startsAt} ${t('至')} ${current.resetsAt}`"),
    # L5589: broken ${}<strong prefix in template
    ("`${}<strong style=\"color:var(--destructive);\">永久删除</strong>本供应商下 <strong>",
     "`${t('将删除')} <strong style=\"color:var(--destructive);\">${t('永久删除')}</strong>${t('本供应商下')} <strong>"),
]
n = 0
for old, new in fixes:
    if old in src if False else False:
        pass
p = ROOT / 'public/js/admin.js'
src = p.read_text(encoding='utf-8')
backup = src
for old, new in fixes:
    if old in src:
        src = src.replace(old, new)
        n += 1
        for m in re.finditer(r"t\('([^']*[\u4e00-\u9fff][^']*)'\)", new):
            add(m.group(1))
# L5665 tail fragment inside concat line
old5665 = "'</strong>本地已下架的模型记录（含 Team / API Key 绑定等关联数据）。'"
new5665 = "'</strong>' + t('本地已下架的模型记录（含 Team / API Key 绑定等关联数据）。')"
if old5665 in src:
    src = src.replace(old5665, new5665)
    n += 1
    add('本地已下架的模型记录（含 Team / API Key 绑定等关联数据）。')
# L5888 tail
old5888 = "'</strong>。确定继续吗？',"
new5888 = "'</strong>' + t('。确定继续吗？') + ',',"
if old5888 in src:
    src = src.replace(old5888, new5888)
    n += 1
    add('。确定继续吗？')

p.write_text(src, encoding='utf-8')
c = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
if c.returncode != 0:
    p.write_text(backup, encoding='utf-8')
    print('SYNTAX ERROR reverted:', c.stderr[:250])
    raise SystemExit(1)
(ROOT/'lang/zh.json').write_text(json.dumps(ZH, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
(ROOT/'lang/en.json').write_text(json.dumps({k: EN.get(k,k) for k in ZH}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(f'{n} applied, zh={len(ZH)}')
