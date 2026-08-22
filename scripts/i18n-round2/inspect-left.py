#!/usr/bin/env python3
"""Repair pass 8: final batch of manual fixes for remaining audit lines."""
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
        # L3038: leftover broken ${} — check actual current content first (see grep below)
        # handled dynamically in main() via regex
    ],
}


def fix_admin_3038(src):
    """Fix the broken title=\"${} pattern whatever its exact current form is."""
    pat = re.compile(r'title="\$\{\}\$\{hasError \?')
    if pat.search(src):
        return pat.sub('title="${hasErrorText = hasError ? ', src), True
    return src, False


def main():
    total = 0
    p = ROOT / 'public' / 'js' / 'admin.js'
    src = p.read_text(encoding='utf-8')

    fixes = [
        # 3038 broken empty expr
        ('title="${}${hasError ? \'\\n上次错误: \' + escapeHtml(lastError) : \'\'}</span>',
         None),  # inspect first
    ]

    # Show the actual line to decide
    for i, line in enumerate(src.split('\n'), 1):
        if '${}${hasError' in line:
            print(f'L{i}: {line.strip()[:220]}')

    for name in ['app.js', 'admin.js', 'playground.js']:
        pp = ROOT / 'public' / 'js' / name
        check = subprocess.run(['node', '--check', str(pp)], capture_output=True, text=True)
        print(f'{name}: syntax {"OK" if check.returncode == 0 else "BROKEN"}')


if __name__ == '__main__':
    main()
