#!/usr/bin/env python3
"""Batch 10: EN translations — settings, groups, teams, model ops errors."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "保存设置失败:": "Failed to save settings:",
    "加载设置失败:": "Failed to load settings:",
    "[飞书配置] 正在加载…": "[Feishu] Loading…",
    "[飞书配置] 加载失败, status=": "[Feishu] Load failed, status=",
    "[飞书配置] 加载成功:": "[Feishu] Loaded:",
    "数据库设置": "Database settings",
    "[飞书配置] 加载异常:": "[Feishu] Load exception:",
    "启用飞书登录时必须填写 App ID": "App ID is required to enable Feishu sign-in",
    "启用飞书登录时必须填写 App Secret": "App Secret is required to enable Feishu sign-in",
    "[飞书配置] 正在保存…": "[Feishu] Saving…",
    "已设置": "Configured",
    "未设置": "Not set",
    "保存中…": "Saving…",
    "[飞书配置] 保存失败:": "[Feishu] Save failed:",
    "[飞书配置] 保存成功:": "[Feishu] Saved:",
    "飞书登录配置已保存": "Feishu sign-in config saved",
    "[飞书配置] 保存异常:": "[Feishu] Save exception:",
    "回调地址为空": "Callback URL is empty",
    "[飞书配置] 已复制回调地址:": "[Feishu] Callback URL copied:",
    "回调地址已复制": "Callback URL copied",
    "[飞书配置] 剪贴板复制失败，尝试选中输入框": "[Feishu] Clipboard copy failed — selecting the input instead",
    "请输入有效的价格": "Enter a valid price",
    "价格设置成功": "Prices updated",
    "批量设置价格失败:": "Bulk price update failed:",
    "暂无模型数据": "No model data",
    "名称": "Name",
    "输入价/百万Token": "Input /1M tokens",
    "输出价/百万Token": "Output /1M tokens",
    "速率限制RPM": "RPM limit",
    "速率限制TPM": "TPM limit",
    "正在导出…": "Exporting…",
    "暂无供应商数据可导出": "No provider data to export",
    "格式": "Format",
    "分组": "Grouping",
    "模型同步地址": "Model sync URL",
    "创建时间": "Created at",
    "系统代理": "System proxy",
    "单代理": "Single proxy",
    "未配置": "Not configured",
    "代理池": "Proxy pool",
    "·权重": "· weighted",
    "·顺序": "· sequential",
    "已配置": "Configured",
    "请输入 JSON 数据": "Enter JSON data",
    "JSON 格式不正确，需要是 { \"model-id\": {\"in\": 价格, \"out\": 价格} } 的对象": "Invalid JSON. Expected { \"model-id\": {\"in\": price, \"out\": price} }",
    "JSON 批量定价失败:": "JSON bulk pricing failed:",
    "请求失败: ": "Request failed: ",
    "JSON 批量定参考价失败:": "JSON bulk reference pricing failed:",
    "请输入有效的百分比": "Enter a valid percentage",
    "上涨": "raised",
    "下降": "lowered",
    "价格调整成功": "Prices adjusted",
    "调整失败": "Adjustment failed",
    "批量调整价格失败:": "Bulk price adjustment failed:",
    "速率限制设置成功": "Rate limits updated",
    "批量设置速率限制失败:": "Bulk rate limit update failed:",
    "输入要追加的内容...": "Text to append...",
    "输入要前置的内容...": "Text to prepend...",
    "请输入说明内容": "Enter the description text",
    "批量修改说明失败:": "Bulk description edit failed:",
    "无": "None",
    "批量设置系列失败:": "Bulk series update failed:",
    "加载系列列表失败:": "Failed to load series list:",
    "未设置图标": "No icon set",
    "加载系列图标失败:": "Failed to load series icons:",
    "请输入系列名称": "Enter the series name",
    "预览失败": "Preview failed",
    "预览失败:": "Preview failed:",
    "预览失败: ": "Preview failed: ",
    "按参考价设置价格失败:": "Reference-price pricing failed:",
    "设置失败: ": "Failed: ",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
