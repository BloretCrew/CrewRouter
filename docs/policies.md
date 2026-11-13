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
| `prompt` | `{"contains":["secret"],"regex":["AKIA[0-9A-Z]{16}"]}` | 请求提示词关键词/正则 |
| `output` | `{"contains":["secret"],"regex":["..." ]}` | 响应内容关键词/正则（事后扫描，action=warn） |
| `login` | `{"methods":["password+2fa"],"require_mfa":true,"max_failed_attempts":5}` | 登录方式、MFA、失败次数 |
| `countries` / `countries_deny` | `{"countries":["CN"]}` | 依赖反向代理注入 `cf-ipcountry` / `x-geo-country` / `x-country-code` |
| `asn` | `{"asn":["4134"]}` | 依赖 `cf-asn` / `x-asn` 请求头 |
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
| POST | `/policies/:id/publish`、`/unpublish`、`/archive` | 发布/转草稿/归档；可配置发布审批 |
| POST | `/policies/:id/rollback/:version` | 回滚到指定版本 |
| GET | `/policies/:id/versions`、`/policies/:id/diff` | 版本历史与差异 |
| GET | `/policies/conflicts` | 同作用域 deny/allow 冲突检测 |
| POST | `/policies/simulate` | 按策略 ID 或草稿回放样本/最近用量 |
| GET | `/policies/analytics`、`/policies/metrics` | 分析报表与 Prometheus 指标 |
| GET | `/policy-hits/stream` | SSE 实时命中流 |
| GET/POST/DELETE | `/policy-exemptions`、`/policy-exemptions/from-hit/:hitId` | 临时豁免 |
| GET | `/policy-appeals`、`POST /policy-appeals/:id/decide` | 申诉处理 |
| GET | `/policy-approvals`、`POST /policy-approvals/:id/decide` | 审批中心 |
| GET/POST/PUT/DELETE | `/policy-channels`、`POST /policy-channels/:id/test` | 通知渠道 |
| GET/POST/PUT/DELETE | `/policy-alert-rules` | 告警规则 |
| POST | `/policy-members/:userId/role` | 设置 Team 角色（owner/admin/member/viewer） |
| POST | `/policy-members/:userId/offboard` | 离岗停用（永久暂停 + 禁用全部 Key + 吊销 OAuth token） |
| GET | `/policy-login-events` | 登录事件（成功/失败、方式、MFA、IP） |
| GET | `/policy-teams`、`/policy-users` | 策略范围选择（按管理 Team 隔离） |
| GET | `/policies/export`、`POST /policies/import`、`/policies/schema` | 导出/导入（支持 dry-run）与 IaC schema |
| POST | `/policies/output-scan` | 手动扫描最近响应内容 |
| GET/POST | `/policies/metrics`、`/policies/analytics` | 指标与分析 |

