#!/usr/bin/env python3
"""Batch 18: EN translations — remaining round-2 keys, part 3 of 3 (final)."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "清理已下架模型 (": "Clean up delisted models (",
    "等": " etc.",
    "已清理": "Cleaned",
    "个已下架模型": " delisted models",
    "成功对比": "Successfully compared",
    "个（拉取失败）": " (fetch failed)",
    "个（已启用": " (enabled: ",
    "，未启用": ", disabled: ",
    "，新模型": ", new: ",
    "，匹配": ", matched: ",
    "可手动重置:": "Manual reset:",
    "上次定时查询：": "Last scheduled query: ",
    "，剩余": ", remaining ",
    "，成功": ", success: ",
    "，失败": ", failed: ",
    "请先保存供应商，再绑定": "Save the provider before binding",
    "OAuth 已绑定到当前供应商": "OAuth linked to this provider",
    "导入成功!": "Import succeeded!",
    "\\n新增: ": "\\nNew: ",
    "\\n更新: ": "\\nUpdated: ",
    "\\n模型: ": "\\nModels: ",
    "默认保留近": "By default the last",
    "天的错误记录，中间失败（队列回退）与最终返回客户端的错误均可筛选。": "days of error records are kept. Both intermediate failures (queue fallback) and errors returned to clients are filterable.",
    "入": "In",
    "出": "Out",
    "当前配置来源：": "Current config source: ",
    "已导出": "Exported",
    "条": " rows",
    "\\n未找到的模型: ": "\\nModels not found: ",
    "个模型的参考价": " models' reference prices",
    "确定要将选中": "Confirm setting the selected",
    "% 吗？": "% ?",
    "成功更新": "Successfully updated",
    "个模型的说明": " models' descriptions",
    "成功设置": "Successfully set",
    "个模型的系列": " models' series",
    "设置 \"": "Set icon URL for \"",
    "\" 的图标 URL:": "\":",
    "确定要删除系列 \"": "Delete series icon config for \"",
    "\" 的图标配置吗？": "\"?",
    "确定要将选中的": "Confirm setting the selected",
    "个模型的价格设置为参考价的": " models' prices to this % of reference price:",
    "显示": "Show",
    "个 · 本 Team 已启用": " · enabled for this team",
    "· 已启用": " · enabled",
    "，清理": ", cleaning up ",
    "个 Key 绑定": " key bindings",
    "确定对本 Team": "Confirm for this team:",
    "供应商「": "provider \u201c",
    "」下的": "\u201d —",
    "个模型？": " models?",
    "当前筛选的": "The currently filtered",
    "将对本 Team": "will be applied to this team:",
    "约": "~",
    "个匹配「": " models matching \u201c",
    "」的模型，是否继续？": "\u201d. Continue?",
    "[模型测试] 本地查找: modelId=": "[Model test] Local lookup: modelId=",
    "[模型测试] 本地未找到 modelId=": "[Model test] modelId not found locally: ",
    "检查失败 (": "Check failed (",
    "。可点击「一键更新」安装。": ". Use \"One-click update\" to install.",
    "发现新版本 v": "New version v",
    "（当前 v": " (current v",
    "当前版本 v": "Current version v",
    "已是最新。": "Up to date.",
    "已是最新版本 v": "Already on version v",
    "确认更新到 v": "Update to v",
    "？服务将短暂中断并自动重启。": "? The service will briefly go down and restart automatically.",
    "更新失败 (": "Update failed (",
    "服务已恢复（v": "Service recovered (v",
    "更新完成，当前版本 v": "Update complete, now on v",
    "等待服务恢复… (": "Waiting for service recovery… (",
    "月": "-",
    "请求失败 (": "Request failed (",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
