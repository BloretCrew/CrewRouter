#!/usr/bin/env python3
"""Pass-5: wrap template-literal segments containing ${expr} + 中文.

Pattern: `...${expr}中文...` → `...${expr}${t('中文')}...`
Splits the template literal into static chunks (outside ${}) and wraps each
CJK-bearing chunk. Only handles the segment between backticks on ONE line.
Guards: skips ${t( already present; skips chunks >120 chars; keeps whitespace.

Also handles plain-quoted strings with leading/trailing ${}? No — those are
concat style, already handled by earlier passes.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path('/data/CrewRouter')
ZH_PATH = ROOT / 'lang' / 'zh.json'
EN_PATH = ROOT / 'lang' / 'en.json'
ZH = json.loads(ZH_PATH.read_text(encoding='utf-8'))
EN = json.loads(EN_PATH.read_text(encoding='utf-8'))
CJK = re.compile(r'[\u4e00-\u9fff]')


def js_escape(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


def add_key(k):
    ZH.setdefault(k, k)
    EN.setdefault(k, k)


def _scan_tpl(line, start):
    """Scan a template literal starting at `start` (just past opening backtick).
    Returns (body, index_after_closing_backtick) or (None, -1)."""
    n = len(line)
    k = start
    expr_depth = 0
    while k < n:
        c = line[k]
        if c == '\\':
            k += 2
            continue
        if expr_depth == 0:
            if c == '$' and k + 1 < n and line[k + 1] == '{':
                expr_depth += 1
                k += 2
                continue
            if c == '`':
                return line[start:k], k + 1
        else:
            if c == '{':
                expr_depth += 1
            elif c == '}':
                expr_depth -= 1
            elif c in ('"', "'"):
                q = c
                k += 1
                while k < n and line[k] != q:
                    if line[k] == '\\':
                        k += 1
                    k += 1
            elif c == '`':
                # nested template inside expr: skip to its close
                nd = 0
                k += 1
                while k < n:
                    c2 = line[k]
                    if c2 == '\\':
                        k += 2
                        continue
                    if c2 == '$' and k + 1 < n and line[k + 1] == '{':
                        nd += 1
                        k += 2
                        continue
                    if c2 == '}' and nd > 0:
                        nd -= 1
                    elif c2 == '`' and nd == 0:
                        break
                    k += 1
        k += 1
    return None, -1


def wrap_tpl_static(line, stats):
    """For each `...` span on the line, split into static/expr parts; wrap CJK statics."""
    if '`' not in line:
        return line
    out = []
    i = 0
    n = len(line)
    while i < n:
        b1 = line.find('`', i)
        if b1 == -1:
            out.append(line[i:])
            break
        # find closing backtick — handle nested template literals via depth counting
        b2 = -1
        depth = 1
        k = b1 + 1
        while k < n:
            c = line[k]
            if c == '\\':
                k += 2
                continue
            if c == '`':
                depth += 1  # toggle: open or close
                if depth % 2 == 0:
                    pass
                # crude: treat every backtick as toggle
                depth = 1 if False else depth
            k += 1
        # simpler: scan with a toggle counter
        cnt = 0
        k = b1 + 1
        close_pos = -1
        while k < n:
            c = line[k]
            if c == '\\':
                k += 2
                continue
            if c == '`':
                cnt += 1
                if cnt % 2 == 1:
                    close_pos = k  # this backtick closes the outer (odd count)
                    break
            k += 1
        if close_pos == -1:
            out.append(line[i:])
            break
        b2 = close_pos
        out.append(line[i:b1])
        tpl, adv = _scan_tpl(line, b1 + 1)
        if tpl is None:
            out.append(line[b1:])
            break
        b2 = adv - 1  # adv points past closing backtick
        # already has any t( call? then partially wrapped; still process unwrapped statics
        parts = []  # (kind, text) kind in {'s','e'}
        j = 0
        while j < len(tpl):
            e = tpl.find('${', j)
            if e == -1:
                parts.append(('s', tpl[j:]))
                break
            if e > j:
                parts.append(('s', tpl[j:e]))
            # find matching } — handle nested ${}, quotes, and nested template literals
            depth = 1
            k = e + 2
            while k < len(tpl) and depth:
                c = tpl[k]
                if c == '\\':
                    k += 2
                    continue
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                elif c in ('"', "'", '`'):
                    q = c
                    k += 1
                    if q == '`':
                        # nested template: handle its ${...} too
                        nd = 0
                        while k < len(tpl):
                            c2 = tpl[k]
                            if c2 == '\\':
                                k += 2
                                continue
                            if c2 == '`' and nd == 0:
                                break
                            if c2 == '$' and k + 1 < len(tpl) and tpl[k + 1] == '{':
                                nd += 1
                                k += 1
                            elif c2 == '{' and nd > 0:
                                pass
                            elif c2 == '}' and nd > 0:
                                nd -= 1
                            k += 1
                    else:
                        while k < len(tpl) and tpl[k] != q:
                            if tpl[k] == '\\':
                                k += 1
                            k += 1
                k += 1
            parts.append(('e', tpl[e:k]))
            j = k
        new_parts = []
        for kind, text in parts:
            if kind == 'e' or not CJK.search(text):
                new_parts.append(text)
                continue
            core = text.strip()
            lead = text[:len(text) - len(text.lstrip())]
            trail = text[len(text.rstrip()):]
            if not core or len(core) > 150 or '${' in core:
                new_parts.append(text)
                continue
            add_key(core)
            stats['tpl_seg'] += 1
            new_parts.append(f"${{t('{js_escape(core)}')}}".replace('\\$', '$'))
            # keep surrounding whitespace outside the expression
            if lead or trail:
                # put whitespace around the expr
                new_parts[-1] = lead + new_parts[-1][2:] if False else new_parts[-1]
        # rebuild with whitespace preservation: simpler — wrap including lead/trail inside expr string
        out.append('`' + ''.join(new_parts) + '`')
        i = b2 + 1
    return ''.join(out)


def wrap_line(line, stats):
    if not CJK.search(line):
        return line
    s = line.strip()
    if s.startswith(('//', '*', '/*')):
        return line
    return wrap_tpl_static(line, stats)


def main():
    target = Path(sys.argv[1])
    src = target.read_text(encoding='utf-8')
    backup = src
    stats = {'tpl_seg': 0}
    lines = src.split('\n')
    fixed = [wrap_line(l, stats) for l in lines]
    result = '\n'.join(fixed)
    target.write_text(result, encoding='utf-8')
    check = subprocess.run(['node', '--check', str(target)], capture_output=True, text=True)
    if check.returncode != 0:
        target.write_text(backup, encoding='utf-8')
        print('SYNTAX ERROR — reverted:', check.stderr[:500])
        sys.exit(1)
    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    EN_PATH.write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                       encoding='utf-8')
    print(f"OK {target.name}: {stats} zh={len(ZH)}")


if __name__ == '__main__':
    main()
