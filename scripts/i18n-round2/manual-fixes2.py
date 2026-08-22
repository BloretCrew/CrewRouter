#!/usr/bin/env python3
"""Repair pass 7: last two broken admin.js lines + remaining audit leftovers."""
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
    ZH.setdefault(k, k)
    EN.setdefault(k, EN.get(k, k))


FIXES = {
    'admin.js': [
        # L3176: markup swallowed into plain concat inside ${...}
        (
            "? `${'<span class=\"provider-api-key-main-badge\" title=t(\\'主 Key：获取模型列表 / 连通性 / 额度\\')>' + t('主 Key')}</span>`",
            "? `<span class=\"provider-api-key-main-badge\" title=\"${t('主 Key：获取模型列表 / 连通性 / 额度')}\">${t('主 Key')}</span>`",
        ),
        # L4411-style broken line (手动添加的代理) if present
        (
            "${'<span title=t(\\'手动添加的代理\\')>' + }${healthyCount}",
            "${'<span title=\"' + t('手动添加的代理') + '\">' + }${healthyCount}",
        ),
    ],
    'app.js': [
        # 使用系统全局代理池 title attr in template
        (
            "<span style=\"font-size:12px;color:#3b82f6;\" title=\"使用系统全局代理池\">",
            "<span style=\"font-size:12px;color:#3b82f6;\" title=\"${t('使用系统全局代理池')}\">",
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
            if old in src:
                src = src.replace(old, new)
                n += 1
        p.write_text(src, encoding='utf-8')
        check = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
        if check.returncode != 0:
            p.write_text(backup, encoding='utf-8')
            print(f"{name}: SYNTAX ERROR reverted: {check.stderr[:300]}")
            sys.exit(1)
        print(f"{name}: {n}/{len(fixes)} applied")
        for _, new in fixes:
            for m in re.finditer(r"""\bt\('((?:[^'\\]|\\.)*)'\)""", new):
                raw = m.group(1).replace("\\'", "'")
                if re.search(r'[\u4e00-\u9fff]', raw):
                    add_key(raw)
    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    EN_PATH.write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                       encoding='utf-8')
    print(f"zh={len(ZH)}")


if __name__ == '__main__':
    main()
