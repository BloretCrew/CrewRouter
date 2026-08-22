#!/usr/bin/env python3
"""Batch 5: EN translations — Feishu/proxy settings, user edit, provider form."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "飞书登录": "Feishu sign-in",
    "配置飞书企业应用 OAuth 后，用户可在登录页使用飞书一键登录。保存后立即生效，无需重启服务。": "After configuring Feishu enterprise OAuth, users can sign in with Feishu from the login page. Takes effect immediately, no restart needed.",
    "启用飞书登录": "Enable Feishu sign-in",
    "关闭后登录页不显示飞书入口": "When off, the Feishu entry is hidden from the login page",
    "当前已配置密钥，留空则保持不变": "A key is already configured; leave blank to keep it",
    "Tenant Key（可选）": "Tenant key (optional)",
    "填写后仅允许该企业租户下的飞书用户登录": "When set, only Feishu users under this tenant can sign in",
    "OAuth 回调地址": "OAuth callback URL",
    "请将此地址配置到飞书开放平台应用的重定向 URL 中": "Configure this URL as the redirect URL in your Feishu open-platform app",
    "保存飞书配置": "Save Feishu config",
    "代理设置": "Proxy settings",
    "配置系统级代理地址（HTTP / HTTPS / SOCKS4 / SOCKS5）。默认不对全部流量生效；可勾选下方选项让所有上游连接走代理，或仅在供应商中单独开启。": "Configure a system-level proxy (HTTP / HTTPS / SOCKS4 / SOCKS5). Not applied globally by default; tick the option below to route all upstream connections through it, or enable per provider.",
    "代理地址": "Proxy address",
    "示例：http://user:pass@host:port、https://host:port、socks5://host:1080、socks5h://host:1080。供应商勾选「使用系统代理」时使用此地址，无需开启下方全局选项。": "e.g. http://user:pass@host:port, https://host:port, socks5://host:1080, socks5h://host:1080. Used when a provider enables \"use system proxy\" — no need to enable the global option below.",
    "为所有连接使用代理": "Use proxy for all connections",
    "开启后，所有供应商的上游请求均走上方代理。关闭时，仅在供应商管理中单独启用代理的供应商会走代理（可填自定义地址或引用本页代理地址）。": "When on, all upstream requests go through the proxy above. When off, only providers with proxy enabled in provider management use it (custom address or the one from this page).",
    "保存代理设置": "Save proxy settings",
    "代理池设置": "Proxy pool settings",
    "全局代理池配置，供应商编辑中选择「代理池」模式并启用后自动生效。支持 IP 限速时自动切换代理。": "Global proxy pool; takes effect when a provider selects \"proxy pool\" mode. Supports automatic proxy switching on rate limits.",
    "服务状态": "Service status",
    "订阅地址（推荐，无数量上限）": "Subscription URL (recommended, unlimited entries)",
    "系统每 5 分钟自动从该地址拉取代理列表，无需手动导入": "The system pulls proxies from this URL every 5 minutes — no manual import needed",
    "手动代理列表": "Manual proxy list",
    "导入": "Import",
    "批量添加": "Bulk add",
    "保存代理池设置": "Save proxy pool settings",
    "编辑用户": "Edit user",
    "邮箱": "Email",
    "邮箱验证状态": "Email verification",
    "已验证": "Verified",
    "未验证": "Unverified",
    "管理员权限": "Admin privileges",
    "普通用户": "Regular user",
    "无用户组": "No group",
    "标签（逗号分隔）": "Tags (comma-separated)",
    "倍率设置": "Multiplier settings",
    "倍率控制模型请求的积分消耗速度。1 积分 = 1,000,000 加权 Token。": "Multipliers control how fast model requests consume credits. 1 credit = 1,000,000 weighted tokens.",
    "加权 Token = (输入Token + 缓存输入×0.1 + 输出Token) × 倍率": "Weighted tokens = (input + cached input × 0.1 + output) × multiplier",
    "倍率": "Multiplier",
    "模型越贵倍率越高。例如 GPT-4 设为 10，GPT-3.5 设为 1": "Pricier models get higher multipliers. e.g. GPT-4 = 10, GPT-3.5 = 1",
    "透传 reasoning_effort": "Pass through reasoning_effort",
    "关闭（默认）": "Off (default)",
    "开启": "On",
    "开启后，客户端请求中的 reasoning_effort（及 Responses API 的 reasoning.effort）会转发给上游；关闭则丢弃该字段": "When on, reasoning_effort (and Responses API reasoning.effort) in client requests is forwarded upstream; when off the field is dropped",
    "测试配置": "Test config",
    "针对当前所选供应商：测试该供应商下任意模型时使用此 User-Agent。留空则不发送自定义 UA。": "For the selected provider: the User-Agent used when testing any of its models. Blank = no custom UA.",
    "测试 User-Agent": "Test User-Agent",
    "清空": "Clear",
    "从 models.dev 查询": "Look up on models.dev",
    "同一供应商可重复添加。点击查询可按名称自动填充 Base URL 等信息。": "The same provider can be added multiple times. Look-up auto-fills the base URL and more by name.",
    "顺序模式": "Sequential mode",
    "权重模式": "Weighted mode",
    "+ 添加 Key": "+ Add key",
    "主 Key": "Primary key",
    "固定密钥 / 脚本刷新": "Static key / script refresh",
    "固定密钥（传统模式）": "Static key (classic)",
    "脚本刷新（动态密钥）": "Script refresh (dynamic key)",
    "📖 脚本开发文档（点击展开）": "📖 Script dev docs (click to expand)",
    "复制文档": "Copy docs",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
