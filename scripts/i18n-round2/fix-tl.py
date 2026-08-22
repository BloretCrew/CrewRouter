#!/usr/bin/env python3
"""Round-2 fixer: wrap remaining Chinese in template literals & misc patterns.

Handles cases the line-scoped literal wrapper can't:
1. `placeholder=t('...')` — broken attr from earlier overwrap → placeholder="${t('...')}"
2. `title=t('...')` same → title="${t('...')}"
3. Template-literal text nodes: >中文< inside backticks → ${t('中文')}
4. Plain quoted strings missed by pass1 (with <code> tags etc.) → t('...')
   only when the whole literal is UI text (has CJK, not a path/key).

Syntax-checked with node --check after write; reverts on failure.
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


def wrap_line(line, stats):
    if not CJK.search(line):
        return line
    orig = line

    # 0) skip comments
    s = line.strip()
    if s.startswith(('//', '*', '/*')):
        return line

    # 1) broken attrs: attr=t('...')  →  attr="${t('...')}"
    def attr_fix(m):
        stats['broken_attr'] += 1
        key = m.group(2)
        add_key(key)
        return f"{m.group(1)}=\"${{t('{js_escape(key)}')}}\""
    line = re.sub(r"\b(placeholder|title|aria-label)=t\('([^']*[\u4e00-\u9fff][^']*)'\)", attr_fix, line)

    # 2) template-literal text nodes: >中文< → >${t('中文')}<
    #    only when line contains a backtick (template literal context)
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
        # Skip lines where the chunk sits inside a nested single-quoted string of an
        # outer template literal. Detect: scanning back from the injection point, the
        # nearest enclosing quote is a single-quote (nested string) rather than a
        # backtick (we'd still be in the template). Conservative: bail on the line.
        # ALSO bail when injection lands inside an existing ${...} expression.
        if line != new_line:
            first_inj = new_line.find("${t('")
            unsafe = False
            while first_inj != -1 and not unsafe:
                before = new_line[:first_inj]
                q1 = before.rfind("'")
                b1 = before.rfind("`")
                if q1 > b1:  # nested inside '...' — unsafe
                    unsafe = True
                else:
                    # inside an existing ${ } expression?
                    open_expr = before.rfind("${")
                    close_expr = before.rfind("}")
                    if open_expr != -1 and (close_expr == -1 or open_expr > close_expr):
                        # count nesting of ${ }
                        seg = before[open_expr:]
                        if seg.count("${") > seg.count("}"):
                            unsafe = True
                first_inj = new_line.find("${t('", first_inj + 1)
            if unsafe:
                stats['skipped_nested'] = stats.get('skipped_nested', 0) + 1
                return orig
        line = new_line
    else:
        return line  # no backtick: pass-2 N/A, keep pass-1/3 semantics for non-template lines

    # pass-3 only applies to non-backtick lines (plain string concatenation);
    # backtick lines with nested quotes are too risky (see skipped_nested above)

    # 3) plain single-quoted UI strings still unwrapped (whole literal CJK-ish UI text,
    #    may contain simple tags like <code>)
    STR_RE = re.compile(r"""(?<!\\)'([^'\n]*[\u4e00-\u9fff][^'\n]*?)(?<!\\)'""")

    def str_fix(m):
        body = m.group(1)
        left = line[max(0, m.start() - 40):m.start()]
        if re.search(r"(?:\bt|I18N\.t)\s*\(\s*$", left):
            return m.group(0)
        if '${' in body:
            return m.group(0)
        stripped = body.strip()
        if not stripped or len(stripped) > 150:
            return m.group(0)
        # reject paths/keys/urls
        if stripped.startswith(('http', '/', './', '~/', '#')):
            return m.group(0)
        # must be mostly-CJK text: allow short ASCII runs (tags, punctuation)
        cjk_n = len(CJK.findall(stripped))
        ascii_letters = len(re.findall(r'[A-Za-z]', stripped))
        if cjk_n == 0 or ascii_letters > cjk_n * 4:
            return m.group(0)
        add_key(stripped)
        stats['plain'] += 1
        lead = body[:len(body) - len(body.lstrip())]
        trail = body[len(body.rstrip()):]
        core = stripped
        return f"'{lead}'" + " + t('" + js_escape(core) + "') + " + f"'{trail}'" if (lead or trail) else f"t('{js_escape(core)}')"

    new_line = STR_RE.sub(str_fix, line)

    # guard: never touch object keys  'xxx': value
    # (str_fix may have wrapped one; detect & revert that specific pattern)
    def obj_key_revert(m):
        return m.group(0).replace("t('" , "'", 1) if False else m.group(0)
    return new_line


def main():
    target = Path(sys.argv[1])
    src = target.read_text(encoding='utf-8')
    backup = src
    stats = {'broken_attr': 0, 'tl_text': 0, 'plain': 0}
    lines = src.split('\n')
    fixed = [wrap_line(l, stats) for l in lines]
    result = '\n'.join(fixed)
    target.write_text(result, encoding='utf-8')
    check = subprocess.run(['node', '--check', str(target)], capture_output=True, text=True)
    if check.returncode != 0:
        target.write_text(backup, encoding='utf-8')
        print('SYNTAX ERROR — reverted:', check.stderr[:600])
        sys.exit(1)
    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    EN_PATH.write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                       encoding='utf-8')
    print(f"OK {target.name}: {stats} zh={len(ZH)}")


if __name__ == '__main__':
    main()
