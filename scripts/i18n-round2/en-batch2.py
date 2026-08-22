#!/usr/bin/env python3
"""Batch 2: EN translations — showcase & admin page sections."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "为团队 AI 应用提供全方位的模型管理和路由能力": "Full-spectrum model management and routing for team AI apps",
    "多供应商聚合": "Multi-provider aggregation",
    "OpenAI、Anthropic、DeepSeek 等主流供应商，一个 API 端点全部接入。": "OpenAI, Anthropic, DeepSeek and more — all through a single API endpoint.",
    "协议自动转换": "Automatic protocol conversion",
    "系统自动在 OpenAI 与 Anthropic 协议间双向转换。用 OpenAI SDK 调用 Claude，或用 Anthropic SDK 调用 GPT，无需关心协议差异。": "The system converts between OpenAI and Anthropic protocols automatically. Call Claude with the OpenAI SDK or GPT with the Anthropic SDK — protocol differences handled for you.",
    "智能路由": "Smart routing",
    "按团队分配模型，支持别名、上游映射和自定义路由规则，精准控制每个团队的模型访问范围。": "Assign models per team with aliases, upstream mapping and custom routing rules for precise access control.",
    "Fusion 模式": "Fusion mode",
    "同一请求并发多个模型，由裁判模型评估并综合最优回答，大幅提升输出质量和可靠性。": "Fan one request out to several models concurrently; a judge model scores and blends the best answer for higher quality and reliability.",
    "实时统计": "Real-time analytics",
    "请求量、Token 用量、延迟、成本多维度分析。按模型、Key、时间粒度下钻，缓存命中率一目了然。": "Multi-dimensional analysis of requests, tokens, latency and cost. Drill down by model, key and time; cache hit rate at a glance.",
    "时间调度启停、模型绑定、自定义签名、Fusion 配置。每个 Key 独立权限，精细化管控。": "Timed enable/disable, model binding, custom signatures and Fusion config. Per-key permissions for fine-grained control.",
    "多因素认证": "Multi-factor auth",
    "支持 TOTP 双因素认证、WebAuthn PassKey 无密码登录、飞书 OAuth 企业级接入，全方位保障账户安全。": "TOTP 2FA, WebAuthn Passkey passwordless login and Feishu OAuth enterprise SSO keep accounts secure end to end.",
    "动态密钥刷新": "Dynamic key rotation",
    "供应商 API Key 支持脚本模式自动轮换，定时刷新密钥并缓存，保障高可用不间断服务。": "Provider API keys support script-based auto rotation — refresh on schedule and cache for uninterrupted service.",
    "代理池管理": "Proxy pool management",
    "每个供应商独立配置代理池，支持订阅链接批量导入和手动添加，保障跨境访问稳定性。": "Per-provider proxy pools with bulk subscription import and manual entries for reliable cross-region access.",
    "一个端点，所有模型": "One endpoint, every model",
    "完美兼容 OpenAI 和 Anthropic SDK，零改动迁移现有应用": "Fully compatible with OpenAI and Anthropic SDKs — migrate existing apps with zero changes",
    "# 只需更换 base_url，即可接入所有模型": "# Just swap the base_url to access every model",
    "你的应用": "Your app",
    "更多…": "More…",
    "兼容所有支持 OpenAI / Anthropic 格式的编程工具": "Works with every coding tool that speaks OpenAI / Anthropic",
    "技术亮点": "Technical highlights",
    "为生产环境设计的每一个细节": "Every detail engineered for production",
    "双格式兼容 API": "Dual-format compatible API",
    "完美兼容 OpenAI Chat Completions 和 Messages 格式。只需更换": "Fully compatible with OpenAI Chat Completions and Messages formats. Just switch the",
    "，无需修改任何代码。同时支持 Anthropic 原生格式，满足不同场景。": " — no code changes needed. Native Anthropic format supported too.",
    "团队": "Teams",
    "状态": "Status",
    "工程团队": "Engineering team",
    "产品团队": "Product team",
    "前沿团队": "Frontier team",
    "默认团队": "Default team",
    "受限": "Restricted",
    "团队与权限": "Teams & permissions",
    "团队级别的模型访问控制，支持个人、默认和前沿团队分层管理。管理员精确控制每个团队可用的模型范围，配合用户组限额规则实现精细化资源管控。": "Team-level model access control with personal, default and frontier tiers. Admins precisely scope each team's models, paired with user-group quota rules.",
    "统计概览": "Usage overview",
    "本月请求": "Requests this month",
    "本月成本": "Cost this month",
    "灵活计费": "Flexible billing",
    "按 Token 计费，支持模型倍率和完成倍率自定义。兑换码系统、余额告警、可退款余额，满足团队内部结算和对外运营需求。": "Token-based billing with custom model and completion multipliers. Redemption codes, balance alerts and refundable balances cover both internal chargebacks and external operations.",
    "密钥隔离": "Key isolation",
    "你的团队成员": "Your team members",
    "仅获使用权": "Usage rights only",
    "CrewRouter 网关": "CrewRouter gateway",
    "密钥在此隔离": "Keys isolated here",
    "供应商 API Key": "Provider API keys",
    "不可见": "Invisible",
    "密钥隔离与安全": "Key isolation & security",
    "立即体验 CrewRouter": "Try CrewRouter now",
    "无需注册，直接进入演示控制台感受完整功能": "No sign-up needed — jump straight into the demo console",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
