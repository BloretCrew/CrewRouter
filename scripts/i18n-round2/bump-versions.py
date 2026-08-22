#!/usr/bin/env python3
"""Bump JS/CSS cache-bust versions in pages whose JS changed."""
from pathlib import Path

ROOT = Path('/data/CrewRouter/public/pages')

BUMPS = {
    'console.html': [('app.js?v=25', 'app.js?v=26')],
    'admin.html': [('admin.js?v=12', 'admin.js?v=13')],
    'playground.html': [('playground.js', 'playground.js')],  # check below
}

for name, pairs in BUMPS.items():
    p = ROOT / name
    src = p.read_text(encoding='utf-8')
    for old, new in pairs:
        if new and old != new and old in src:
            src = src.replace(old, new)
            print(f'{name}: {old} -> {new}')
    p.write_text(src, encoding='utf-8')

# report current script tags
for name in ['console.html', 'admin.html', 'playground.html']:
    src = (ROOT / name).read_text(encoding='utf-8')
    for m in __import__('re').finditer(r'<script src="/js/[^"]*"', src):
        print(f'{name}: {m.group(0)}')
