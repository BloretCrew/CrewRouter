# Command Code GOAT 额度查询研究报告

> 结论：可以查。Command Code（commandcode.ai）的订阅额度统计在其服务端，官方提供网页用量页与 CLI `/usage`；程序化查询走官方 CLI（cmdc）使用的 `/alpha/*` 只读接口，用 API Key 做 Bearer 认证。CrewRouter 已按此接入，`quota_mode = commandcode`。

## 背景与套餐

Command Code 是 commandcode.ai 的 AI 编码订阅，官方 Provider API 为 `https://api.commandcode.ai/provider/v1`（OpenAI 兼容）。各套餐含 API 权限情况：

| 套餐 | 月度名义额度 | API 权限 |
|---|---|---|
| Go（$1） | $10 | ❌ 无（额度接口全部 404） |
| GOAT（$10） | $70 | ✅ |
| Provider | $15 | ✅ |
| Pro | $30 / $80（v1） | ✅ |
| Teams Pro | $40 | ✅ |
| Max | $150 | ✅ |
| Ultra | $300 | ✅ |

GOAT 有三个滚动额度窗口：5 小时（$14）、每周（$35）、月度（$70）。

## 查询途径

### 官方

- **Web 用量页**：<https://commandcode.ai/usage>，最准确，按请求 / token / 模型实时展示。
- **官方 CLI**：`cmdc` 会话里输入 `/usage`，显示 5 小时 / 每周进度条与重置倒计时。

### 程序化（/alpha/* 接口）

API Key 在 <https://commandcode.ai/settings/keys> 创建，与 `cmdc` 通用。四个只读 GET 端点（基址 `https://api.commandcode.ai`，注意在主机根路径上，不在 `/provider/v1` 下）：

| 端点 | 用途 |
|---|---|
| `/alpha/whoami` | 账号信息（团队账号可拿 orgId） |
| `/alpha/usage/summary` | 已用额度（`totalCredits`）、请求数（`totalCount`）、token 数 |
| `/alpha/billing/credits` | 剩余额度（`credits.monthlyCredits`）与窗口上限（`windowLimits.fiveHour` / `weekly`：`used` / `cap` / `exceeded` / `resetAt`） |
| `/alpha/billing/subscriptions` | 套餐（`data.planId`，如 `individual-goat`）、账期（`currentPeriodEnd`） |

请求头：`Authorization: Bearer <key>`、`x-command-code-version: <近期 CLI 版本>`、`x-cli-environment: production`。状态码语义：全部 401/403 → Key 失效；全部 404 → 套餐不含 API 权限；全部 5xx → 服务端异常。

数据要点（社区插件 `dsh-commandcode-quota` 的实测经验，本实现同样采纳）：

- 月度上限 = `totalCredits` + `monthlyCredits`，跨两个端点拼出；账期切换瞬间两者可能属于不同时刻，与名义额度偏差超过 ±25% 时百分比不可信（capSuspect），此时不渲染月度百分比。
- `resetAt` 为毫秒时间戳。

## CrewRouter 接入方式

- **服务端**：`server/utils/commandcode-usage.js` 并发调用三个端点（usage/credits/subscription，whoami 仅团队账号需要，未用），归一化为统一 quota 结构：`periods`（5 小时窗口 / 每周窗口 / 月度额度）+ `monthly` 明细 + `extra` 摘要；`planId` 映射套餐名与名义额度。Base URL 只取 origin，保留用户自选主机。
- **模式注册**：`server/utils/provider-quota.js` 增加 `commandcode` 分支（与 `grok_billing` 等并列，走 `quotaRequest` 支持代理）；`server/routes/admin.js` 白名单放行。
- **管理端**：供应商表单「额度查询方式」新增「Command Code GOAT（/alpha/* API）」，使用供应商主 API Key，无需导入 OAuth Token。
- **用户端**：模型库页「供应商额度」区块按既有 `periods` 渲染逻辑展示，无需改动。

验证：`node server/scripts/test-quota-usage.js`（纯函数断言，含 GOAT 典型响应、名义额度兜底、capSuspect、Go 套餐回退）+ 本地 mock 上游端到端（origin 提取、错误映射）。
