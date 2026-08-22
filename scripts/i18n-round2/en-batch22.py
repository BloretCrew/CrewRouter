#!/usr/bin/env python3
"""Batch 22: EN — final 13 keys (escape-heavy ones, matched programmatically)."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

# Match keys by normalized content (strip backslashes) to avoid escape-count mismatch
def find_key(en, needle):
    for k in en:
        if k.replace('\\', '') == needle.replace('\\', ''):
            return k
    return None

PAIRS = [
    ("\\n上次错误:", "\\nLast error:"),
    ("\\n新增:", "\\nNew:"),
    ("\\n更新:", "\\nUpdated:"),
    ("\\n模型:", "\\nModels:"),
    ("\\n未找到的模型:", "\\nModels not found:"),
    ("复制工作区路径\\", "Copy workspace path\\"),
    ("手动添加的代理\\", "Manually added proxy\\"),
    ("\\n过期时间:", "\\nExpires:"),
    ("\\n\\n尝试过的路径:\\n", "\\n\\nPaths tried:\\n"),
    ("添加标签\\", "Add tag\\"),
    ("\\n\\n*[已停止]*", "\\n\\n*[Stopped]*"),
    ("加载中\\", "Loading\\"),
    ('模型测试将发送一条真实请求（"Hi"，max_tokens=5）到该模型，\\n并按照正常用量扣除积分。是否继续？',
     'This sends a real request ("Hi", max_tokens=5) to the model, \\nand credits are deducted as usual. Continue?'),
]

n = 0
for zh_key, en_val in PAIRS:
    actual = find_key(en, zh_key)
    if actual and en[actual] == actual:
        en[actual] = en_val
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

zh = json.loads((ROOT / 'lang/zh.json').read_text(encoding='utf-8'))
missing = [k for k in zh if en.get(k) == k]
print(f'{n} filled; remaining identity keys: {len(missing)}')
for k in missing:
    print(repr(k[:60]))
