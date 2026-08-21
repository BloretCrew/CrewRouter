#!/usr/bin/env python3
"""Debug why html-literal pass didn't fire: inspect one case."""
import re
from pathlib import Path

src = Path('/data/CrewRouter/public/js/app.js').read_text(encoding='utf-8')
lines = src.split('\n')
line = lines[451]  # L452
print('LINE:', line.strip()[:160])
STR_RE = re.compile(r"""(['"])((?:\\.|(?!\1).)*?)\1""")
for m in STR_RE.finditer(line):
    raw = m.group(2)
    if re.search(r'[\u4e00-\u9fff]', raw):
        print('MATCH q=', m.group(1), 'body head:', raw[:80])
        print('  has quote chars:', "'" in raw or '"' in raw, '| backslash:', '\\' in raw)
