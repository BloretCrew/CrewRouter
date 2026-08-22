#!/usr/bin/env python3
"""Batch 13: EN translations — model library errors, fragments, stats labels."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "加载供应商页面失败:": "Failed to load provider page:",
    "获取供应商信息失败:": "Failed to get provider info:",
    "加载个人Team模型失败:": "Failed to load personal team models:",
    "[模型库] 全局搜索失败:": "[Library] Global search failed:",
    "加载供应商额度失败:": "Failed to load provider quota:",
    "刷新供应商额度失败:": "Failed to refresh provider quota:",
    "[模型库] 加载跳过：缺少 team/provider": "[Library] Load skipped: missing team/provider",
    "[模型库] 渲染已加载模型失败:": "[Library] Failed to render loaded models:",
    "[模型库] 渲染供应商模型失败:": "[Library] Failed to render provider models:",
    "[模型库] 加载供应商模型失败:": "[Library] Failed to load provider models:",
    "[模型库] 加载 API Keys 失败:": "[Library] Failed to load API keys:",
    "[模型库] 应用模型失败:": "[Library] Failed to apply model:",
    "[模型库] 设置模型异常:": "[Library] Exception setting model:",
    "[模型库] Harness 绑定失败:": "[Library] Harness binding failed:",
    "[模型库] Harness 绑定异常:": "[Library] Harness binding exception:",
    "[模型库] 确认选择 Key": "[Library] Confirm key selection",
    "[模型库] 选中的 Key:": "[Library] Selected key:",
    "[模型库] 准备应用模型:": "[Library] Preparing to apply model:",
    "加载失败，": "Load failed. ",
    "重试": "Retry",
    "请求": "Requests",
    "活跃": "Active",
    "最近": "Recent",
    "项目统计暂时不可用": "Project stats temporarily unavailable",
    "请求消息": "User messages",
    "AI 回复": "AI replies",
    "每分钟请求数 (RPM)": "Requests per minute (RPM)",
    "每分钟 Token 数 (TPM)": "Tokens per minute (TPM)",
    "标记已读": "Mark as read",
    "暂无共同成员": "No shared members",
    "详情": "Details",
    "未查看的跟踪报告": "Unread trace reports",
    "下载 JSON": "Download JSON",
    "下载 CSV": "Download CSV",
    "暂无事件": "No events",
    "渲染失败，": "Render failed. ",
    "跟随默认 · 点击下方模型单独绑定": "Follow default · click a model below to bind individually",
    "没有其他 Key": "No other keys",
    "刷新密钥": "Refresh key",
    "\\n上次错误: ": "\\nLast error: ",
    "设为主": "Set primary",
    "📡 订阅": "📡 Subscription",
    "手动代理:": "Manual proxies:",
    "订阅地址:": "Subscription URL:",
    "永久删除": "Permanently delete",
    "本供应商下": "under this provider",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
