#!/usr/bin/env python3
"""Repair pass 10: fix `? + '...'` and `, + '...'` / `return + '...'` artifacts
left by earlier passes (stray `+` after ternary/comma/return)."""
import re
import subprocess
from pathlib import Path

ROOT = Path('/data/CrewRouter')
JS = ROOT / 'public' / 'js'

PATTERNS = [
    (re.compile(r"\? \+ '"), "? '"),
    (re.compile(r": \+ '"), ": '"),
    (re.compile(r", \+ '"), ", '"),
    (re.compile(r"return \+ '"), "return '"),
    (re.compile(r"= \+ '<"), "= '<"),
    (re.compile(r"\(\+ '"), "('"),
]

total = 0
for name in ['app.js', 'admin.js', 'playground.js', 'dialog.js', 'dom.js', 'theme.js']:
    p = JS / name
    src = p.read_text(encoding='utf-8')
    backup = src
    n = 0
    for pat, repl in PATTERNS:
        src, k = pat.subn(repl, src)
        n += k
    if n:
        p.write_text(src, encoding='utf-8')
        check = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
        if check.returncode != 0:
            p.write_text(backup, encoding='utf-8')
            print(f"{name}: SYNTAX ERROR after fix, reverted: {check.stderr[:200]}")
            continue
    print(f"{name}: {n} fixes")
    total += n
print(f"TOTAL: {total}")
