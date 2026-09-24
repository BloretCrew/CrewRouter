# Cursor Pro 额度查询

> `cursor` 模式已接入 CrewRouter。个人 Pro / Pro+ / Ultra 通过 Cursor Agent 使用的 `api2.cursor.sh` DashboardService 查询。此接口未列入 Cursor 公开 API 文档，可能变更。Team / Enterprise 官方 Admin API 是另一套体系。

## 认证与额度端点

1. 在 Cursor Dashboard 创建 User API Key（`crsr_...`）。
2. `POST https://api2.cursor.sh/auth/exchange_user_api_key`，请求头 `Authorization: Bearer <crsr_...>`，body `{}`，返回短期 `accessToken`（通常约 1 小时）。
3. 使用 Bearer access token 调用 `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`，请求头含 `Connect-Protocol-Version: 1`，body `{}`。

`planUsage` 中 `totalSpend`、`includedSpend`、`remaining`、`limit` 单位为美分；周期时间为 Unix 毫秒。Cursor 返回的 Auto / 指定模型百分比分别映射成 CrewRouter `periods`。

部分账号不再返回 `planUsage`。此时实现会并行调用 `GetPlanInfo`、`GetAggregatedUsageEvents` 和 `GetHardLimit`：用各模型 `totalCents` 求本周期花费，用套餐包含额度（或按需上限）作为总额。响应说明会标记使用了回退数据。

## CrewRouter 配置

在供应商编辑页将“额度查询方式”设为“Cursor Pro（api2 DashboardService）”，API Key 填 `crsr_...`。Base URL 不参与 Cursor 查询。Key 可沿用供应商多 Key 配置，系统逐 Key 查询。accessToken 只缓存在服务进程内；临近过期时重新兑换，遇到 401 会清缓存并重试一次。

Team / Enterprise 管理员可以另用官方 `https://api.cursor.com` Admin API 查看团队支出；该 API 不接受个人 `crsr_...` Key，也不返回此处使用的个人 DashboardService 周期结构。
