#!/usr/bin/env python3
"""Fix stray `+ '当前<strong>'...` line (missing leading string)."""
from pathlib import Path

p = Path('/data/CrewRouter/public/js/admin.js')
src = p.read_text(encoding='utf-8')
old = " + '当前<strong>'"
new = " t('当前') + '<strong>'"
assert old in src, 'not found'
src = src.replace(old, new)
p.write_text(src, encoding='utf-8')
print('ok')
