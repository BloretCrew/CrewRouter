#!/usr/bin/env python3
"""Batch 6: EN translations — script refresh docs, quota query, proxy per provider."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "执行方式：": "Execution:",
    "脚本被包装为": "The script is wrapped as",
    "执行": "and executed",
    "上下文变量 ctx：": "Context variable ctx:",
    "供应商 Base URL（已去除尾部 /）": "Provider base URL (trailing slash removed)",
    "供应商 ID": "Provider ID",
    "当前缓存的密钥（首次刷新时为空）": "Currently cached key (empty on first refresh)",
    "全局 fetch 函数，可直接发 HTTP 请求": "Global fetch function for direct HTTP requests",
    "返回值：": "Return value:",
    "① 直接返回密钥字符串：": "① Return the key string directly:",
    "② 返回对象：": "② Return an object:",
    "expiresIn 单位为秒。支持别名：access_token、token、expires_in": "expiresIn is in seconds. Aliases supported: access_token, token, expires_in",
    "错误处理：": "Error handling:",
    "脚本抛出异常时，系统保留旧密钥并在 60 秒后重试。": "If the script throws, the old key is kept and the system retries after 60 seconds.",
    "💡 快速示例：": "💡 Quick examples:",
    "JWT 签名获取": "JWT signature",
    "账密登录获取 Token": "Password login for token",
    "自定义 HTTP 请求": "Custom HTTP request",
    "密钥刷新脚本": "Key refresh script",
    "刷新间隔（秒）": "Refresh interval (seconds)",
    "最少 60 秒。脚本返回": "Minimum 60s. If the script returns",
    "时会覆盖此值": "it overrides this value",
    "模型与额度": "Models & quota",
    "模型列表 URL、额度查询、备注": "Model list URL, quota query, notes",
    "模型列表 URL（可选）": "Model list URL (optional)",
    "覆盖默认的模型列表获取地址，留空则根据 Base URL 自动拼接": "Overrides the default model list endpoint; blank = derived from base URL",
    "额度查询": "Quota query",
    "启用（用户可查看此供应商额度）": "Enabled (users can see this provider's quota)",
    "启用后，有权限的用户可在模型库页面查看该供应商的剩余额度": "When on, permitted users can see this provider's remaining quota in the model library",
    "定时查询": "Scheduled query",
    "开启后按下方间隔自动查询并缓存额度。用户查看额度时优先使用缓存，无需每次打上游。": "Auto-queries and caches quota at the interval below. User views use the cache first instead of hitting upstream every time.",
    "查询间隔": "Query interval",
    "每 10 分钟": "Every 10 min",
    "每 30 分钟": "Every 30 min",
    "每 1 小时": "Every 1 h",
    "每 2 小时": "Every 2 h",
    "每 6 小时": "Every 6 h",
    "每 12 小时": "Every 12 h",
    "每 24 小时": "Every 24 h",
    "额度查询方式": "Quota query method",
    "通用脚本（按 Base URL 查询）": "Generic script (query by base URL)",
    "火山方舟按量推理（GetInferenceUsage）": "Volcengine pay-as-you-go (GetInferenceUsage)",
    "火山方舟 Agent Plan（GetAFPUsage）": "Volcengine Agent Plan (GetAFPUsage)",
    "Codex WHAM 使用导入的 OAuth Token 查询 ChatGPT Codex 的 5 小时与 7 天窗口，接口为非公开接口，字段可能变化": "Codex WHAM queries ChatGPT Codex 5-hour and 7-day windows with the imported OAuth token. Unofficial endpoint; fields may change.",
    "火山方舟 OpenAPI 签名配置": "Volcengine OpenAPI signature config",
    "使用火山引擎标准 HMAC-SHA256 签名，请按官方 API 文档填写具体 Action 参数。Secret Key 仅服务端保存。": "Uses standard Volcengine HMAC-SHA256 signing. Fill in the Action parameter per official API docs. Secret key is stored server-side only.",
    "导入并绑定到当前供应商": "Import and bind to this provider",
    "备注": "Notes",
    "代理": "Proxy",
    "单代理或代理池": "Single proxy or pool",
    "启用代理": "Enable proxy",
    "启用后，该供应商的 API 请求将通过下方所选方式走代理": "When on, this provider's API requests go through the method selected below",
    "代理方式": "Proxy mode",
    "代理（单个地址）": "Proxy (single address)",
    "代理池（系统全局代理池，可自动切换）": "Proxy pool (system-wide pool, auto-switching)",
    "使用系统设置中的代理地址": "Use the proxy from system settings",
    "引用「系统设置 → 代理设置」中的地址（只需配置地址，不必开启「为所有连接使用代理」）。不勾选时请填写下方自定义地址。": "Uses the address from System settings → Proxy settings (address only; no need to enable \"use proxy for all connections\"). Otherwise fill in a custom address below.",
    "自定义代理地址": "Custom proxy address",
    "支持 http / https / socks4 / socks5 / socks5h": "Supports http / https / socks4 / socks5 / socks5h",
    "将使用「系统设置 → 代理池设置」中的全局列表/订阅。限速（429）时会自动切换代理。": "Uses the global list/subscription from System settings → Proxy pool. Auto-switches proxies on rate limits (429).",
    "模型测试 UA": "Model test UA",
    "测试该供应商下任意模型时，将使用此 User-Agent 请求上游。留空则不发送自定义 UA。不影响正式业务转发。": "User-Agent used when testing any model of this provider against upstream. Blank = no custom UA. Does not affect production forwarding.",
    "请求头转发": "Header forwarding",
    "透传客户端请求头": "Pass through client headers",
    "UA / Accept / 其他": "UA / Accept / others",
    "透传": "Pass through",
    "不转发": "Don't forward",
    "Content-Type 选择「透传」则使用客户端原始 Content-Type，否则始终为 application/json。": "\"Pass through\" keeps the client's original Content-Type; otherwise application/json is always used.",
    "UA/Accept 选择「透传」则转发通用请求头（Authorization、Cookie 等敏感头始终不转发）。": "\"Pass through\" forwards common headers (Authorization, Cookie and other sensitive headers are never forwarded).",
    "用于分类与筛选": "Used for categorization and filtering",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
