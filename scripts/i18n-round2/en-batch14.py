#!/usr/bin/env python3
"""Batch 14: EN translations — fragments, uptime, tags, misc tails."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "文件通常位于": "The file is usually at",
    "，即 Linux/macOS 下的": ", i.e. under",
    "。Token 会保存到当前供应商，请勿上传给第三方。": ". Tokens are stored for this provider — never share them with third parties.",
    "加载模型列表失败": "Failed to load model list",
    "个上游已不存在的本地模型记录（含 Team / API Key 绑定等关联数据）。此操作不可撤销。": "local model records that no longer exist upstream (including team / API key bindings). This cannot be undone.",
    "SuperGrok 计费信息": "SuperGrok billing info",
    "按产品用量": "By product usage",
    "周期": "Period",
    "(无 Key)": "(no key)",
    "合计": "Total",
    "错误信息": "Error message",
    "原始响应": "Raw response",
    "消息读取统计": "Message read stats",
    "无匹配用户": "No matching users",
    "，服务会短暂中断并自动重启。": ". The service will briefly go down and restart automatically.",
    "输入 Tokens": "Input tokens",
    "输出 Tokens": "Output tokens",
    "总计 Tokens": "Total tokens",
    "结束原因": "Finish reason",
    "未找到匹配的用户": "No matching users found",
    "✓ 已验证": "✓ Verified",
    "✗ 未验证": "✗ Unverified",
    "无可退款余额": "No refundable balance",
    "暂无匹配的模型": "No matching models",
    "不限制": "Unlimited",
    "暂无": "None",
    "固定": "Static",
    "未找到匹配的供应商": "No matching providers found",
    "已添加": "Added",
    "🌐 系统代理": "🌐 System proxy",
    "🔄 全局池": "🔄 Global pool",
    "暂无手动代理": "No manual proxies",
    "当前": "Current",
    "正在分析，请稍候...": "Analyzing, please wait...",
    "正在生成修复代码，请稍候...": "Generating fix code, please wait...",
    "⚠️ AI 未能生成修复代码": "⚠️ AI couldn't generate a fix",
    "将同时删除该供应商下的全部模型": "All models under this provider will also be deleted",
    "每个供应商": "each provider",
    "拉取上游模型列表，对比后": "pull upstream model lists, compare, then",
    "新模型": "new models",
    "没有任何模型被勾选": "No models are checked",
    "。保存后将": ". After saving, ",
    "禁用该供应商下所有已有模型": "all existing models of this provider will be disabled",
    "未找到有效的 API Key": "No valid API key found",
    "当前筛选条件下暂无组合数据": "No combination data under current filters",
    "暂无使用数据": "No usage data",
    "暂无模型使用数据": "No model usage data",
    "未找到匹配的模型": "No matching models found",
    "暂无供应商使用数据": "No provider usage data",
    "暂无来源数据（历史记录在功能上线前均为「未知/其他」）": "No source data (history before this feature launched shows as \"unknown/other\")",
    "暂无错误记录": "No error records",
    "配额内": "In quota",
    "暂无系列图标": "No series icons",
    "暂无用户组，点击右上角创建": "No groups yet — create one from the top-right",
    "未找到匹配的用户组": "No matching groups found",
    "✓ 默认": "✓ Default",
    "暂无成员": "No members",
    "未找到匹配的成员": "No matching members found",
    "所有用户都已在此用户组中": "All users are already in this group",
    "暂无 Team，点击右上角创建": "No teams yet — create one from the top-right",
    "未找到匹配的 Team": "No matching teams found",
    "前沿": "Frontier",
    "所有用户都已在此 Team 中": "All users are already in this team",
    "供应商禁用": "Provider disabled",
    "暂无标签，请先在列表上方创建": "No tags yet — create one above the list first",
    "思考": "Thinking",
    "对话内容": "Chat content",
    "💭 思考过程": "💭 Thinking process",
    "分钟前": " min ago",
    "小时前": " h ago",
    "天前": " d ago",
    "天后过期": " days until expiry",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

# fix the odd one (key with " on Linux/macOS" was a value typo guard)
en.pop(" on Linux/macOS", None)

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n} filled; remaining: {sum(1 for k in en if en[k] == k)}')
