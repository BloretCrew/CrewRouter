#!/usr/bin/env python3
"""Repair pass 2: fix all bad t() wraps found by purge-bad-keys.py.

Strategy: for each file, restore from .bak2 is NOT possible (too many good
wraps since). Instead, fix each broken line by re-assembling it correctly:
- t('<markup>中文') + expr + t('中文</markup>')  →  <markup>${t('中文')}${expr}${t('中文')}</markup>

Parse each broken line: find the template literal span, walk its parts, and
rebuild with markup moved out of t() calls.
"""
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')
JS = ROOT / 'public' / 'js'

# pattern: t('...') where the argument contains markup
T_BAD = re.compile(r"""\$\{t\('((?:[^'\\]|\\.)*)'\)\}""")

MARKUP = re.compile(r'<[a-zA-Z/][^>]*>|</|">|\'>|\)\\?">')


def split_markup(key):
    """Split a bad key into (leading_markup, cjk_text, trailing_markup)."""
    # leading markup: from start to last '>' before any CJK
    m = re.match(r"^((?:[^<]|<[^>]*>)*?>)(.*)$", key, re.DOTALL)
    if m and re.search(r'[\u4e00-\u9fff]', m.group(2)):
        return m.group(1), m.group(2), ''
    # trailing markup: from first '<' after CJK
    m = re.match(r"^(.*?[\u4e00-\u9fff][^<]*)(<.*)$", key, re.DOTALL)
    if m:
        return '', m.group(1), m.group(2)
    # pure markup (no CJK)
    if not re.search(r'[\u4e00-\u9fff]', key):
        return key, '', ''
    return '', key, ''


def fix_line(line):
    changed = False
    def repl(m):
        nonlocal changed
        key = m.group(1)
        # unescape JS escapes for analysis
        raw = key.replace("\\'", "'").replace('\\n', '\n').replace('\\\\', '\\')
        if not MARKUP.search(raw):
            return m.group(0)  # fine
        lead, text, trail = split_markup(raw)
        parts = []
        if lead:
            parts.append(lead.replace("'", "\\'"))
        if text:
            parts.append("${t('" + text.replace("'", "\\'") + "')}")
        if trail:
            parts.append(trail.replace("'", "\\'"))
        changed = True
        return ''.join(parts)
    new = T_BAD.sub(repl, line)
    return new, changed


total = 0
for name in ['app.js', 'admin.js', 'playground.js', 'dialog.js', 'dom.js', 'theme.js']:
    p = JS / name
    src = p.read_text(encoding='utf-8')
    lines = src.split('\n')
    n = 0
    for i, line in enumerate(lines):
        if 't(' not in line:
            continue
        new, changed = fix_line(line)
        if changed:
            lines[i] = new
            n += 1
    if n:
        p.write_text('\n'.join(lines), encoding='utf-8')
    print(f"{name}: fixed {n} lines")
    total += n
print(f"TOTAL: {total}")
