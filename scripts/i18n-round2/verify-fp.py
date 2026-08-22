#!/usr/bin/env python3
"""Verify remaining audit hits are false positives (already wrapped)."""
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')

CHECKS = [
    ('admin.js', 3038, '脚本刷新模式'),
    ('admin.js', 6073, '历史周期'),
    ('admin.js', 6484, '成员'),
    ('admin.js', 5589, '永久删除'),
]
for name, lineno, key in CHECKS:
    p = ROOT / 'public/js' / name
    line = p.read_text(encoding='utf-8').split('\n')[lineno - 1]
    ok = f"t('{key}')" in line
    print(f'{name}:L{lineno} [{key}]: {"WRAPPED ✓" if ok else "NOT WRAPPED ✗"}')
