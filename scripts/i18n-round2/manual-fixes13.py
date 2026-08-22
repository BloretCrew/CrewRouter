#!/usr/bin/env python3
"""Fix the Dialog.confirm lines that start with `+ '...'` (missing first operand)."""
from pathlib import Path

p = Path('/data/CrewRouter/public/js/admin.js')
src = p.read_text(encoding='utf-8')

fixes = [
    (" + '确定要删除此供应商吗？<br><br><strong style=\"color:var(--destructive);\">'",
     " t('确定要删除此供应商吗？') + '<br><br><strong style=\"color:var(--destructive);\">'"),
]
n = 0
for old, new in fixes:
    if old in src:
        src = src.replace(old, new)
        n += 1
p.write_text(src, encoding='utf-8')
print(f'{n} fixed')
