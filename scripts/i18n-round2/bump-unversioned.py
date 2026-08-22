#!/usr/bin/env python3
"""Add ?v=2 to unversioned dom/dialog/theme/playground.js script tags."""
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter/public/pages')
for f in sorted(ROOT.glob('*.html')):
    if f.name.endswith('.bak'):
        continue
    src = f.read_text(encoding='utf-8')
    orig = src

    def bump(m):
        tag = m.group(0)
        if '?v=' in tag:
            return tag
        return tag.replace('"></script>', '?v=2"></script>')

    src = re.sub(
        r'<script src="/js/(?:dom|dialog|theme|playground)\.js(\?v=\d+)?"?></script>',
        bump, src)
    # simpler second pass for exact forms
    for js in ('dom', 'dialog', 'theme', 'playground'):
        src = src.replace(f'<script src="/js/{js}.js"></script>',
                          f'<script src="/js/{js}.js?v=2"></script>')
    if src != orig:
        f.write_text(src, encoding='utf-8')
        print(f'{f.name}: bumped unversioned tags')
print('done')
