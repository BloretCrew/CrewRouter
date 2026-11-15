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
// 注册：allowedHosts 必须在 plugin.json 的域名白名单中
await ctx.registerWebhook({ url: 'https://hooks.example.com/xx', events: ['order.created'], secret: '从插件配置读取的共享密钥' });

// 触发（在钩子/cron 里）；逐个订阅顺序投递，失败最多重试 3 次
const result = await ctx.webhook.emit('order.created', { id: 123 });
// { matched, delivered, failed, results: [{ webhookId, status, attempts, responseStatus, error }] }

// 最近投递记录仅限本插件，limit 取 1–100，status 可选 delivered / failed
const recentFailures = await ctx.webhook.deliveries({ status: 'failed', limit: 20 });
```

- 触发时 POST JSON `{ event, payload, ts }`，注册的 `secret` 只经 `X-Webhook-Secret` 请求头发送，不进入投递历史。
- 每个目标超时 10 秒；网络错误、非 2xx 响应和 SSRF 复验失败最多尝试 3 次（间隔 250ms、1s）。失败记录日志并继续其他目标，不阻断主流程。
- `matched` 是匹配订阅数；`delivered` 是最终成功数；`failed` 是耗尽重试仍失败数。`responseStatus`/`error` 给出最终结果。
- 历史存于 `plugin_webhook_deliveries`，保存插件 ID、订阅 ID、事件、状态、尝试数、HTTP 状态、错误及时间，不含 URL、payload 或 secret。查询始终按当前插件 ID 限定。
- `deliveries({ limit, status })` 返回最新记录；目前不提供自动清理，运维可按部署的数据保留策略清理旧记录。

### 能力权限与安全说明

- 在 `plugin.json` 的 `permissions` 声明 `webhook:register` 后才会挂载 `ctx.registerWebhook` 与 `ctx.webhook`；未声明时二者不可用。
- `allowedHosts` 白名单按完整主机名精确匹配；每次注册和实际投递前都会执行 SSRF 检查，拒绝非 HTTPS 与内网目标。
- 后端 `main.js` 在 CrewRouter 主进程运行。Node VM 不是安全边界；后端插件代码默认关闭，只有管理员审查源码后显式设置 `CR_TRUST_IN_PROCESS_PLUGINS=1` 才会运行。权限清单用于 API 收口，不应当作不可信代码沙箱。

## 插件声明式配置

插件可选在 `plugin.json` 提供 `configSchema`，管理页会生成字段表单，并在保存时由服务端再次校验。未声明 schema 的旧插件仍使用原有 JSON 编辑方式。

```json
{
  "configSchema": {
    "endpoint": {
      "type": "string",
      "label": "服务地址",
      "description": "插件调用的 HTTPS 服务地址。",
      "required": true,
      "min": 8,
      "max": 200
    },
    "retryCount": {
      "type": "integer",
      "label": "重试次数",
      "default": 2,
      "min": 0,
      "max": 5
    },
    "mode": {
      "type": "string",
      "label": "运行模式",
      "options": ["safe", "fast"],
      "default": "safe"
    },
    "enabled": { "type": "boolean", "label": "启用功能", "default": true }
  }
}
```

- 支持 `string`、`number`、`integer`、`boolean`；`label`/`description` 为可选展示文本。
- `required`、`default`、`options`、`min`、`max` 可选。字符串的 min/max 表示长度，数字字段表示数值范围；`options` 限定字符串或数字枚举值。
- 默认值在保存时填充；必填缺失、类型/范围/枚举不符、未知字段都会被拒绝，API 返回 HTTP 400，原有配置不会更新。
- schema 本身在插件清单加载时校验。没有 schema 的现有插件配置保持原行为；增加 schema 后应迁移旧配置使其符合新字段约束。
- `ctx.config` 是插件初始化时传入的配置快照；保存会更新数据库和运行中插件对象的 config 引用，但不会自动重新执行插件 `main.js`。需要重新初始化逻辑时，请在管理页保存后显式重载插件。

## 示例插件

- `plugins/usage-stats/` — 演示 `usage:read` / `models:read` / `meta:read`
- `plugins/webhook-demo/` — 演示 `webhook:register`（白名单校验 + 定时 emit）

## 数据读取（plugin-data-read.js）

`server/utils/plugin-data-read.js` 是唯一的插件只读数据构建器：
- `usageSummary({ userId?, apiKeyId?, days?, groupBy? })` — 用量/成本聚合
- `modelList()` — 模型目录 + 健康列（若存在）
- `pluginMetaView(registry, pluginId)` — 插件注册信息
- `getPreferences(req)` — 用户偏好（授权门控）
