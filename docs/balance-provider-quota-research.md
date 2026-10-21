# OpenRouter / Moonshot / SiliconFlow 余额查询研究报告

> 结论：三家平台均可使用 `Authorization: Bearer <API_KEY>` 直接查询余额。CrewRouter 分别接入 `quota_mode = openrouter`、`moonshot`、`siliconflow`。

## OpenRouter

| 端点 | Key 类型 | 返回 |
|---|---|---|
| `GET https://openrouter.ai/api/v1/credits` | Management Key | `data.total_credits`（累计购买）、`data.total_usage`（累计消耗） |
| `GET https://openrouter.ai/api/v1/key` | 普通推理 Key | `data.limit`、`data.limit_remaining`、`data.usage`、`usage_daily/weekly/monthly`、`limit_reset` |

- 账户剩余 ≈ `total_credits - total_usage`，这是估算值，不包含退款、活动赠金和过期调整。
- Management Key 在 `openrouter.ai/settings/management-keys` 创建，不能用于推理；普通 Key 调用 `/credits` 通常返回 401/403。
- `limit_remaining` 为 `null` 表示该 Key 没有额度上限；`limit` 也可能为 `null`。

CrewRouter 接入：

- 先请求 `/api/v1/credits`，成功时展示账户 Credits（`total` / `used` / `remaining`）。
- Credits 失败时回退 `/api/v1/key`，展示 Key 的额度上限、剩余和日/周/月用量；无上限时只展示累计用量并提示「Key 无额度上限」。
- Base URL 只取 origin（`https://openrouter.ai/api/v1` → `https://openrouter.ai`），`OPENROUTER_API_BASE` 可覆盖默认主机。

## Moonshot / Kimi

| 站点 | 端点 | 币种 |
|---|---|---|
| 国内 | `GET https://api.moonshot.cn/v1/users/me/balance` | CNY |
| 国际 | `GET https://api.moonshot.ai/v1/users/me/balance` | USD |

响应示例：

```json
{
  "code": 0,
  "data": { "available_balance": 49.58894, "voucher_balance": 46.58893, "cash_balance": 3.00001 },
  "scode": "0x0",
  "status": true
}
```

- `available_balance` = 可用总额（现金 + 赠金），`voucher_balance` = 赠金，`cash_balance` = 现金。
- `available_balance <= 0` 时推理接口会被拒绝；现金余额可能为负数。
- 国内站与国际站的 Key 不通用。

CrewRouter 接入：`server/utils/moonshot-usage.js` 调用固定路径 `/v1/users/me/balance`，根据 Base URL 主机判断 CNY / USD；`total` 与 `remaining` 都取 `available_balance`，`used` 留空，`extra` 展示赠金与现金。

## SiliconFlow（硅基流动）

| 站点 | 端点 | 币种 |
|---|---|---|
| 国内 | `GET https://api.siliconflow.cn/v1/user/info` | CNY |
| 国际 | `GET https://api.siliconflow.com/v1/user/info` | USD |

响应示例：

```json
{
  "code": 20000,
  "message": "OK",
  "status": true,
  "data": { "balance": "0.88", "chargeBalance": "88.00", "totalBalance": "88.88" }
}
```

- `totalBalance` = `chargeBalance`（充值）+ `balance`（赠送），三者均为字符串金额。
- 成功码为 `20000` 且 `status` 为 `true`；错误可能以 HTTP 200 + 非 20000 的 `code` 返回。
- 国内站与国际站的 Key 不通用。

CrewRouter 接入：`server/utils/siliconflow-usage.js` 调用 `/v1/user/info`，兼容 `data` 包装与顶层字段，`total` / `remaining` 取 `totalBalance`（缺失时用充值 + 赠送求和），`used` 留空，`extra` 展示赠金与充值。

## 共同行为

- 三者都是账户级余额，未加入逐 Key 额度汇总，避免同一账户多把 Key 重复相加；查询使用主 Key。
- 额度历史按 Key 归属记录（`keyModes` 包含三种模式），更换 Key 后开启新序列。
- 统一返回 `unit: balance`，币种写入 `currency`，额度历史与统计页面按币种分开展示。
- 后台供应商表单新增三个「额度查询方式」选项，无需脚本配置。

## 验证

- `npm run test:quota-usage` 覆盖字段归一化、币种判断、错误响应和空 Key。
- `server/scripts/test-balance-provider-usage.js` 使用本地 HTTP mock 验证请求路径、Bearer 认证、OpenRouter Credits → Key 回退、双失败错误聚合，以及三家平台的错误处理。
