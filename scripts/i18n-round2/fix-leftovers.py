#!/usr/bin/env python3
"""Repair pass 9: batch-wrap remaining simple leftovers via targeted regexes.

Handles the recurring patterns in the final audit:
1. title="中文..." static attr in template literals → title="${t('中文...')}"
2. >中文</span></div> trailing text after expr in templates
3. '上次错误: ' style concat fragments → t()
4. Global供应商 / 用户供应商 tab labels
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


def jsq(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


def add_key(k):
    k = k.strip()
    if k and CJK.search(k):
        ZH.setdefault(k, k)
        EN.setdefault(k, EN.get(k, k))


def wrap_line(line):
    """Apply the pattern fixes; return (line, n_applied, keys)."""
    orig = line
    keys = []
    s = line.strip()
    if s.startswith(('//', '*', '/*')) or not CJK.search(line):
        return line, 0, keys

    # 1) static title attr with CJK inside template literal (no ${ inside value)
    def title_fix(m):
        pre, val = m.group(1), m.group(2)
        if not CJK.search(val) or '${' in val or 't(' in val:
            return m.group(0)
        keys.append(val)
        return f'{pre}title="${{t(\'{jsq(val)}\')}}"'
    line = re.sub(r'(\btitle=")((?:(?!t\()[^"$])*[\u4e00-\u9fff](?:(?!t\()[^"$])*)"',
                  title_fix, line)

    # 2) trailing text nodes after expr: }中文</span>  or  }中文</div>
    def trail_fix(m):
        text = m.group(1)
        tag = m.group(2)
        if not CJK.search(text) or '${' in text:
            return m.group(0)
        keys.append(text)
        return "}${t('" + jsq(text) + "')}" + tag
    line = re.sub(r"\}([^<>{}'\"]*[\u4e00-\u9fff][^<>{}'\"]*)(</(?:span|div|strong|b|p|a|td|th|em)>)",
                  trail_fix, line)

    # 3) quoted concat fragments '中文：' / '中文，' followed by + expr
    def frag_fix(m):
        val = m.group(1)
        left = line[max(0, m.start() - 40):m.start()]
        if re.search(r"\bt\s*\(\s*$", left) or '${' in val:
            return m.group(0)
        if not CJK.search(val) or len(val) > 80:
            return m.group(0)
        keys.append(val)
        return "t('" + jsq(val) + "')"
    line = re.sub(r"'([^'\n]*[\u4e00-\u9fff][^'\n]*)'", frag_fix, line)

    n = 0 if line == orig else 1
    return line, n, keys


def main():
    grand = 0
    for name in ['app.js', 'admin.js', 'playground.js', 'dialog.js', 'dom.js', 'theme.js']:
        p = ROOT / 'public' / 'js' / name
        src = p.read_text(encoding='utf-8')
        backup = src
        lines = src.split('\n')
        n = 0
        for i, line in enumerate(lines):
            new, cnt, keys = wrap_line(line)
            if cnt:
                lines[i] = new
                n += cnt
                for k in keys:
                    add_key(k)
        result = '\n'.join(lines)
        p.write_text(result, encoding='utf-8')
        check = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
        if check.returncode != 0:
            p.write_text(backup, encoding='utf-8')
            print(f"{name}: SYNTAX ERROR reverted: {check.stderr[:300]}")
            continue
        print(f"{name}: {n} lines changed")
        grand += n
    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    EN_PATH.write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                       encoding='utf-8')
    print(f"TOTAL lines: {grand}, zh={len(ZH)}")


if __name__ == '__main__':
    main()
