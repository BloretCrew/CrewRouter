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
| `slots:register` | manifest.slots | 前端插槽 |
| `routes:register` | `ctx.expose` | 插件自有 HTTP API |
| `cron:register` | `ctx.cronHandler`/`ctx.scheduleCron` | 进程内轻量定时任务（非持久化队列） |
| `themes:register` | manifest.themes | 主题 |
| **`usage:read`** | `ctx.usage` | 当前已认证用户的用量/成本聚合（不含正文；必须传入已认证请求上下文，插件提供的 userId/apiKeyId 不用于授权） |
| **`models:read`** | `ctx.models` | 模型目录 + 健康度（只读） |
| **`preferences:read`** | `ctx.preferences` | 用户偏好（授权门控） |
| **`audit:write`** | `ctx.audit` | 插件自有审计日志（只读自己的） |
| **`export:usage`** | `ctx.exportUsage` | 当前已认证用户用量安全子集导出；`json(req, opts)` 必须传入经宿主鉴权的请求上下文 |
| **`meta:read`** | `ctx.pluginMeta` | 当前插件注册信息（只读，不可查询其他插件） |
| **`webhook:register`** | `ctx.registerWebhook`/`ctx.webhook` | 出站 Webhook（域白名单） |
| **`admin:view`** | `ctx.adminView` | 管理面板只读视图 |
| **`tasks:register`** | `ctx.tasks` | 注册受限任务处理器；提交 JSON payload（≤64 KiB）、幂等键，查询/取消自己的任务；worker 用租约和指数退避重试。默认 trusted-in-process；`executionMode: isolated-task` 时仅允许运行 Linux/bwrap 纯计算 `task-entry.js`，不提供 storage/network/hooks/routes/cron 等 host API |
| **`events:subscribe`** | `ctx.events.on` | 订阅版本化模型健康、配额阈值和插件生命周期事件；进程内异步 best-effort，不保证跨重启投递 |

- `executionMode: "isolated-hooks"` 是独立运行模式而非权限；目前只允许运行 JSON-safe `billing:calculate`、`stats:record`、`gateway:finalResponse` 和 `models:list`，宿主每次调用启动 bwrap worker；finalResponse 只可写 `X-Plugin-<pluginId>-*` header；models:list 只能返回宿主给定列表的子集，不能添加模型或改字段。Secrets、请求正文、用户 ID、provider ID 不会传给 handler；其它 hook 均在 trusted-in-process 中运行。

## 安全约束（所有能力）

- **绝不暴露**裸 `fs` / `child_process` / `net` / 裸数据库连接。
- 所有数据访问走字段白名单：`usage:read` / `export:usage` 返回聚合（request_count/tokens_used/cached_tokens/weighted_tokens/cost/group_key），**不含** `messages`/`response`/`request_params`/provider 凭证/API Key 明文。
- `preferences:read` 受用户授权门控：用户未在设置页开启「允许插件读取我的偏好」时，`ctx.preferences.get()` 返回 `{ granted: false, reason: 'not_opted_in' }`。
- 未知权限在加载时仅 warning，不阻断（向后兼容旧插件），但未知 hook 名会被拒绝。
- `events:subscribe` 目前提供 best-effort 进程内通知，事件版本名以 `.v1` 结尾；需要跨重启保证的工作请用 `tasks:register`，而非把事件订阅当作消息队列。
- 后端 `main.js` 默认/在 `trusted-in-process` 模式下于 CR 主进程执行；Node VM 不是恶意代码安全边界。Linux/bwrap隔离支持 `isolated-task` 纯计算任务和 `isolated-hooks` 的 JSON-safe billing/stats hooks；隔离 worker 是单次短命进程，不提供 storage/network/routes/provider 等通用 ctx API。隔离模式使用 host/namespace UID/GID 65534、无网、最小只读 runtime、无 capabilities、JSON frame 上限、CPU 25 秒、虚拟地址空间 4 GiB、64 文件描述符；启用需 `CR_ENABLE_PLUGIN_BWRAP=1` 与 live preflight，否则拒绝加载、不降级。当前无 cgroup/seccomp，仍共享宿主内核，不防内核/运行时漏洞。
- `tasks:register` 示例：`ctx.tasks.register('refresh', async (payload, meta) => ({ done: true })); const task = await ctx.tasks.enqueue('refresh', { scope: 'self' }, { idempotencyKey: 'refresh-v1', maxAttempts: 5 });`。`enqueue` 的幂等键在同一插件内唯一，重复提交返回已有任务；handler 可用 `meta.signal` 配合取消；结果必须为 JSON 对象且最大 64 KiB。用户插件路由默认可访问该插件自己的任务状态，但取消只对尚未领取的任务有效。

## 事件（events:subscribe）

事件 API 是进程内 best-effort 通知；它不保证跨进程、跨重启或断网期间投递。需要持久化工作的请使用 `tasks:register`。

```js
ctx.events.on('model.health.changed.v1', async event => {
  ctx.log.info(event.payload.modelId, event.payload.health);
});
```

当前 schema：

- `model.health.changed.v1`：`modelId`、`health`、`statusCode`、`observedAt`。
- `quota.threshold.v1`：`scope`、`remaining`、`threshold`、`observedAt`。OpenCode Go 已在用户显式开启 Key 额度预警且签名构建读取上游 quota 时发布该事件；只包含 `opencode_go:<window>` scope、remaining 与 10% threshold，不含用户、Key 或 provider 标识。Team 限额检查仍运行于计费热路径，不从该路径广播；事件阈值状态为内存 best-effort，服务重启后先重新建立 baseline。
- `plugin.lifecycle.v1`：`pluginId`、`action`、`version`。

仅返回字段白名单；schema 版本变更用新的事件名，不静默扩展现有 payload。

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
