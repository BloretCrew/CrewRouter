#!/usr/bin/env python3
"""Repair pass: revert bad fix-tpl output where an HTML attribute value was
split across t() calls, e.g.

  `${t('<span style="..." title="脚本刷新模式')}...${t('">⚡ 脚本')}`

Restore from .bak2 and re-apply a safer strategy for those lines:
wrap ONLY the inner text of title/placeholder attrs (attr="...中文...")
inside template literals via ${expr ? `title="${t('中文')}"` : ''} — but that's
complex; instead simply wrap the attr static part with data-i18n-title is not
possible in JS-generated HTML... so use escapeHtml-free approach:

For lines matching pattern: <tag ... title="STATIC中文${EXPR}..." ...>
→ title="${t('STATIC中文')}${EXPR}..." won't work either when EXPR mid-string.

Simplest correct approach for these few lines: manual fixes list below.
"""
import re
import sys
from pathlib import Path

P = Path('/data/CrewRouter/public/js/admin.js')
src = P.read_text(encoding='utf-8')

FIXES = [
    # L3038-ish
    (
        "? `${t('<span style=\"color:#f59e0b;font-size:12px;\" title=\"脚本刷新模式')}${hasError ? '\\n上次错误: ' + escapeHtml(lastError) : ''}${t('\">⚡ 脚本')}${errorIcon}</span>`",
        "? `<span style=\"color:#f59e0b;font-size:12px;\" title=\"${t('脚本刷新模式')}${hasError ? '\\n上次错误: ' + escapeHtml(lastError) : ''}\">⚡ ${t('脚本')}${errorIcon}</span>`",
    ),
]

count = 0
for old, new in FIXES:
    if old in src:
        src = src.replace(old, new)
        count += 1

P.write_text(src, encoding='utf-8')
print(f"applied {count}/{len(FIXES)}")
