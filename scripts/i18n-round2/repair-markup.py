#!/usr/bin/env python3
"""Repair pass 5: remaining markup-in-key cases that pass-4's regex missed:
- markup with nested quotes/escapes (style=\"color:#f59e0b;\" contains ; and ")
- keys STARTING with closing tags </b>, </strong>
- mixed markup+CJK+markup

Generic algorithm per t('...') call:
  split key into segments of (markup | text) via regex findall
  rebuild as: 'markup' + t('text') + 'markup' + ...
"""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path('/data/CrewRouter')
JS = ROOT / 'public' / 'js'
CJK = re.compile(r'[\u4e00-\u9fff]')
SEG = re.compile(r'(<[^<>]*>|\\"|")')


def jsq(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


def split_segments(raw):
    """Split raw key into [('m'|'t', str)] where m=markup, t=text."""
    parts = []
    last = 0
    for m in SEG.finditer(raw):
        if m.start() > last:
            parts.append(('t', raw[last:m.start()]))
        parts.append(('m', raw[m.start():m.end()]))
        last = m.end()
    if last < len(raw):
        parts.append(('t', raw[last:]))
    # merge adjacent same-kind
    merged = []
    for kind, txt in parts:
        if merged and merged[-1][0] == kind:
            merged[-1] = (kind, merged[-1][1] + txt)
        else:
            merged.append((kind, txt))
    return merged


def fix_line(line):
    changed = False

    def repl(m):
        nonlocal changed
        key = m.group(1)
        raw = key.replace("\\'", "'")
        if not re.search(r'<[^<>]*>|</', raw):
            return m.group(0)
        segs = split_segments(raw)
        bits = []
        for kind, txt in segs:
            if kind == 'm':
                if txt:
                    bits.append("'" + jsq(txt) + "'")
            else:
                if CJK.search(txt) or (txt.strip() and any(c > '\u2e80' for c in txt)):
                    bits.append("t('" + jsq(txt.strip()) + "')")
                elif txt:
                    bits.append("'" + jsq(txt) + "'")
        changed = True
        return ' + '.join(bits) if bits else "''"

    new = re.sub(r"""\bt\('((?:[^'\\]|\\.)*)'\)""", repl, line)
    return new, changed


total = 0
for name in ['app.js', 'admin.js', 'playground.js', 'dialog.js', 'dom.js', 'theme.js']:
    p = JS / name
    lines = p.read_text(encoding='utf-8').split('\n')
    n = 0
    for i, line in enumerate(lines):
        if not re.search(r"\bt\('[^']*(?:<|</)", line):
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
