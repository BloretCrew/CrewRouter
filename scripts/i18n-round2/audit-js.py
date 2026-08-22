#!/usr/bin/env python3
"""Audit v2: find unwrapped Chinese string literals in JS (t()-aware, quote-pair aware)."""
import re
import sys
from pathlib import Path

JS_DIR = Path('/data/CrewRouter/public/js')
files = sys.argv[1:] or ['app.js', 'admin.js', 'dialog.js', 'dom.js', 'playground.js', 'theme.js']


def strip_line_comments(src: str):
    """Yield (lineno, code_part) with // comments removed naively but safely for our purpose."""
    for i, line in enumerate(src.split('\n'), 1):
        s = line.strip()
        if not re.search(r'[\u4e00-\u9fff]', line):
            continue
        if s.startswith(('//', '*', '/*')):
            continue
        yield i, line


def find_unwrapped(code: str):
    """Find CJK-containing quoted literals whose nearest opener isn't t(."""
    out = []
    # tokenize quotes/backticks in order, track template nesting coarsely
    events = []
    for m in re.finditer(r'`|"|\'', code):
        events.append((m.start(), m.group(0)))
    # walk: maintain stack; backtick toggles template depth
    stack = []  # list of ('tpl'|'sq'|'dq', start)
    i = 0
    n = len(events)
    while i < n:
        pos, ch = events[i]
        if ch == '`':
            if stack and stack[-1][0] == 'tpl' and stack[-1][2] == 'open':
                stack[-1] = ('tpl', stack[-1][1], 'close')
            else:
                stack.append(('tpl', pos, 'open'))
        elif ch in ('"', "'"):
            top = stack[-1] if stack else None
            in_tpl = top and top[0] == 'tpl'
            if in_tpl:
                # inside template body or inside ${ }? crude: count ${ vs } since tpl open
                seg = code[top[1]:pos]
                expr_depth = seg.count('${') - seg.count('}')
                in_expr = expr_depth > 0
            else:
                in_expr = False
            kind = 'sq' if ch == "'" else 'dq'
            if stack and stack[-1][0] == kind and stack[-1][2] == 'open' and not in_expr:
                stack.pop()
            else:
                # opening a string literal — find its close
                q = ch
                j = pos + 1
                body_chars = []
                while j < len(code):
                    c = code[j]
                    if c == '\\':
                        j += 2
                        continue
                    if c == q:
                        break
                    body_chars.append(c)
                    j += 1
                body = ''.join(body_chars)
                left = code[max(0, pos - 40):pos]
                # wrapped if t( / I18N.t( immediately precedes the opening quote,
                # possibly via a template expression: "${t(" before it
                wrapped = (re.search(r"(?:\bt|I18N\.t)\s*\(\s*$", left) is not None
                           or re.search(r"\$\{\s*t\s*\($", left) is not None)
                # a double-quoted attr whose body contains ${t('…')} is already wrapped
                if not wrapped and q == '"' and re.search(r"\$\{\s*t\s*\(", body):
                    wrapped = True
                if not wrapped:
                    # t('...') already closed earlier on this line and we're inside its args?
                    before_all = code[:pos]
                    m2 = re.findall(r"\bt\(([^)]*)$", before_all)
                    if m2 and re.search(r"\bt\([^\)\n]*$", before_all):
                        wrapped = True  # inside an unterminated t( call
                if re.search(r'[\u4e00-\u9fff]', body) and not wrapped and body not in ('zh', 'en'):
                    # double-check: does this exact key already appear as t('key') on this line?
                    if re.search(r"\bt\(" + re.escape(q + body + q) + r"\)", code):
                        wrapped = True
                if re.search(r'[\u4e00-\u9fff]', body) and not wrapped and body not in ('zh', 'en'):
                    out.append((pos, body))
                # skip past this literal in event stream
                while i < n and events[i][0] <= j:
                    i += 1
                continue
        i += 1
    return out


total = 0
for name in files:
    p = JS_DIR / name
    src = p.read_text(encoding='utf-8')
    leftovers = []
    for lineno, line in strip_line_comments(src):
        for pos, body in find_unwrapped(line):
            leftovers.append((lineno, body[:70]))
    if leftovers:
        total += len(leftovers)
        print(f"=== {name}: {len(leftovers)} ===")
        for ln, b in leftovers[:10]:
            print(f"  L{ln}: {b}")
print(f"TOTAL: {total}")
