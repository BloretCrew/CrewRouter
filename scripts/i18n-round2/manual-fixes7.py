#!/usr/bin/env python3
"""Repair pass 13: remaining template-literal fragments (，/。 punctuation + expr)."""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path('/data/CrewRouter')
ZH_PATH = ROOT / 'lang' / 'zh.json'
EN_PATH = ROOT / 'lang' / 'en.json'
ZH = json.loads(ZH_PATH.read_text(encoding='utf-8'))
EN = json.loads(EN_PATH.read_text(encoding='utf-8'))


def add_key(k):
    k = k.strip()
    if k and re.search(r'[\u4e00-\u9fff]', k):
        ZH.setdefault(k, k)
        EN.setdefault(k, EN.get(k, k))


def main():
    p = ROOT / 'public' / 'js' / 'admin.js'
    src = p.read_text(encoding='utf-8')
    backup = src
    n = 0
    fixes = [
        # L5848: `，已失效 ${staleCount}`
        ("`，已失效 ${staleCount}`", "`${t('，已失效')} ${staleCount}`"),
        # L5994: `，重置于 ${period.resetsAt}`
        ("`，重置于 ${period.resetsAt}`", "`${t('，重置于')} ${period.resetsAt}`"),
        # L6034: 可手动重置：N 次
        ("`<div>可手动重置：${escapeHtml(String(resetCount))} 次</div>`",
         "`<div>${t('可手动重置：')}${escapeHtml(String(resetCount))} ${t('次')}</div>`"),
        # L5589-adjacent: 将依次从<strong>N</strong>（不会误删）...
        ("`${t('将')}<strong style=\"color:var(--destructive);\">永久删除</strong>本供应商下 <strong>",
         "`${t('将')}<strong style=\"color:var(--destructive);\">${t('永久删除')}</strong>${t('本供应商下')} <strong>"),
        ("${'</strong>' + t('个上游已不存在的本地模型记录（含 Team /",
         "'</strong>' + t('个上游已不存在的本地模型记录（含 Team /"),
        # L5888: 当前<strong>N</strong>个模型
        ("当前<strong>", "${t('当前')}<strong>"),
        # L5665/5666
        ("将依次从<strong>", "${t('将依次从')}<strong>"),
        ("</strong>（不会误删）。此操作可能耗时较长，且不可撤销。",
         "</strong>${t('（不会误删）。此操作可能耗时较长，且不可撤销。')}"),
    ]
    for old, new in fixes:
        if old in src:
            src = src.replace(old, new)
            n += 1
            for m in re.finditer(r"""(?:\$\{)?t\('([^']*[\u4e00-\u9fff][^']*)'\)""", new):
                add_key(m.group(1))
    p.write_text(src, encoding='utf-8')
    check = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
    if check.returncode != 0:
        p.write_text(backup, encoding='utf-8')
        print(f'SYNTAX ERROR reverted: {check.stderr[:250]}')
        sys.exit(1)
    print(f'{n} applied, zh={len(ZH)}')
    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    EN_PATH.write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                       encoding='utf-8')


if __name__ == '__main__':
    main()
