#!/usr/bin/env python3
"""Absolute final sweep: last 24 leftovers (mostly broken ${} empties + tails)."""
from pathlib import Path
import json, re, subprocess

ROOT = Path('/data/CrewRouter')
ZH = json.loads((ROOT/'lang/zh.json').read_text(encoding='utf-8'))
EN = json.loads((ROOT/'lang/en.json').read_text(encoding='utf-8'))

def add(k):
    k = k.strip()
    if k and re.search(r'[\u4e00-\u9fff]', k):
        ZH.setdefault(k, k); EN.setdefault(k, EN.get(k, k))

def apply(fname, fixes):
    p = ROOT / 'public/js' / fname
    src = p.read_text(encoding='utf-8')
    backup = src
    n = 0
    for old, new in fixes:
        if old not in src:
            continue
        idx = src.find(old)
        ls = src.rfind('\n', 0, idx)
        le = src.find('\n', idx)
        line = src[ls:le]
        has_tpl = '`' in line
        uses_expr = '${' in new
        if uses_expr and not has_tpl:
            new2 = re.sub(r"\$\{t\('([^']*)'\)\}", r"' + t('\1') + '", new)
            new2 = new2.replace("'' + ", "").replace(" + ''", "")
            src = src.replace(old, new2)
        else:
            src = src.replace(old, new)
        n += 1
        for m in re.finditer(r"t\('([^']*[\u4e00-\u9fff][^']*)'\)", new):
            add(m.group(1))
    if n:
        p.write_text(src, encoding='utf-8')
        c = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
        if c.returncode != 0:
            p.write_text(backup, encoding='utf-8')
            print(f'{fname}: SYNTAX ERROR reverted: {c.stderr[:200]}')
            return 0
    print(f'{fname}: {n} applied')
    return n

total = 0
total += apply('admin.js', [
    # L5589 still broken: ${}<strong prefix
    ("`${}<strong style=\"color:var(--destructive);\">永久删除</strong>本供应商下 <strong>",
     "`<strong style=\"color:var(--destructive);\">${t('永久删除')}</strong>${t('本供应商下')} <strong>"),
    # L6073 历史周期 (broken ${} inside div)
    ("<div style=\"font-size:13px;font-weight:600;margin-bottom:8px;\">${}</div>",
     "<div style=\"font-size:13px;font-weight:600;margin-bottom:8px;\">${t('历史周期')}</div>"),
    # L6484 table header 成员
    ("<th>${}</th><th>Team</th>", "<th>${t('成员')}</th><th>${t('Team')}</th>"),
    # L7393 合计
    ("<td>合计</td>", "<td>${t('合计')}</td>"),
    # L7811 配额内免费
    ("<span title=\"配额内免费\">", "<span title=\"${t('配额内免费')}\">"),
    # L10849 confirm with escaped quotes — check actual form first; try direct wrap
    ("confirm('模型测试将发送一条真实请求（\\\"Hi\\\"，max_tokens=5）到该模型，",
     "confirm(t('模型测试将发送一条真实请求（\"Hi\"，max_tokens=5）到该模型，"),
])
total += apply('app.js', [
    # L10089 展开余下的 N 个key (title attr in template)
    ("title=\"展开余下的 ${hiddenCount} 个key\"", "title=\"${t('展开余下的')} ${hiddenCount} ${t('个key')}\""),
])
print(f'TOTAL: {total}')
(ROOT/'lang/zh.json').write_text(json.dumps(ZH, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
(ROOT/'lang/en.json').write_text(json.dumps({k: EN.get(k,k) for k in ZH}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(f'zh={len(ZH)}')
