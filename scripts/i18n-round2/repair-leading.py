#!/usr/bin/env python3
"""Repair pass 4: leading-markup keys t('<div ...>中文') → <div ...>${t('中文')}.

The earlier leading-markup pass only handled keys inside ${t('...')} (template
expressions). These leftovers are plain t('...') calls (e.g. inside string
concat). Handle both: move leading markup before the t( call, keeping the
surrounding quote structure valid.

Cases:
A) `... + t('<div class="x">中文') + ...`  → `... + '<div class="x">' + t('中文') + ...`
B) `${t('<div class="x">中文')}`           → `<div class="x">${t('中文')}`
"""
import json
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')
JS = ROOT / 'public' / 'js'
ZH_PATH = ROOT / 'lang' / 'zh.json'
EN_PATH = ROOT / 'lang' / 'en.json'

MARKUP_START = re.compile(r"^((?:[^<]|<[^>]*?)*?>)([\u4e00-\u9fff].*)$", re.DOTALL)
MARKUP_END = re.compile(r"^(.*?[\u4e00-\u9fff][^<]*)(<.*)$", re.DOTALL)
CJK = re.compile(r'[\u4e00-\u9fff]')


def jsq(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


def fix_line(line):
    changed = False

    def repl(m):
        nonlocal changed
        key = m.group(1)
        raw = key.replace("\\'", "'")
        # leading markup
        m1 = MARKUP_START.match(raw)
        if m1 and CJK.search(m1.group(2)):
            lead, rest = m1.group(1), m1.group(2)
            # rest may still have trailing markup
            m2 = MARKUP_END.match(rest)
            if m2:
                rest, trail = m2.group(1), m2.group(2)
            else:
                trail = ''
            changed = True
            out = "'" + jsq(lead) + "' + t('" + jsq(rest) + "')"
            if trail:
                out += " + '" + jsq(trail) + "'"
            return out
        # pure markup, no CJK → unwrap entirely
        if not CJK.search(raw):
            changed = True
            return "'" + jsq(raw) + "'"
        return m.group(0)

    new = re.sub(r"""\bt\('((?:[^'\\]|\\.)*)'\)""", repl, line)
    return new, changed


total = 0
for name in ['app.js', 'admin.js', 'playground.js', 'dialog.js', 'dom.js', 'theme.js']:
    p = JS / name
    lines = p.read_text(encoding='utf-8').split('\n')
    n = 0
    for i, line in enumerate(lines):
        if "t('<" not in line and "t('</" not in line and "t('<span" not in line and "t('<div" not in line:
            if not re.search(r"\bt\('[^']*(?:<div|<span|</|title=|style=)", line):
                continue
        new, changed = fix_line(line)
        if changed:
            lines[i] = new
            n += 1
    if n:
        p.write_text('\n'.join(lines), encoding='utf-8')
    print(f"{name}: fixed {n}")
    total += n
print(f"TOTAL: {total}")
