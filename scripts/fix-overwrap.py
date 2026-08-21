#!/usr/bin/env python3
"""Fix over-wrapping in app.js: revert t('...') calls whose key is code-ish.

Targets:
1. selector-like keys: '.copy-btn[title="显示/隐藏"]' → restore original literal
2. console.error/warn/log prefixes ('加载用户信息失败:' etc.) → unwrap (dev-facing)
3. comment fragments ('    // 用户组额度规则') → unwrap
4. [模型库]/[Chart] debug prefixes → unwrap (dev-facing)
"""
import json
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')
TARGET = ROOT / 'public' / 'js' / 'app.js'
ZH_PATH = ROOT / 'lang' / 'zh.json'
EN_PATH = ROOT / 'lang' / 'en.json'
src = TARGET.read_text(encoding='utf-8')
zh = json.loads(ZH_PATH.read_text(encoding='utf-8'))
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

CJK = re.compile(r'[\u4e00-\u9fff]')


def is_codeish(k: str) -> bool:
    ks = k.strip()
    if ks.startswith(('//', '[Chart]', '[uptime]', '[模型库]', '[API Key 模型选择]', '[标签]')):
        return True
    if re.match(r'^[.\[#]', ks) and any(c in ks for c in ('=', '[', ']')):
        return True
    if re.search(r'^\s{4,}//', k):
        return True
    # selector fragments
    if '.copy-btn' in ks or 'querySelector' in ks:
        return True
    return False


def is_console_log_key(src: str, key: str) -> bool:
    """key used inside console.*(...) call on its line."""
    pat = re.compile(r"console\.(?:error|warn|log|info)\([^)]{0,120}?t\('" + re.escape(key) + r"'")
    return bool(pat.search(src))


# collect keys to unwrap
unwrap_keys = set()
for k in list(zh):
    if is_codeish(k):
        unwrap_keys.add(k)

print('codeish keys to unwrap:', len(unwrap_keys))

# pass A: replace t('KEY') with the raw literal for codeish keys (handle quote style)
changed = 0
for k in sorted(unwrap_keys, key=len, reverse=True):
    esc = k.replace('\\', '\\\\').replace("'", "\\'")
    for q in ("'", '"'):
        old = f"t({q}{esc}{q})"
        if old in src:
            src = src.replace(old, f"{q}{k.replace(q, chr(92) + q) if False else k}{q}")
            changed += 1
            break

# pass B: console.log/error prefixes — find remaining t('...:') inside console calls
log_pat = re.compile(r"(console\.(?:error|warn|log|info)\()t\('((?:[^'\\]|\\.)*)'\)")
def log_repl(m):
    global changed
    changed += 1
    return m.group(1) + "'" + m.group(2) + "'"
src = log_pat.sub(log_repl, src)

TARGET.write_text(src, encoding='utf-8')

# clean catalogs: remove keys no longer referenced anywhere in wrapped files
all_src = src + (ROOT / 'public' / 'pages' / 'console.html').read_text(encoding='utf-8')
used = set()
for k in zh:
    esc = k.replace('\\', '\\\\').replace("'", "\\'")
    if f"t('{esc}')" in all_src or f'data-i18n="{k}"' in all_src or f'data-i18n-placeholder="{k}"' in all_src or f'data-i18n-title="{k}"' in all_src:
        used.add(k)
removed = [k for k in zh if k not in used]
for k in removed:
    zh.pop(k)
    en.pop(k, None)
ZH_PATH.write_text(json.dumps(zh, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

print(f'unwrapped {changed} call sites; removed {len(removed)} dead keys; zh={len(zh)} en={len(en)}')
