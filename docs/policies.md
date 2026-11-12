# 团队版策略平台

团队版管理后台的「策略」页面提供面向成员的准入控制：按客户端、时间、用量、网络、模型、工具、提示词与会话特征限制访问，并支持暂停成员、命中记录与告警。

策略是**准入控制**，与 Team 额度规则（`teams.quota_rules`，滚动窗口免费额度）和 RPM/TPM 是不同机制，可叠加使用。

## 1. 核心概念

| 概念 | 说明 |
|---|---|
| 作用域 `scope_type` | `global` 全局、`team` 指定 Team、`member` 指定成员 |
| 效果 `effect` | `deny` 禁止；`allow` 仅用于白名单维度 |
| 动作 `action` | `block` 拦截、`warn` 告警放行、`shadow` 只记录、`notify` 只通知、`throttle` 延迟、`queue` 排队、`downgrade` 降级、`approval` 审批、`suspend` 暂停、`revoke_key` 吊销 Key、`custom` 自定义响应 |
| 优先级 `priority` | 0–1000，越大越优先 |
| 条件 `conditions` | JSON，字段之间 AND，同字段数组内 OR；支持 `all/any/not` 表达式树 |
| 有效期 | `starts_at` / `ends_at`，数据库 UTC 存储 |
| 灰度 | `rollout_percent` 0–100，按策略与成员哈希稳定分桶 |
| 阶梯 `ladder` | 按窗口内命中次数升级动作，例如先告警、再限速、最后拦截 |

默认放行。任意匹配的 `deny` 规则命中即拦截；`allow` 不能抵消 `deny`。白名单模式需要在「全局设置」中显式开启维度（`clients/models/providers/ips/protocols`），未匹配到 allow 规则的请求会被拦截。

## 2. 条件字段

| 字段 | 示例 | 说明 |
|---|---|---|
| `clients` | `["claude_code"]` | 已识别的客户端：`claude_code/codex/grok/opencode/qwen_code/hermes/openclaw/deepseek_harness/unknown` |
| `protocols` | `["anthropic"]` | `openai/anthropic/responses/gemini/interactions/models` |
| `endpoints` | `[{"methods":["POST"],"path":"/v1/messages"}]` | 路径支持 glob |
| `semantics` | `["subagent","compaction"]` | 主线程、子代理、压缩、审查、规划、标题、重试、心跳等 |
| `models` | `["claude-*","gpt-5*"]` | 请求模型、模型队列、harness 绑定与 Gemini URL 模型 |
| `providers` | `["anthropic-*"]` | 供应商 ID glob |
| `tools` | `{"names":["mcp__github__*"],"max_count":50,"forbid_any":false}` | 工具名 glob、MCP 服务器、工具数量 |
| `mcp_servers` | `["github"]` | 从 `mcp__<server>__<tool>` 解析 |
| `ips` | `["10.0.0.0/8","203.0.113.0/24"]` | IPv4/IPv6 CIDR |
| `tags` | `["intern"]` | 与 `users.tags` 有交集即匹配 |
| `identities` | `{"roles":["member"],"admin":false,"new_member_days":7}` | 角色、管理员、注册时长 |
| `api_keys` | `{"ids":[12],"names":["prod-*"],"older_than_days":90,"shared":true}` | Key 维度 |
| `oauth_clients` | `["crewrouter-cli"]` | OAuth 客户端 |
| `session` | `{"subagent":true,"compaction":false,"cwd_prefix":["/home/team/"]}` | 会话/项目 |
| `prompt` | `{"contains":["secret"],"regex":["AKIA[0-9A-Z]{16}"]}` | 提示词关键词/正则 |
| `media` | `{"max_images":0,"forbid_attachments":true}` | 图片/附件 |
| `limits` | `{"max_tokens":32000,"max_messages":200,"max_body_bytes":1048576}` | 请求体限制，超过即匹配 |
| `schedule` | 见下 | 周日程、日期例外、时区、日历 |
| `usage` | `{"metric":"requests","window":"24h","aggregate":"member","gte":100}` | 用量阈值 |
| `budget` | `{"metric":"cost","period":"month","aggregate":"team","gte":100}` | 成本/积分预算 |
| `concurrency` | `{"max":3,"aggregate":"member"}` | 并发上限 |

时间示例：

