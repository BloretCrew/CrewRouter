#!/usr/bin/env python3
"""Audit detail: dump full lines with unwrapped Chinese literals for manual review."""
import re
import sys
from pathlib import Path

JS_DIR = Path('/data/CrewRouter/public/js')
name = sys.argv[1]
p = JS_DIR / name
out = []
for i, line in enumerate(p.read_text(encoding='utf-8').split('\n'), 1):
    s = line.strip()
    if not re.search(r'[\u4e00-\u9fff]', line):
        continue
    if s.startswith(('//', '*', '/*')):
        continue
    code = re.split(r'//', s)[0] if '//' in s else s
    if not re.search(r'[\u4e00-\u9fff]', code):
        continue
    for m in re.finditer(r"""(['"])((?:\\.|(?!\1).)*?[\u4e00-\u9fff](?:\\.|(?!\1).)*?)\1""", code):
        left = code[max(0, m.start() - 40):m.start()]
        if re.search(r"(?:\bt|I18N\.t)\s*\(\s*$", left):
            continue
        # already inside a t() call as its argument (preceded by t( anywhere near)
        before_all = code[:m.start()]
        if re.search(r"\bt\([^)]*$", before_all):
            continue
        if m.group(2) in ('zh', 'en'):
            continue
        out.append((i, s[:200]))
        break
for i, txt in out:
    print(f"L{i}: {txt}")
