#!/usr/bin/env python3
"""Fix the last two alert/concat lines in admin.js."""
import json
import re
from pathlib import Path

ROOT = Path('/data/CrewRouter')
ZH = json.loads((ROOT / 'lang/zh.json').read_text(encoding='utf-8'))
EN = json.loads((ROOT / 'lang/en.json').read_text(encoding='utf-8'))
p = ROOT / 'public/js/admin.js'
src = p.read_text(encoding='utf-8')
fixes = [
    ("+ (data.expiresAt ? '\\n过期时间: ' + new Date(data.expiresAt).toLocaleString('zh-CN') : '')",
     "+ (data.expiresAt ? '\\n' + t('过期时间: ') + new Date(data.expiresAt).toLocaleString('zh-CN') : '')"),
    ("errorMsg += '\\n\\n尝试过的路径:\\n';",
     "errorMsg += '\\n\\n' + t('尝试过的路径:') + '\\n';"),
]
for old, new in fixes:
    assert old in src, old[:40]
    src = src.replace(old, new)
    for m in re.finditer(r"t\('([^']*[\u4e00-\u9fff][^']*)'\)", new):
        ZH.setdefault(m.group(1), m.group(1))
        EN.setdefault(m.group(1), m.group(1))
p.write_text(src, encoding='utf-8')
(ROOT / 'lang/zh.json').write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(ROOT / 'lang/en.json').write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                                   encoding='utf-8')
print('ok, zh =', len(ZH))
