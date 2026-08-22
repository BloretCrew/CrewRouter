#!/usr/bin/env python3
"""Wrap 永久删除 in L5589 template text node."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
ZH = json.loads((ROOT / 'lang/zh.json').read_text(encoding='utf-8'))
EN = json.loads((ROOT / 'lang/en.json').read_text(encoding='utf-8'))
p = ROOT / 'public/js/admin.js'
src = p.read_text(encoding='utf-8')
old = "color:var(--destructive);\">永久删除</strong>${t('本供应商下')}"
new = "color:var(--destructive);\">${t('永久删除')}</strong>${t('本供应商下')}"
assert old in src, 'not found'
src = src.replace(old, new)
ZH.setdefault('永久删除', '永久删除')
EN.setdefault('永久删除', '永久删除')
p.write_text(src, encoding='utf-8')
(ROOT / 'lang/zh.json').write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(ROOT / 'lang/en.json').write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                                   encoding='utf-8')
print('ok')
