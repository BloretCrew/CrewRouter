#!/usr/bin/env python3
"""Batch 7: EN translations — import/bulk ops, quota detail, playground, errors."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "支持 OpenCode auth.json 和 Claude Code 配置两种格式，自动识别并导入供应商 API Key 和 Base URL。": "Supports both OpenCode auth.json and Claude Code config formats — auto-detects and imports provider API keys and base URL.",
    "配置内容 (JSON)": "Config content (JSON)",
    "或上传文件": "or upload a file",
    "预览导入内容": "Preview import",
    "获取模型列表": "Fetch model list",
    "全部": "All",
    "已失效": "Delisted",
    "清理已下架模型": "Clean up delisted models",
    "批量设置固定价格": "Bulk set fixed prices",
    "将为选中的": "For the selected",
    "个模型设置以下价格：": "models, the following prices will be set:",
    "确认设置": "Confirm",
    "JSON 批量定价": "JSON bulk pricing",
    "使用 JSON 格式为不同模型设置不同价格，单位：": "Set per-model prices via JSON. Unit:",
    "¥/百万Token": "¥/1M tokens",
    "格式说明": "Format guide",
    "应用价格": "Apply prices",
    "JSON 批量定参考价": "JSON bulk reference pricing",
    "使用 JSON 格式为不同模型设置参考价格，单位：": "Set per-model reference prices via JSON. Unit:",
    "应用参考价": "Apply reference prices",
    "批量按比例调整价格": "Bulk adjust prices by percentage",
    "将对选中的": "The prices of the selected",
    "个模型的价格按比例调整：": "models will be adjusted by:",
    "调整百分比（正数为涨价，负数为降价）": "Adjustment % (positive = raise, negative = lower)",
    "确认调整": "Confirm adjustment",
    "批量设置速率限制": "Bulk set rate limits",
    "个模型设置以下速率限制：": "models will get these rate limits:",
    "每分钟请求数（0=不限制）": "Requests per minute (0 = unlimited)",
    "每分钟Token数（0=不限制）": "Tokens per minute (0 = unlimited)",
    "批量修改模型说明": "Bulk edit model descriptions",
    "个模型修改说明：": "models will get their description changed:",
    "修改模式": "Edit mode",
    "替换为新说明": "Replace with new text",
    "追加到现有说明": "Append to existing",
    "前置到现有说明": "Prepend to existing",
    "说明内容": "Description text",
    "确认修改": "Confirm change",
    "批量设置系列": "Bulk set series",
    "个模型设置系列：": "models will be assigned this series:",
    "系列图标管理": "Series icon manager",
    "为每个系列设置图标，图标将显示在用户控制台的模型卡片上。": "Set an icon per series; icons show on model cards in the user console.",
    "选择系列...": "Select series...",
    "按参考价百分比设置价格": "Set price as % of reference price",
    "将选中的": "The selected",
    "个模型的实际价格设置为参考价的指定百分比：": "models' actual prices will be set to the given % of reference:",
    "输入价百分比（%）": "Input price (%)",
    "输出价百分比（%）": "Output price (%)",
    "预览（价格单位：¥/百万Token）": "Preview (unit: ¥/1M tokens)",
    "当前输入价": "Current input price",
    "参考输入价": "Reference input price",
    "新输入价": "New input price",
    "当前输出价": "Current output price",
    "参考输出价": "Reference output price",
    "新输出价": "New output price",
    "预览": "Preview",
    "确认执行": "Confirm",
    "供应商额度查询": "Provider quota query",
    "正在查询供应商额度，请稍候...": "Querying provider quota, please wait...",
    "使用率": "Utilization",
    "总额度": "Total quota",
    "已使用": "Used",
    "剩余额度": "Remaining",
    "查询脚本": "Query script",
    "脚本格式与 cc-switch 一致，包含": "Script format matches cc-switch: it contains",
    "（请求配置）和": "(request config) and",
    "（响应解析函数）。支持变量：": "(response parser). Supported variables:",
    "编辑脚本": "Edit script",
    "保存并查询": "Save and query",
    "调用错误详情": "Call error details",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
