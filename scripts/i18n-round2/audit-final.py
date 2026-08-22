#!/usr/bin/env python3
"""Final audit v3: report lines whose CJK text is NOT inside any t() call.

Approach: remove every t('…') / t("…") / I18N.t(…) occurrence from the line,
then check if CJK remains in *code* (outside comments). Much simpler & accurate.
"""
import re
import sys
from pathlib import Path

JS_DIR = Path('/data/CrewRouter/public/js')
files = sys.argv[1:] or ['app.js', 'admin.js', 'dialog.js', 'dom.js', 'playground.js', 'theme.js']

T_CALL = re.compile(r"""\b(?:I18N\.t|t)\s*\(\s*(['"])((?:\\.|(?!\1).)*?)\1[^)]*\)""")

total = 0
for name in files:
    p = JS_DIR / name
    leftovers = []
    for i, line in enumerate(p.read_text(encoding='utf-8').split('\n'), 1):
        if not re.search(r'[\u4e00-\u9fff]', line):
            continue
        s = line.strip()
        if s.startswith(('//', '*', '/*')):
            continue
        code = re.split(r'//', line)[0] if '//' in line else line
        # remove all t('…') calls
        stripped = T_CALL.sub('', code)
        if not re.search(r'[\u4e00-\u9fff]', stripped):
            continue
        # find the remaining CJK-bearing literals for display
        for m in re.finditer(r"""(['`"])((?:\\.|(?!\1).)*?[\u4e00-\u9fff](?:\\.|(?!\1).)*?)\1""", stripped):
            body = m.group(2)
            if body.strip() in ('zh', 'en'):
                continue
            leftovers.append((i, body[:70]))
            break
    if leftovers:
        total += len(leftovers)
        print(f"=== {name}: {len(leftovers)} ===")
        for ln, b in leftovers[:12]:
            print(f"  L{ln}: {b}")
print(f"TOTAL: {total}")
