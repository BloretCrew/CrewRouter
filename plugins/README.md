# CrewRouter 插件能力参考

本文档描述插件系统（`server/plugins/`）开放的权限与 `ctx` 能力。权限在 `plugin.json` 的 `permissions` 数组声明，由 `server/plugins/host.js` 按权限门控挂载到 `ctx`。

## 权限总表

| 权限 | ctx 能力 | 说明 |
|---|---|---|
| `storage` | `ctx.storage` | 插件私有 KV（`plugin_data` 表） |
| `network` | `ctx.fetch` | 受限网络（SSRF 校验 + 10s 超时） |
| `gateway:modify` | `ctx.on` 网关钩子 | 改请求/改写响应 chunk/加响应头 |
| `billing:modify` | `ctx.on` 计费钩子 | 改积分/加权 |
| `apikey:*` | API Key 钩子 | 改 Key 校验/创建 |
| `provider:register` | `ctx.registerProviderFormat/registerTransform` | 注册上游格式/协议转换 |
| `stats:record` | `ctx.on` 统计钩子 | 加 plugin_meta 维度 |
| `pages:register` | manifest.pages | 前端页面 |
| `routes:register` | `ctx.expose` | 插件自有 HTTP API |
| `cron:register` | `ctx.cronHandler`/`ctx.scheduleCron` | 定时任务 |
| `themes:register` | manifest.themes | 主题 |
| **`usage:read`** | `ctx.usage` | 用量/成本聚合（不含正文） |
| **`models:read`** | `ctx.models` | 模型目录 + 健康度（只读） |
| **`preferences:read`** | `ctx.preferences` | 用户偏好（授权门控） |
| **`audit:write`** | `ctx.audit` | 插件自有审计日志（只读自己的） |
| **`export:usage`** | `ctx.exportUsage` | 用量安全子集导出 |
| **`meta:read`** | `ctx.pluginMeta` | 插件注册信息（只读） |
| **`webhook:register`** | `ctx.registerWebhook`/`ctx.webhook` | 出站 Webhook（域白名单） |
| **`admin:view`** | `ctx.adminView` | 管理面板只读视图 |

## 安全约束（所有能力）

- **绝不暴露**裸 `fs` / `child_process` / `net` / 裸数据库连接。
- 所有数据访问走字段白名单：`usage:read` / `export:usage` 返回聚合（request_count/tokens_used/cached_tokens/weighted_tokens/cost/group_key），**不含** `messages`/`response`/`request_params`/provider 凭证/API Key 明文。
- `preferences:read` 受用户授权门控：用户未在设置页开启「允许插件读取我的偏好」时，`ctx.preferences.get()` 返回 `{ granted: false, reason: 'not_opted_in' }`。
- 未知权限在加载时仅 warning，不阻断（向后兼容旧插件）。

## Webhook（webhook:register）

### plugin.json 声明

```json
{
  "permissions": ["webhook:register"],
  "allowedHosts": ["hooks.example.com"]
}
```

- `allowedHosts`：出站 webhook 目标域白名单（必须 HTTPS，逐个校验域名）。
- 不在白名单内的域、内网 IP、非 HTTPS，注册时被拒绝（SSRF 校验）。

### 用法

```js
// 注册
await ctx.registerWebhook({ url: 'https://hooks.example.com/xx', events: ['order.created'], secret: 's3cret' });

// 触发（在钩子/cron 里）
await ctx.webhook.emit('order.created', { id: 123 });
```

- 触发时 POST JSON `{ event, payload, ts }`，`secret` 走 `X-Webhook-Secret` 头。
- 投递超时 10s，失败记日志不阻断主流程。
- 存储表 `plugin_webhooks`（懒建，幂等）。

## 示例插件

- `plugins/usage-stats/` — 演示 `usage:read` / `models:read` / `meta:read`
- `plugins/webhook-demo/` — 演示 `webhook:register`（白名单校验 + 定时 emit）

## 数据读取（plugin-data-read.js）

`server/utils/plugin-data-read.js` 是唯一的插件只读数据构建器：
- `usageSummary({ userId?, apiKeyId?, days?, groupBy? })` — 用量/成本聚合
- `modelList()` — 模型目录 + 健康列（若存在）
- `pluginMetaView(registry, pluginId)` — 插件注册信息
- `getPreferences(req)` — 用户偏好（授权门控）
