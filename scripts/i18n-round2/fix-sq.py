#!/usr/bin/env python3
"""Round-2 pass-4: wrap Chinese inside single-quoted HTML fragments & template text nodes.

Targets the leftovers fix-tl.py skipped (nested quotes in template literals):
A. `'<tag>中文</tag>'` inside ${...} ternaries → '<tag>' + t('中文') + '</tag>'
B. template-literal text nodes still plain (line has backtick, chunk NOT preceded
   by a single-quote opener) → ${t('中文')}
Strategy per line: try B first with the nested-quote guard; then A with
quote-aware splitting (only split when the literal's >text< chunk has CJK and
no quotes inside).

node --check after write; revert on failure.
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


def wrap_sq_html(line, stats):
    """A: single-quoted HTML fragments with CJK text nodes → concat t()."""
    changed = False
    out = []
    i = 0
    n = len(line)
    while i < n:
        qpos = line.find("'", i)
        if qpos == -1:
            out.append(line[i:])
            break
        # find close
        j = qpos + 1
        body = []
        while j < n:
            c = line[j]
            if c == '\\':
                body.append(line[j:j + 2]); j += 2; continue
            if c == "'":
                break
            body.append(c); j += 1
        if j >= n:  # unterminated on this line
            out.append(line[i:])
            break
        body = ''.join(body)
        # left context: is this already t('...')?
        left = line[max(0, qpos - 40):qpos]
        if (not CJK.search(body) or '${' in body
                or re.search(r"(?:\bt|I18N\.t)\s*\(\s*$", left)):
            out.append(line[i:j + 1]); i = j + 1; continue
        # split >text< nodes with CJK
        spans = []
        ok = True
        for m in re.finditer(r">([^<>]{1,100})<", body):
            text = m.group(1)
            if not CJK.search(text):
                continue
            key = text.strip()
            if not key or len(key) > 100 or any(c in text for c in ("\\", '"', "'", "${")):
                ok = False
                break
            spans.append((m.start(1), m.end(1), key))
        if not ok or not spans:
            out.append(line[i:j + 1]); i = j + 1; continue
        bits = [line[i:qpos]]  # prefix before the opening quote (e.g. setHTML(x, )
        cur = 0
        for s, e, key in spans:
            if s > cur:
                bits.append("'" + body[cur:s] + "'")
            add_key(key)
            bits.append("t('" + js_escape(key) + "')")
            cur = e
        if cur < len(body):
            bits.append("'" + body[cur:] + "'")
        out.append(" + ".join(bits))
        stats['sq_html'] += 1
        changed = True
        i = j + 1
    return (''.join(out), changed) if changed else (line, False)


def wrap_line(line, stats):
    if not CJK.search(line):
        return line
    s = line.strip()
    if s.startswith(('//', '*', '/*')):
        return line

    # B: template text nodes with nested-quote guard (same as fix-tl)
    if '`' in line:
        def tl_text(m):
            chunk = m.group(1)
            if not CJK.search(chunk):
                return m.group(0)
            key = chunk.strip()
            if not key or len(key) > 120 or '${' in chunk:
                return m.group(0)
            lead = chunk[:len(chunk) - len(chunk.lstrip())]
            trail = chunk[len(chunk.rstrip()):]
            core = chunk.strip()
            add_key(core)
            stats['tl_text'] += 1
            return f'>{lead}${{t(\'' + js_escape(core) + f"\')}}{trail}<"
        new_line = re.sub(r">([^<>{}]+)<", tl_text, line)
        if new_line != line:
            unsafe = False
            first_inj = new_line.find("${t('")
            while first_inj != -1 and not unsafe:
                before = new_line[:first_inj]
                q1 = before.rfind("'")
                b1 = before.rfind("`")
                if q1 > b1:
                    unsafe = True
                else:
                    open_expr = before.rfind("${")
                    close_expr = before.rfind("}")
                    if open_expr != -1 and (close_expr == -1 or open_expr > close_expr):
                        seg = before[open_expr:]
                        if seg.count("${") > seg.count("}"):
                            unsafe = True
                first_inj = new_line.find("${t('", first_inj + 1)
            if not unsafe:
                line = new_line

    # A: single-quoted HTML fragments (works in both plain and ${...} contexts)
    line2, changed = wrap_sq_html(line, stats)
    return line2


def main():
    target = Path(sys.argv[1])
    src = target.read_text(encoding='utf-8')
    backup = src
    stats = {'tl_text': 0, 'sq_html': 0}
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
