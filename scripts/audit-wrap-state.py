#!/usr/bin/env python3
"""Audit current app.js wrap state: find t('...') calls whose key looks code-ish (selectors, log prefixes, comment fragments)."""
import json
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')
src = (ROOT / 'public' / 'js' / 'app.js').read_text(encoding='utf-8')
zh = json.loads((ROOT / 'lang' / 'zh.json').read_text(encoding='utf-8'))
en = json.loads((ROOT / 'lang' / 'en.json').read_text(encoding='utf-8'))

# keys that look like code/selectors — must NOT be translated nor wrapped
codeish = []
for k in zh:
    ks = k.strip()
    if re.match(r'^[.\[#a-z]', ks) and any(c in ks for c in ('=', '[', ']', '.', '#')):
        codeish.append(k)
    elif ks.startswith('//') or ks.startswith('[Chart]') or ks.startswith('[uptime]') or ks.startswith('[模型库]'):
        codeish.append(k)
print('codeish keys:', len(codeish))
for k in codeish[:30]:
    print(' ', repr(k[:80]))

# how many t( calls in app.js now
calls = len(re.findall(r"\bt\('", src))
print('\nt( call sites:', calls)

# untranslated count
untrans = [k for k in zh if en.get(k) == k]
cjk_untrans = [k for k in untrans if any('\u4e00' <= c <= '\u9fff' for c in k)]
print('untranslated CJK keys:', len(cjk_untrans))
