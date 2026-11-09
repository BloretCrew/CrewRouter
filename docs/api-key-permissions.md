# API Key 权限与 Key 鉴权

> 状态：2026-11-09。本文描述控制台接口的 API Key 鉴权与权限模型。

## 1. 默认行为

- API Key 可以访问控制台 `/api/*` 接口，不再只限于网关。
- 新建 Key 默认获得 **gateway 组**权限（`gateway.chat`、`gateway.messages`、`gateway.responses`、`gateway.models`），避免升级后现有客户端立即失效。
- 控制台、账号、管理类权限默认关闭，必须显式授予。
- 显式传入空权限数组 `permissions: []` 会创建一把无任何权限的 Key。
- 已有 Key 在升级时只回填缺失的网关权限；已经存在的 `permissions` 不会被覆盖。
- 系统自动创建的 `CrewRouter` Key 同样获得 gateway 默认权限。

## 2. 鉴权方式

支持两种请求头，二者等价：

```http
Authorization: Bearer sk-...
```

```http
x-api-key: sk-...
```

规则：

- 只要请求带有效 API Key，就按 Key owner 身份执行；**不再回退到 session**。
- Key 不存在 → `401 invalid_api_key`。
- Key 停用 → `403 key_disabled`。
- Key 过期 → `401 key_expired`。
- `Authorization: Bearer crh_...` 是 OAuth access token，不按 API Key 处理；控制台接口会返回 `401 oauth_token_not_allowed`。
- Key 与登录 session 同时存在时，Key 优先。

## 3. 权限目录

唯一事实来源：`public/js/api-key-permissions.json`。后端通过 `server/utils/api-key-permissions.js` 加载，前端通过 `/js/api-key-permissions.json` 加载。

分组：

| 分组 | 权限 |
| --- | --- |
| 模型网关 | `gateway.chat`、`gateway.messages`、`gateway.responses`、`gateway.models` |
| 客户端事件 | `events.report`、`events.read` |
| 账号与用量 | `account.profile.read`、`account.profile.write`、`account.redeem`、`usage.read`、`usage.write` |
| API Key 管理 | `keys.read`、`keys.write`、`keys.secret`、`keys.members`、`keys.permissions` |
| 模型与供应商 | `models.read`、`models.write`、`providers.read`、`providers.write` |
| 会话与提示词 | `conversations.read`、`conversations.write`、`prompts.read`、`prompts.write` |
| 通知与插件 | `notifications.read`、`notifications.write`、`plugins.read`、`plugins.write` |
| 工具 | `playground.use`、`agent.use`、`agent.manage` |
| 管理员 | `admin.users.read/write`、`admin.teams.read/write`、`admin.models.read/write`、`admin.providers.read/write`、`admin.stats.read`、`admin.audit.read`、`admin.settings.read/write`、`admin.billing.read/write`、`admin.plugins.read/write`、`admin.oauth_clients.read/write`、`admin.popups.read/write`、`admin.invites.read/write`、`admin.agent.manage`、`admin.cache.read/write` |

管理员权限：

- 仅当 Key owner 的 `users.is_admin = true` 时生效。
- 即使 Key 持有 `admin.*` 权限，非管理员用户仍返回 `403 admin_required`。

## 4. 路由覆盖与默认拒绝

- `server/middleware/api-key-permissions.js` 在请求进入业务路由前匹配 `method + path`。
- 未登记权限的非公开路由，API Key 请求返回 `403 permission_not_configured`。
- `server/scripts/test-console-route-auth-coverage.js` 静态扫描路由，防止新增接口漏配权限。
- 权限检查只叠加，不替代原有 `requireAdmin`、`requireProviderManager` 和 Team edition 检查。

## 5. Session-only 接口

以下接口永远只接受登录 session，API Key 会返回 `403 session_required`：

- `/auth/*`
- `/api/2fa/*`
- `/api/passkey/*`
- `/api/setup/*`
- `/api/admin/update/*`
- `/oauth/authorize*`、`/oauth/authorizations*`
- `/api/user/model-trace/*`

## 6. Co-Key

- Key 的权限集合属于父 Key，Co-Key 成员继承。
- Co-Key 成员看不到 `key_value`，只能看到前缀；`/api/user/api-keys/:id/config` 仅 owner 可访问。
- Co-Key 仍允许 owner 使用该 Key 进行控制台鉴权。
- 权限修改仅 owner 可操作；成员即使能管理其他 Key 设置，也不能修改权限。

## 7. 创建与修改

创建 Key（复用现有端点）：

```http
POST /api/user/api-keys
Content-Type: application/json

{
  "name": "CI",
  "expiresIn": 720,
  "permissions": ["gateway.chat", "gateway.messages"]
}
```

修改权限（复用现有端点，仅 owner）：

```http
PUT /api/user/api-keys/:id
Content-Type: application/json

{ "permissions": ["gateway.chat", "gateway.models", "keys.read"] }
```

约束：

- 普通用户不能授予 `adminOnly` 权限。
- Key 身份调用时，新权限不得超出该 Key 自身权限；修改权限还要求拥有 `keys.permissions`。
- `permissions` 必须是数组；未知权限 ID 会被拒绝。

## 8. 升级与回滚

- 迁移键：`settings.migration_open_api_key_gateway_permissions_v1`。
- 首次升级只给历史 Key 补 gateway 权限，不会覆盖已有权限。
- 如果已经手动调整过权限，迁移不会再次改写。
- 回滚代码不会自动恢复权限；需要按备份或控制台重新授予。

## 9. 测试

```bash
npm run test:api-key-permissions
npm run test:csrf-boundaries
npm run test:security-guards
node --test server/scripts/test-oauth-bearer-policy.js
```
