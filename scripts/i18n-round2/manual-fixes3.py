#!/usr/bin/env python3
"""Repair pass 11: final stragglers in admin.js (proxy pool section) + app misc."""
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


def add_key(k):
    k = k.strip()
    if k and re.search(r'[\u4e00-\u9fff]', k):
        ZH.setdefault(k, k)
        EN.setdefault(k, EN.get(k, k))


FIXES = {
    'admin.js': [
        # L4393/L4406 static title attrs in template literals
        (
            '<span style="font-size:12px;color:#8b5cf6;" title="使用系统设置中的代理">',
            '<span style="font-size:12px;color:#8b5cf6;" title="${t(\'使用系统设置中的代理\')}">',
        ),
        (
            '<span style="font-size:12px;color:#3b82f6;" title="使用系统全局代理池">',
            '<span style="font-size:12px;color:#3b82f6;" title="${t(\'使用系统全局代理池\')}">',
        ),
        # L4411 broken span concat with empty +
        (
            "？ `${'<span title=t(\\'手动添加的代理\\')>' + }${healthyCount}/${proxyPool.length}",
            None,  # handled by regex below
        ),
    ],
    'app.js': [],
}


def main():
    # admin.js targeted fixes
    p = ROOT / 'public' / 'js' / 'admin.js'
    src = p.read_text(encoding='utf-8')
    backup = src
    n = 0
    for old, new in FIXES['admin.js']:
        if new is None:
            continue
        if old in src:
            # only replace when inside a template literal (backtick) context on that line
            line_idx = src.find(old)
            line_start = src.rfind('\n', 0, line_idx)
            the_line = src[line_start:src.find('\n', line_idx)]
            if '`' in the_line:
                src = src.replace(old, new)
                key = old.split('title="')[1].split('"')[0]
                add_key(key)
                n += 1

    # L4411 broken: ${'<span title=t(\'手动添加的代理\')>' + }  → rebuild
    pat = re.compile(r"\$\{'<span title=t\(\\'手动添加的代理\\'\)>' \+ \}")
    if pat.search(src):
        src = pat.sub("${'<span title=\"' + t('手动添加的代理') + '\">'}", src)
        add_key('手动添加的代理')
        n += 1

    # L2944/3435 tab labels >全局供应商 <span ...
    src2 = re.sub(r">(全局供应商)( <span)", r">${t('\1')}\2", src)
    if src2 != src:
        add_key('全局供应商')
        src = src2; n += 1
    src2 = re.sub(r">(用户供应商)( <span)", r">${t('\1')}\2", src)
    if src2 != src:
        add_key('用户供应商')
        src = src2; n += 1

    p.write_text(src, encoding='utf-8')
    check = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
    if check.returncode != 0:
        p.write_text(backup, encoding='utf-8')
        print(f"admin.js: SYNTAX ERROR reverted: {check.stderr[:300]}")
        sys.exit(1)
    print(f"admin.js: {n} fixes")

    # keys from replacements
    for m in re.finditer(r"""\bt\('([^']+[\u4e00-\u9fff][^']*)'\)""", src):
        pass  # keys already added above where needed

    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    EN_PATH.write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                       encoding='utf-8')
    print(f"zh={len(ZH)}")


if __name__ == '__main__':
    main()
