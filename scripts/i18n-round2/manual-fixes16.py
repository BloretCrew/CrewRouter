#!/usr/bin/env python3
"""Fix double-wrapped alert line from manual-fixes12."""
from pathlib import Path

p = Path('/data/CrewRouter/public/js/admin.js')
src = p.read_text(encoding='utf-8')
old = "alert(t('${t('请输入或上传 auth.json')}'))"
new = "alert(t('请输入或上传 auth.json'))"
if old in src:
    src = src.replace(old, new)
    p.write_text(src, encoding='utf-8')
    print('fixed')
else:
    print('pattern not found — checking variants')
    import re
    for i, l in enumerate(src.split('\n'), 1):
        if '请输入或上传' in l:
            print(f'L{i}: {l.strip()[:120]}')
