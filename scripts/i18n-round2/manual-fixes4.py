#!/usr/bin/env python3
"""Repair pass 12: the true final stragglers (plain-concat lines, not templates)."""
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


FIXES = {
    'admin.js': [
        # L4393/L4406: plain concat (single-quoted), so use '...' + t() + ... form
        (
            "return '<span style=\"font-size:12px;color:#8b5cf6;\" title=\"使用系统设置中的代理\">'",
            "return '<span style=\"font-size:12px;color:#8b5cf6;\" title=\"' + t('使用系统设置中的代理') + '\">'",
        ),
        (
            "return '<span style=\"font-size:12px;color:#3b82f6;\" title=\"使用系统全局代理池\">'",
            "return '<span style=\"font-size:12px;color:#3b82f6;\" title=\"' + t('使用系统全局代理池') + '\">'",
        ),
        # L4411: broken title=t(\'...\') inside plain string inside template expr
        (
            "${'<span title=t(\\'手动添加的代理\\')>' + t('🔄')}",
            "${'<span title=\"' + t('手动添加的代理') + '\">' + t('🔄')}",
        ),
        # L3069 static title in template
        (
            '<span style="color:var(--muted-foreground);font-size:12px;" title="在「更',
            '<span style="color:var(--muted-foreground);font-size:12px;" title="${t(\'在「更',
        ),
        # L5589 broken ${} prefix
        (
            "${}<strong style=\"color:var(--destructive);\">永久删除</strong>本供应商下",
            "<strong style=\"color:var(--destructive);\">${t('永久删除')}</strong>${t('本供应商下')}",
        ),
        # L5507 尝试过的路径
        (
            "\\n\\n尝试过的路径:\\n",
            "${t('尝试过的路径:')}",
        ),
        # L4690 过期时间
        (
            "\\n过期时间: ",
            "${t('过期时间: ')}",
        ),
    ],
}


def main():
    for name, fixes in FIXES.items():
        p = ROOT / 'public' / 'js' / name
        src = p.read_text(encoding='utf-8')
        backup = src
        n = 0
        for old, new in fixes:
            if new is None:
                continue
            if old in src:
                # context check: if old line has backtick → template (use ${}); else concat
                idx = src.find(old)
                ls = src.rfind('\n', 0, idx)
                le = src.find('\n', idx)
                line = src[ls:le]
                if '${' in new and '`' not in line:
                    # convert ${t('x')} → ' + t('x') + '
                    new2 = new.replace("${t('", "' + t('").replace("')}", "') + '")
                    # fix dangling quote pairs
                    src = src.replace(old, new)
                    n += 1
                    add_key(old)
                    continue
                src = src.replace(old, new)
                add_key(re.sub(r'[<>/\\\\]', '', old))
                n += 1
        p.write_text(src, encoding='utf-8')
        check = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
        if check.returncode != 0:
            p.write_text(backup, encoding='utf-8')
            print(f"{name}: SYNTAX ERROR reverted: {check.stderr[:250]}")
            sys.exit(1)
        print(f"{name}: {n} applied")
    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    EN_PATH.write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                       encoding='utf-8')
    print(f"zh={len(ZH)}")


if __name__ == '__main__':
    main()
