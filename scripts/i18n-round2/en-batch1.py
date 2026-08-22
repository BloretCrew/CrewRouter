#!/usr/bin/env python3
"""Batch 1: hand-written EN translations for missing keys (A–C sections)."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "用户名或邮箱": "Username or email",
    "密码（至少6位）": "Password (min 6 chars)",
    "6位验证码": "6-digit code",
    "统一 AI 模型接入平台": "Unified AI model access platform",
    "安全登录": "Secure login",
    "登录": "Sign in",
    "使用通行密钥登录": "Sign in with Passkey",
    "请输入验证码": "Enter verification code",
    "验证": "Verify",
    "使用飞书登录": "Sign in with Feishu",
    "登录即表示您同意我们的服务条款": "By signing in you agree to our Terms of Service",
    "服务条款": "Terms of Service",
    "隐私政策": "Privacy Policy",
    "帮助中心": "Help Center",
    "初始化设置 - CrewRouter": "Initial Setup - CrewRouter",
    "至少 6 位": "At least 6 characters",
    "首次使用，请创建管理员账号": "First time here — create an admin account",
    "正在检查系统状态…": "Checking system status…",
    "创建管理员账号": "Create admin account",
    "数据库已就绪。创建后即可登录管理面板，在后台配置供应商与模型。": "Database ready. Once created you can sign in to the admin panel to configure providers and models.",
    "用户名": "Username",
    "邮箱（可选）": "Email (optional)",
    "密码": "Password",
    "完成初始化": "Finish setup",
    "✅ 设置完成！": "✅ Setup complete!",
    "管理员账号已创建，请登录开始使用": "Admin account created — sign in to get started",
    "前往登录": "Go to sign in",
    "系统已初始化": "System already initialized",
    "无需重复配置，可直接登录": "No need to configure again — you can sign in directly",
    "设置密码 - CrewRouter": "Set Password - CrewRouter",
    "新密码（至少6位）": "New password (min 6 chars)",
    "设置登录密码": "Set login password",
    "你好，": "Hello, ",
    "您通过飞书登录注册，账号尚未设置密码。": "You signed up via Feishu and haven't set a password yet.",
    "请设置密码以便使用密码登录及安全相关功能。": "Set a password to enable password login and security features.",
    "设置密码并继续": "Set password and continue",
    "设置完成后可正常使用控制台": "The console will be available after setup",
    "绑定账号 - CrewRouter": "Link Account - CrewRouter",
    "请输入该账号的密码": "Enter the password for that account",
    "绑定已有账号": "Link existing account",
    "飞书账号": "Feishu account",
    "系统中已存在同名账号": "An account with the same name already exists",
    "，请输入密码验证后绑定": ". Enter the password to verify and link",
    "验证并绑定": "Verify and link",
    "绑定后将使用飞书账号快速登录": "After linking, you can sign in quickly with Feishu",
    "购买商品 - CrewRouter": "Purchase - CrewRouter",
    "返回控制台": "Back to console",
    "购买商品": "Purchase",
    "新对话": "New chat",
    "输入消息...": "Type a message...",
    "发送": "Send",
    "停止": "Stop",
    "你是一个有用的助手...": "You are a helpful assistant...",
    "查看历史记录": "View history",
    "对话历史": "Chat history",
    "暂无对话记录": "No conversations yet",
    "选择模型，开始对话。按 Enter 发送，Shift+Enter 换行。": "Pick a model and start chatting. Enter to send, Shift+Enter for a new line.",
    "清空对话": "Clear chat",
    "思考模式": "Thinking mode",
    "思考强度:": "Thinking effort:",
    "推理强度": "Reasoning effort",
    "低": "Low",
    "中": "Medium",
    "高": "High",
    "本次消耗": "This session",
    "历史记录": "History",
    "返回设置": "Back to settings",
    "暂无历史记录": "No history yet",
    "对话详情": "Chat details",
    "CrewRouter — 团队级 AI 模型统一网关": "CrewRouter — Unified AI model gateway for teams",
    "功能": "Features",
    "架构": "Architecture",
    "亮点": "Highlights",
    "文档": "Docs",
    "进入演示": "Try demo",
    "团队级 AI 模型网关": "Team-grade AI model gateway",
    "一个 API 端点，接入所有 AI 模型。智能路由、精细管控、实时洞察，为团队而生。": "One API endpoint for every AI model. Smart routing, fine-grained control, real-time insight — built for teams.",
    "进入演示控制台": "Open demo console",
    "查看文档": "View docs",
    "核心功能": "Core features",
    "为团队 AI 应用提供全方位的模型管理和路由能力": "Full-spectrum model management and routing for team AI apps",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