用户端 `/api/user`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/policies/mine` | 我的生效策略、豁免、暂停状态 |
| GET | `/policies/blocks` | 我的最近拦截 |
| GET/POST | `/policy-appeals` | 我的申诉与提交申诉 |
| GET | `/policy-approvals/:id` | 运行时审批状态 |
| GET | `/suspension` | 暂停详情 |

## 6. 生命周期、审批与例外

- 状态：`draft` / `published` / `archived`；`auto_publish_at` 到达后由调度器自动发布；`ends_at` 到期自动归档。
- 每次创建/更新/发布/回滚都会写入 `policy_versions`，支持查看、diff 与回滚。
- `policy_settings.require_approval_for_publish/delete` 开启后，发布/删除进入审批中心；另一个管理员通过后才应用。
- 运行时动作 `approval` 会生成 `policy_approvals(kind='request')`；管理员通过后自动创建一次性豁免（1 小时、1 次），成员重试即可放行。
- 临时豁免支持成员/Team/API Key、指定策略或全部策略、到期时间、最大使用次数；引擎每次实际使用时累加 `used_count`。
- 成员可在控制台「安全与策略」页面查看生效策略与最近拦截，并提交申诉；申诉通过后自动生成 24 小时豁免。
- 成员暂停与策略豁免分开管理：暂停立即阻断网关/控制台；豁免只跳过策略匹配。

## 7. 通知渠道与告警

- 支持站内、Bark、邮件、通用 Webhook、飞书、企业微信、钉钉、Slack、Telegram。
- Secret/Token/Key 使用 `secret-crypto` 加密存储，读取时掩码；URL 发送前经过 `validateUrl` SSRF 校验。
- 告警规则按事件（hit/block/suspend/approval/appeal/*）、严重级别、渠道、静默窗口匹配；同一规则+渠道在静默窗口内不重复发送。
- 命中仍会通过站内通知与 Bark 提醒管理员/成员（5 分钟去重），渠道告警独立分发。
- `/api/admin/policy-hits/stream` 提供 SSE 实时事件流，供管理页面或外部监控消费。

## 8. 分析与指标

- `/api/admin/policies/analytics` 支持按策略/成员/Team/客户端/模型/动作聚合、时间序列与 TopN。
- `policy_metrics_daily` 由调度器每 5 分钟聚合最近两天，供长期报表使用。
- `/api/admin/policies/metrics` 输出 Prometheus 文本指标：24h 命中/拦截、1h 命中、启用策略数、并发与队列长度。
- 策略命中保留天数由 `policy_settings.hit_retention_days` 控制，调度器每 6 小时分批清理。

## 9. 时间展示

- 数据库统一 `TIMESTAMPTZ` / UTC，API 输出 ISO 8601。
- 前端 `public/js/time-format.js` 暴露 `window.CRTime`：按浏览器时区格式化，时间悬停显示本地、UTC、Asia/Shanghai、America/New_York、Europe/London。
- 迁移工具：
  - `node server/scripts/check-timezone-hardcode.js`：扫描剩余时间展示硬编码。
  - `node server/scripts/migrate-time-format.js --write`：把常见 `new Date(x).toLocaleString('zh-CN', ...)` 替换为 `CRTime`。
- 业务自然日分桶（图表横轴）仍按业务时区聚合，页面需标注或通过 tooltip 说明。

## 9. Team 角色与数据范围

- `user_teams.role` 支持 `owner/admin/member/viewer`；策略管理需要 `owner/admin` 或全局管理员。
- 全局管理员可管理所有 Team 与全局策略；Team owner/admin 只能管理本 Team 策略、成员、命中、豁免、申诉与审批。
- 全局策略对 Team 管理员只读；通知渠道、告警规则、全局设置、kill switch、Prometheus 指标仅全局管理员可操作。
- 非全局管理员访问 `/admin` 时会进入“策略专用”视图，只显示「策略」入口。

## 10. 登录策略

- 密码、2FA 与 Passkey 登录在建立会话前调用 `evaluateLoginPolicy`。
- 支持条件：允许的登录方式、是否要求 MFA、窗口内失败次数、IP、时段、身份/标签。
- 登录成功/失败写入 `login_events`（方式、IP、UA、MFA、原因），可在策略页「成员策略 → 登录事件」查看。
- 登录策略的登录条件采用“合规要求”语义：方法/MFA/失败次数都满足时不构成拒绝。

## 11. 输出内容策略

- `conditions.output` 对已写入 `usage_records.response` 的响应做事后扫描。
- 调度器每分钟扫描最近记录；也可调用 `POST /api/admin/policies/output-scan` 手动触发。
- 命中记录 `action=warn`、`decision=allow`、`reason=output_match`，不会改变已发送的响应；适用于敏感信息/密钥泄露告警。
- 流式响应无法回溯改写，输出策略定位为审计与告警。

## 12. 导入导出与 IaC

- `GET /api/admin/policies/export` 导出当前管理员可见策略的配置 JSON（不含 ID/审计字段）。
- `POST /api/admin/policies/import` 支持 `dry_run`；单次最多 200 条，同作用域同名策略会跳过。
- `GET /api/admin/policies/schema` 返回版本化的字段/枚举/条件键定义，可用于 GitOps 或 CLI。
- 策略页「导出 / 导入 / 输出扫描」按钮提供同样能力。

## 13. SIEM 与离岗

- 通知渠道新增 `syslog`（UDP/TCP）与 `otlp`（OTLP/HTTP JSON），可接入企业 SIEM/可观测平台。
- `POST /api/admin/policy-members/:userId/offboard` 一键离岗：永久暂停、禁用全部 API Key、吊销 OAuth token、写审计与通知。
- 可通过外部 HR/SCIM 系统在成员离职时调用该端点完成自动吊销。

## 14. 运维与注意事项

- **客户端识别可绕过**：自定义 system prompt 或 UA 可能让 Claude Code 被识别为 `unknown`。建议先使用 `shadow` 观察，或开启客户端白名单并禁止 `unknown`。这是检测能力，不是 DRM。
- **IP 可信度**：`ip` 来自 `x-forwarded-for` / `req.ip`，仅在可信代理部署下用于强策略。
- **缓存**：策略快照缓存 10 秒；写操作在当前进程立即失效，多进程最多 10 秒感知。成员暂停与 bypass 每次请求读取，立即生效。
- **并发与排队**：进程内计数；多实例为近似值。队列等待与最大长度可配。
- **审计**：策略变更、暂停/恢复、豁免写入 `operation_logs`；命中明细写 `policy_hits`，默认保留 90 天。
- **告警**：命中默认通知管理员与被拦截成员（站内 + Bark，5 分钟去重）。Webhook/邮件渠道在后续阶段扩展。
- **管理员保护**：默认禁止暂停管理员；需要时设置 `CR_ALLOW_SUSPEND_ADMIN=true`。
- **紧急停止**：全局 kill switch 会立即放行所有请求，恢复后策略重新生效。
- **时间展示**：数据库统一 UTC，前端按浏览器时区展示；时间悬停显示本地、UTC、Asia/Shanghai、America/New_York、Europe/London。
