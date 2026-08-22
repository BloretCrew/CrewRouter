#!/usr/bin/env python3
"""Batch 15: EN translations — fragments & tails (queue, tests, uptime)."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "模型队列共": "The model queue has",
    "个，悬停查看 · 失败时按顺序回退": "models — hover to view · ordered fallback on failure",
    "还有": "",
    "个标签，点击或悬停查看": " more tags — click or hover to view",
    "已保存模型队列（": "Saved model queue (",
    "个）": ")",
    "共": "",
    "个模型（骨架统计）": " models (skeleton stats)",
    "找到": "Found",
    "个模型已选": " models selected",
    "预览：": "Preview:",
    "- 用量详情": "- Usage details",
    "后台还有": "There are",
    "条记录待整理": "records still being processed in the background",
    "已同步 · 最近更新": "Synced · last updated",
    "次 · ": " times · ",
    "Token · 最近": " tokens · ",
    "分钟前测试": " min ago",
    "小时前测试": " h ago",
    "天前测试": " d ago",
    "个模型，暂无测试结果": " models, no test results yet",
    "个成功": " succeeded",
    "个失败": " failed",
    "个未测试": " untested",
    "平均": "Avg",
    "已测试": "Tested",
    "个": "",
    "正在测试全部": "Testing all",
    "个模型...": " models...",
    "正在测试当前 Team": "Testing the current team's",
    "正在测试": "Testing",
    "正在测试 Team「": "Testing team \u201c",
    "正在测试供应商「": "Testing provider \u201c",
    "测试结果 [": "Test results [",
    "输入": "Input",
    "/ 输出": "/ output",
    "种 · 未知": " kinds · unknown",
    "条记录": " records",
    "第": "Page",
    "页": "",
    "导出失败 (": "Export failed (",
    "加载详情失败 (": "Failed to load details (",
    "小时": "h",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        if v == "" and k not in ("还有", "共", "个"):
            pass
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n} filled; remaining: {sum(1 for k in en if en[k] == k)}')
