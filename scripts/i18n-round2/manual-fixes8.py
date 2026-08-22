#!/usr/bin/env python3
"""Fix the stray `+ '将依次从...'` line (missing leading string before +)."""
from pathlib import Path

p = Path('/data/CrewRouter/public/js/admin.js')
src = p.read_text(encoding='utf-8')
old = "       + '将依次从<strong>' + t('每个供应商')"
new = "       t('将依次从') + '<strong>' + t('每个供应商')"
assert old in src, 'pattern not found'
src = src.replace(old, new)
p.write_text(src, encoding='utf-8')
print('ok')
