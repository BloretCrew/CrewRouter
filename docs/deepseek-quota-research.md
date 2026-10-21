# DeepSeek 开放平台额度查询研究报告

> 结论：可以查。DeepSeek 开放平台提供官方余额接口，鉴权用聊天用的 API Key（`Authorization: Bearer <API_KEY>`）。CrewRouter 已接入，`quota_mode = deepseek`。

## 接口（官方文档：https://api-docs.deepseek.com/zh-cn/api/get-user-balance）

| 端点 | 返回 |
|---|---|
| `GET https://api.deepseek.com/user/balance` | `is_available` = 当前余额是否足够调用；`balance_infos[]` = 各币种余额 |

`balance_infos` 字段：

| 字段 | 含义 |
|---|---|
| `currency` | 货币类型（`CNY` / `USD`） |
| `total_balance` | 总可用余额 = 赠金 + 充值余额 |
| `granted_balance` | 未过期的赠送余额（优先扣减） |
| `topped_up_balance` | 用户自行充值的余额 |

响应示例：

```json
{
  "is_available": true,
  "balance_infos": [
    { "currency": "CNY", "total_balance": "110.00", "granted_balance": "10.00", "topped_up_balance": "100.00" }
  ]
}
```

限制：

- 只返回当前余额，不返回历史用量；详细用量需要登录平台 Usage 页面。
- 余额不足时调用模型接口返回 HTTP 402。
- API Key 在 `platform.deepseek.com` 创建，建议放在环境变量中，避免硬编码。

## CrewRouter 接入方式

- **服务端**：`server/utils/deepseek-usage.js` 请求 `/user/balance`，Base URL 只取 origin（`https://api.deepseek.com/v1` → `https://api.deepseek.com`），可用 `DEEPSEEK_API_BASE` 覆盖默认主机。
- **归一化**：结果为 `unit: balance` 标准结构，`currency` 取响应币种，`total` 与 `remaining` 都是当前总余额，`used` 留空（接口没有额度上限和已用量，不能用余额反推使用率）。`extra` 展示赠金、充值余额；`is_available=false` 时提示 HTTP 402；多币种时首条为主展示，其余金额写入 `extra`。
- **管理端**：供应商表单「额度查询方式」新增「DeepSeek 开放平台（/user/balance）」，使用供应商 API Key，无需额外配置。
- **额度历史**：余额按 Key 归属记录（`keyModes` 包含 `deepseek`），避免更换 API Key 后把不同账户的余额合并到同一序列。
- **多 Key**：余额是账户级数据，同一账户的多把 Key 会返回同一余额。该模式不使用逐 Key 汇总，避免把同一账户的余额重复相加；查询使用主 Key。
- **用户端**：模型库「供应商额度」读取定时查询或手动刷新保存的快照，与其它 `balance` 模式一致。

## 验证

`npm run test:quota-usage`（`server/scripts/test-quota-usage.js`）覆盖：

- 官方 CNY 示例的字段归一化（总额、赠金、充值、币种）。
- 余额不足提示与多币种展示。
- 缺少 `balance_infos` / `total_balance` 时的错误。
- Base URL 只取 origin，非法 URL 回退官方主机。
