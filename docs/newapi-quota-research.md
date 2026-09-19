# new-api / one-api 额度查询研究报告

> 结论：可以查。new-api（QuantumNous/new-api，one-api 同源分支）自带 OpenAI 旧版兼容额度接口，鉴权用聊天用的令牌 Key（`TokenAuth`）。CrewRouter 已按此接入，`quota_mode = newapi`。one-api / VoAPI 等 one-api 系站点约定相同。

## 接口（源码依据：new-api `router/dashboard.go` + `controller/billing.go`、`controller/channel-billing.go`）

| 端点 | 返回 |
|---|---|
| `GET {站点}/dashboard/billing/subscription`（`/v1/dashboard/...` 同义） | `hard_limit_usd` / `soft_limit_usd` / `system_hard_limit_usd` = **总额度**（剩余 + 已用，按站点展示单位换算），`access_until` = 令牌过期时间（秒） |
| `GET {站点}/dashboard/billing/usage` | `total_usage` = **已用额度**，单位为美分（金额 × 100） |

请求头：`Authorization: Bearer <令牌>`。错误语义特殊：不返回 4xx/5xx，而是 **HTTP 200 + `{"error":{"message":...}}`**。

行为细节：

- 站点开启「令牌额度统计」（`DisplayTokenStatEnabled`）时按单把令牌统计，否则按用户全量。
- 令牌为无限额度时 `hard_limit_usd` 返回 100000000。
- 金额单位受站点「额度展示类型」影响（USD / CNY / Tokens），站点服务端已完成换算。

## 计算口径

- 总额度 = `hard_limit_usd`；已用 = `total_usage / 100`；剩余 = 总额度 − 已用。
- 两个端点必须合并才能得到已用/剩余（CrewRouter 旧版「通用脚本」默认脚本只请求 subscription 单端点，已用恒为 0，这也是本模式的动机）。

## CrewRouter 接入方式

- **服务端**：`server/utils/newapi-usage.js` 并发请求 subscription + usage 两端点合并计算；Base URL 只取根（`https://gw.example.com/openai/v1` → `https://gw.example.com`），路径先试 `/dashboard/...` 再回退 `/v1/dashboard/...`；usage 端点失败（部分站点未开放）降级为已用 0 并在 extra 提示；识别 200+error 风格错误。`server/utils/provider-quota.js` 注册 `newapi` 模式；`server/routes/admin.js` 白名单放行。
- **管理端**：供应商表单「额度查询方式」新增「new-api / one-api 站点（/dashboard/billing）」，使用供应商令牌 Key，无需额外配置。
- **用户端**：结果为 `unit: balance` 标准结构（total/used/remaining），模型库「供应商额度」区块直接展示。

## 验证

`node server/scripts/test-quota-usage.js`（归一化、错误提取、无限额度与 usage 缺失回退）+ 本地 mock 端到端三场景（双端点合并、`/v1/dashboard` 路径回退 + usage 404 降级、200+error 错误抛出）。
