#!/usr/bin/env python3
"""Repair pass 3: trailing-markup keys like t('失败</span>') → ${t('失败')}</span>.
The previous pass only moved LEADING markup out; trailing markup stayed inside.
"""
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')
JS = ROOT / 'public' / 'js'

T_BAD = re.compile(r"""\$\{t\('((?:[^'\\]|\\.)*)'\)\}""")
CJK = re.compile(r'[\u4e00-\u9fff]')


def fix_line(line):
    changed = False

    def repl(m):
        nonlocal changed
        key = m.group(1)
        raw = key.replace("\\'", "'")
        # find first '<' that starts markup AFTER cjk text
        m2 = re.search(r"^(.*?[\u4e00-\u9fff][^<]*)(<.*)$", raw, re.DOTALL)
        if not m2:
            return m.group(0)
        text, trail = m2.group(1), m2.group(2)
        if not CJK.search(text):
            return m.group(0)
        changed = True
        return "${t('" + text.replace("'", "\\'") + "')}" + trail.replace("'", "\\'")

    new = T_BAD.sub(repl, line)
    return new, changed


total = 0
for name in ['app.js', 'admin.js', 'playground.js', 'dialog.js', 'dom.js', 'theme.js']:
    p = JS / name
    lines = p.read_text(encoding='utf-8').split('\n')
    n = 0
    for i, line in enumerate(lines):
        if '${t(' not in line:
            continue
        new, changed = fix_line(line)
        if changed:
            lines[i] = new
            n += 1
    if n:
        p.write_text('\n'.join(lines), encoding='utf-8')
    print(f"{name}: fixed {n}")
    total += n
print(f"TOTAL: {total}")