```json
{
  "schedule": {
    "timezone": "Asia/Shanghai",
    "weekly": { "mon": [["09:00", "18:00"]], "sat": [], "sun": [] },
    "dates": ["2026-11-20"],
    "exclude_dates": ["2026-11-15"]
  }
}
```

支持跨午夜窗口（如 `22:00-06:00`）与 IANA 时区；DST 由时区数据库处理。

## 3. 常用模板

- 禁止使用 Claude Code：`{"clients":["claude_code"]}`
- 仅允许受支持客户端：allow + `allowlist_dimensions=["clients"]`
- 工作时段禁止：周一至周五 09:00–18:00（Asia/Shanghai）
- 每日请求/成本上限：`usage` / `budget`
- 禁止子代理：`{"semantics":["subagent"],"session":{"subagent":true}}`
- 禁止图片/附件：`{"media":{"max_images":0,"forbid_attachments":true}}`
- 办公网 IP 白名单：allow + `ips` + `allowlist_dimensions=["ips"]`

模板可在页面「从模板创建」中一键使用，也可通过 API 创建。

## 4. 执行链路

```
/v1/*、/v1beta/* 请求
  → oauthBearer（OAuth / API Key）
  → validateApiKey（Key 生命周期、成员暂停、额度）
  → policyGate（策略评估与动作）
  → handler（模型队列、RPM/TPM、上游调用）
```

- 策略拦截优先于 RPM/TPM，但在额度检查之后。额度耗尽返回 `insufficient_quota`；策略用量返回 `policy_usage_limit`。
- 错误体按协议输出 OpenAI / Anthropic / Gemini 标准格式；策略错误包含 `code`、`policy_id`、`policy_name`、`request_id`。
- 成员暂停同时作用于网关与控制台：网关返回 403 `member_suspended`；控制台 API 返回 403，前端显示全屏遮罩。
- `scope='api'` 时只暂停网关，控制台仍可只读使用。

## 5. 管理 API

前缀 `/api/admin`，Team Edition + 管理员：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/policies/overview` | 概览统计 |
| GET | `/policies` | 列表与筛选 |
| GET/POST/PUT/DELETE | `/policies[/:id]` | CRUD |
| POST | `/policies/bulk` | 批量启停/删除/改优先级 |
| POST | `/policies/:id/duplicate` | 复制 |
| POST | `/policies/preview` | 单策略 dry-run |
| GET | `/policies/templates` | 内置模板 |
| POST | `/policies/from-template` | 模板创建 |
| GET | `/policies/effective?user_id=` | 成员生效策略与豁免 |
| GET | `/policies/health` | 健康检查 |
| GET | `/policy-hits` | 命中记录 |
| GET | `/policy-members` | 成员策略视图 |
| POST | `/policy-members/:userId/suspend` | 暂停成员 |
| POST | `/policy-members/:userId/resume` | 恢复成员 |
| POST | `/policy-members/:userId/bypass` | 策略豁免 |
| GET/PUT | `/policy-settings` | 全局/Team 设置 |
| POST | `/policy-settings/kill-switch` | 紧急停止 |
| GET | `/policy-clients` | 客户端请求/命中统计 |

## 6. 运维与注意事项

- **客户端识别可绕过**：自定义 system prompt 或 UA 可能让 Claude Code 被识别为 `unknown`。建议先使用 `shadow` 观察，或开启客户端白名单并禁止 `unknown`。这是检测能力，不是 DRM。
- **IP 可信度**：`ip` 来自 `x-forwarded-for` / `req.ip`，仅在可信代理部署下用于强策略。
- **缓存**：策略快照缓存 10 秒；写操作在当前进程立即失效，多进程最多 10 秒感知。成员暂停与 bypass 每次请求读取，立即生效。
- **并发与排队**：进程内计数；多实例为近似值。队列等待与最大长度可配。
- **审计**：策略变更、暂停/恢复、豁免写入 `operation_logs`；命中明细写 `policy_hits`，默认保留 90 天。
- **告警**：命中默认通知管理员与被拦截成员（站内 + Bark，5 分钟去重）。Webhook/邮件渠道在后续阶段扩展。
- **管理员保护**：默认禁止暂停管理员；需要时设置 `CR_ALLOW_SUSPEND_ADMIN=true`。
- **紧急停止**：全局 kill switch 会立即放行所有请求，恢复后策略重新生效。
- **时间展示**：数据库统一 UTC，前端按浏览器时区展示；时间悬停显示本地、UTC、Asia/Shanghai、America/New_York、Europe/London。
