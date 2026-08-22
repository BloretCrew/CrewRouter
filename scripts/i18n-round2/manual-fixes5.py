#!/usr/bin/env python3
"""Repair pass 12b: plain-concat lines (single-quoted), correct form."""
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
        # L3069: concat line → split title into '...' + t() + '...'
        (
            "\" title=\"在「更多」中查询或使用顶部「刷新本页额度」\">' + t('已启用')",
            "\" title=\"' + t('在「更多」中查询或使用顶部「刷新本页额度」') + '\">' + t('已启用')",
        ),
        # L4393/L4406: return '<span ... title="中文">'  (plain concat)
        (
            "return '<span style=\"font-size:12px;color:#8b5cf6;\" title=\"使用系统设置中的代理\">'",
            "return '<span style=\"font-size:12px;color:#8b5cf6;\" title=\"' + t('使用系统设置中的代理') + '\">'",
        ),
        (
            "return '<span style=\"font-size:12px;color:#3b82f6;\" title=\"使用系统全局代理池\">'",
            "return '<span style=\"font-size:12px;color:#3b82f6;\" title=\"' + t('使用系统全局代理池') + '\">'",
        ),
        # L4411 broken title=t(\'...\')
        (
            "${'<span title=t(\\'手动添加的代理\\')>' + t('🔄')}",
            "${'<span title=\"' + t('手动添加的代理') + '\">' + t('🔄')}",
        ),
        # L5589 broken ${} prefix
        (
            "${}<strong style=\"color:var(--destructive);\">永久删除</strong>本供应商下",
            "<strong style=\"color:var(--destructive);\">${t('永久删除')}</strong>${t('本供应商下')}",
        ),
        # L5507 尝试过的路径 (inside template)
        (
            "\\n\\n尝试过的路径:\\n",
            "\\n\\n${t('尝试过的路径:')}\\n",
        ),
        # L4690 过期时间 (inside template)
        (
            "\\n过期时间: ",
            "\\n${t('过期时间: ')}",
        ),
    ]

    for old, new in fixes:
        if old in src:
            idx = src.find(old)
            ls = src.rfind('\n', 0, idx)
            le = src.find('\n', idx)
            line = src[ls:le]
            has_tpl = '`' in line
            uses_expr = '${' in new
            if uses_expr and not has_tpl:
                print(f'  SKIP (concat line, expr new): {old[:50]!r}')
                continue
            if (not uses_expr) and has_tpl and "t('" in new and '+ t(' not in new and '${t(' not in new:
                pass  # plain replacement fine in template too
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
    print(f'{n} applied')
    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    EN_PATH.write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                       encoding='utf-8')
    print(f'zh={len(ZH)}')


if __name__ == '__main__':
    main()
