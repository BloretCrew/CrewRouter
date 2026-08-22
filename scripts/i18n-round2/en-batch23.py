#!/usr/bin/env python3
"""Batch 23: EN — the true last 5 keys (raw JSON-level fix)."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

# keys end with a literal backslash (JS-escape artifact from wrapping); match by prefix
targets = {
    '复制工作区路径': 'Copy workspace path',
    '手动添加的代理': 'Manually added proxy',
    '添加标签': 'Add tag',
    '加载中': 'Loading',
}
for k in list(en.keys()):
    if en[k] == k:
        base = k.rstrip('\\')
        if base in targets:
            # keep the same trailing backslash count
            trailing = k[len(base):]
            en[k] = targets[base] + trailing

# the long confirm() key
for k in list(en.keys()):
    if en[k] == k and '模型测试将发送一条真实请求' in k:
        en[k] = ('This sends a real request ("Hi", max_tokens=5) to the model, '
                 '\\nand credits are deducted as usual. Continue?')

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

zh = json.loads((ROOT / 'lang/zh.json').read_text(encoding='utf-8'))
missing = [k for k in zh if en.get(k) == k]
print('remaining identity keys:', len(missing))
for k in missing:
    print(repr(k[:60]))
