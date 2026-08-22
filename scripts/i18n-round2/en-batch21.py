#!/usr/bin/env python3
"""Batch 21: EN translations — truly the last 32 keys."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "    // 用户组额度规则": "    // Group quota rules",
    "    // 总用量统计": "    // Total usage stats",
    "    // 余额": "    // Balance",
    "0 ? `· 您的排名：第": "0 ? `· Your rank: No.",
    "\\\\n上次错误: ": "\\\\nLast error: ",
    "已星标「": "Starred \u201c",
    "已取消星标「": "Unstarred \u201c",
    "将按「": "This will overwrite your custom model library ordering for this account with \u201c",
    "」重写当前账号的模型库自定义排序：\\n": "\u201d:\\n",
    "• 各 Team 内供应商顺序\\n": "• Provider order within each team\\n",
    "• 各供应商内模型顺序\\n\\n": "• Model order within each provider\\n\\n",
    "通过测试的优先，未测试/失败靠后。是否继续？": "Tested models come first, untested/failed last. Continue?",
    "已按": "Sorted by ",
    "排序（": " (",
    "个供应商，": " providers, ",
    "个模型）": " models)",
    "额度接口异常 (": "Quota API error (",
    "重置于": ", resets in ",
    "小时后重置": "h",
    "分钟后重置": "min",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

zh = json.loads((ROOT / 'lang/zh.json').read_text(encoding='utf-8'))
missing = [k for k in zh if en.get(k) == k]
print(f'{n}/{len(M)} filled; remaining: {len(missing)}')
for k in missing:
    print(repr(k))
