#!/usr/bin/env python3
"""Batch 8: EN translations — playground, dialog, theme, misc errors."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "供应商的 API Key、地址等敏感信息完全隔离在网关层，本地编程工具（如 Claude Code）和团队成员均无法获取。团队成员仅有模型使用权，没有密钥所有权——可以按规定畅快使用，但无法导出或查看密钥。管理员随时可以撤销使用权，一切掌控在您手中。": "Provider API keys and addresses are fully isolated at the gateway. Local coding tools (like Claude Code) and team members can never see them — members get usage rights only and can neither export nor view keys. Admins can revoke access anytime; you stay in control.",
    "提示": "Notice",
    "知道了": "Got it",
    "[dom] html`...` 中插入了 DOM Node，已忽略。请改用 el()/append": "[dom] A DOM Node was interpolated into html`...` and ignored. Use el()/append instead",
    "处理中...": "Processing...",
    "当前：浅色 · 点击切换深色": "Current: light · click for dark",
    "当前：深色 · 点击跟随系统": "Current: dark · click to follow system",
    "当前：跟随系统 · 点击切换浅色": "Current: system · click for light",
    "加载模型失败:": "Failed to load models:",
    "不支持": "Not supported",
    "加载对话...": "Loading chat...",
    "加载对话历史失败:": "Failed to load chat history:",
    "加载对话历史异常:": "Exception loading chat history:",
    "重命名": "Rename",
    "创建对话失败:": "Failed to create chat:",
    "创建对话异常:": "Exception creating chat:",
    "保存消息失败:": "Failed to save message:",
    "保存消息异常:": "Exception saving message:",
    "确定删除这个对话？": "Delete this chat?",
    "你: ": "You: ",
    "助手: ": "Assistant: ",
    "请先选择模型": "Pick a model first",
    "你": "You",
    "助手": "Assistant",
    "已完成": "Done",
    "请先发送消息创建对话后再 Fork": "Send a message to start a chat before forking",
    "已复制富文本": "Rich text copied",
    "已复制 Markdown": "Markdown copied",
    "已复制纯文本": "Plain text copied",
    "已复制": "Copied",
    "加载历史失败:": "Failed to load history:",
    "加载详情失败:": "Failed to load details:",
    "👤 用户": "👤 User",
    "🤖 助手": "🤖 Assistant",
    "[Update] 启动时检查更新失败:": "[Update] Startup update check failed:",
    "加载用户信息失败:": "Failed to load user info:",
    "fusion 是固定模型，无需添加": "fusion is built-in and doesn't need to be added",
    "该模型 ID 已存在": "This model ID already exists",
    "加载用户...": "Loading users...",
    "加载用户列表失败:": "Failed to load user list:",
    "加载用户列表失败": "Failed to load user list",
    "用户不存在，请刷新后重试": "User not found — refresh and try again",
    "加载用户组列表失败:": "Failed to load group list:",
    "请输入有效的退款金额": "Enter a valid refund amount",
    "退款失败": "Refund failed",
    "退款失败:": "Refund failed:",
    "保存用户失败:": "Failed to save user:",
    "未知供应商": "Unknown provider",
    "未命名模型": "Unnamed model",
    "加载模型...": "Loading models...",
    "加载模型列表失败:": "Failed to load model list:",
    "测试": "Test",
    "[uptime] 批量加载失败": "[uptime] Bulk load failed",
    "共 0 个模型": "0 models in total",
    "[模型管理] 加载供应商模型失败:": "[Model mgmt] Failed to load provider models:",
    "模型不存在，请先展开所属供应商后再试": "Model not found — expand its provider first and retry",
    "已删除选中模型": "Selected models deleted",
    "批量删除失败": "Bulk delete failed",
    "批量删除模型失败:": "Bulk model delete failed:",
    "加载模型选项失败:": "Failed to load model options:",
    "加载供应商选项失败:": "Failed to load provider options:",
    "请填写上游模型ID和提供商": "Enter the upstream model ID and provider",
    "保存模型失败:": "Failed to save model:",
    "确定要删除此模型吗？": "Delete this model?",
    "删除模型失败:": "Failed to delete model:",
    "加载供应商...": "Loading providers...",
    "加载供应商列表失败:": "Failed to load provider list:",
    "筛选全局供应商": "Filter global providers",
    "筛选用户供应商": "Filter user providers",
    "筛选已启用": "Filter enabled",
    "筛选脚本模式": "Filter script mode",
    "当前页没有启用额度查询的供应商": "No providers on this page have quota query enabled",
    "同步模型": "Sync models",
    "创建者": "Creator",
    " · 权重": " · weight",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
