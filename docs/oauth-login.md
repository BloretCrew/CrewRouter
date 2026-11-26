# CrewRouter OAuth 登录与授权整理

> 更新：2026-11-26。说明 CrewRouter 自有 OAuth 授权服务的授权码与设备码流程、权限范围和客户端支持；不代表 OAuth 已成为 CLI 的交互式登录方式。
> 仓库里同时存在多个容易混淆的“OAuth”概念，先按职责分开：

| 编号 | 体系 | 谁登录谁 | 是否使用 OAuth | 当前状态 |
| --- | --- | --- | --- | --- |
| 1 | Bloret PassPort 主登录 | 用户 → CrewRouter | CrewRouter 是 OAuth 客户端 | Personal / Desktop Local 唯一登录方式；Team 可选 |
| 2 | 飞书企业登录 | 用户 → CrewRouter | CrewRouter 是 OAuth 客户端 | Team 实例可选；与密码登录并存 |
| 3 | 插件商店 PassPort | 商店访客 → CrewRouter 商店 | CrewRouter 商店是 OAuth 客户端 | 仅 `demo: true` 时挂载，身份与主站隔离 |
| 4 | CrewRouter OAuth 2.0 授权服务 | 已实现 OAuth 的 Desktop / Helper / 第三方应用 → CrewRouter | CrewRouter 是授权服务器 | 正式；PKCE + 授权码 + 刷新令牌 + 设备授权 grant；`cr login` 尚未实现 OAuth 登录 |
| — | 旧版 GitHub 登录 | 用户 → CrewRouter | 原 OAuth 客户端 | 已停用，路由固定返回 410 |
| 附 | 上游供应商 OAuth Token | CrewRouter → 上游供应商 | 用于额度查询/调用，不是用户登录 | 管理端导入 `auth.json`，不在 CrewRouter 内走登录流程 |

---

## 1. 实例认证策略

实际登录方式由 `server/utils/instance-edition.js` 的 `metadata()` 根据 `edition` 与 `runtime` 决定，而不是配置里的 `auth.methods`：

| runtime / edition | 允许的登录方式 |
| --- | --- |
| `runtime=desktop-local` | 仅 `passport`（Bloret PassPort） |
| `edition=personal` | 仅 `passport` |
| `edition=team` | `password` + 初始化时选择的 `feishu` 或 `passport` |

- `auth_mode` 存在 `settings` 表，只允许 `feishu` / `passport`，在 `setup_complete` 写入后冻结；未设置时默认 `feishu`。见 `server/utils/auth-mode.js`。
- Team 实例即使选择 `auth_mode=passport`，仍同时允许密码登录；真正“仅 PassPort”的只有 Personal 与 Desktop Local。
- OOBE 入口：`/setup`。Personal 走 PassPort 授权完成初始化；Team 先选账号系统模式，飞书模式通过 `/api/setup/admin` 创建管理员。
- 登录页读取 `GET /auth/status` 决定显示哪些入口。返回字段包括 `auth`、`authMode`、`passportConfigured`、`feishuEnabled`；Desktop Local 额外返回 `passportOrigin`。不返回任何凭据。
- Personal / Desktop Local 缺少 PassPort 凭据时，登录入口直接不可用，不会回退到匿名或共享凭据。

### 1.1 登录/授权端点总览

| 方法 | 路径 | 体系 | 是否要求已登录 |
| --- | --- | --- | --- |
| GET | `/auth/status` | 全站登录状态 | 否 |
| POST | `/auth/login` | 密码登录（Team） | 否 |
| GET | `/auth/passport` | PassPort 主登录入口 | 否 |
| GET | `/auth/passport/callback` | PassPort 主登录回调 | 否（校验 state） |
| GET | `/auth/passport/redirect-uri` | PassPort 回调地址探测 | 否 |
| GET | `/auth/passport/cancel` | Desktop Local 取消授权 | 否（校验 Desktop token） |
| GET | `/auth/feishu` | 飞书登录入口 | 否 |
| GET | `/auth/feishu/callback` | 飞书登录回调 | 否（校验 state） |
| GET | `/auth/feishu/status` | 飞书登录是否可用 | 否 |
| GET | `/auth/feishu/pending` | 飞书待绑定信息 | 绑定会话 |
| POST | `/auth/feishu/bind` | 飞书绑定已有账号 | 绑定会话 |
| GET | `/store/auth/login` | 商店 PassPort 登录入口 | 否 |
| GET | `/store/auth/callback` | 商店 PassPort 回调 | 否（校验签名 state） |
| GET/POST | `/store/auth/logout` | 商店退出 | 否 |
| GET | `/oauth/authorize` | 自有 OAuth 授权入口 | 是 |
| GET | `/oauth/authorize/info` | 授权确认页数据 | 是 |
| POST | `/oauth/authorize/approve` | 同意/拒绝授权 | 是 |
| POST | `/oauth/token` | 授权码/刷新令牌 | 否（token 鉴权） |
| POST | `/oauth/desktop-session` | 授权码换 Web Session | 否（PKCE） |
| GET | `/oauth/authorizations` | 授权链列表 | 是 |
| POST | `/oauth/authorizations/revoke` | 吊销授权链 | 是 |
| POST | `/oauth/revoke` | RFC 7009 吊销 | 否（token 鉴权） |
| GET | `/.well-known/oauth-authorization-server` | OAuth 元数据 | 否 |

---

## 2. Bloret PassPort 主登录

### 2.1 配置

`server/config-loader.js` 中的顶层 `passport`：

```json
{
  "passport": {
    "appId": "",
    "appSecret": "",
    "redirectCallbackHost": ""
  }
}
```

环境变量：

| 环境变量 | 配置路径 |
| --- | --- |
| `CR_PASSPORT_APP_ID` | `passport.appId` |
| `CR_PASSPORT_APP_SECRET` | `passport.appSecret` |
| `CR_PASSPORT_REDIRECT_CALLBACK_HOST` | `passport.redirectCallbackHost` |

补充事实：

- `baseUrl` 默认 `https://passport.bloret.net`，只能通过 `config.json` 设置；主登录的环境变量映射中没有 `CR_PASSPORT_BASE_URL`。
- `redirectCallbackHost` 仍保留在默认配置和示例里，但 `passport-auth.js` 当前不读取它；回调来源由 `app.publicOrigin` 或请求 Host 推导。
- 凭据校验在 `server/utils/passport-credentials.js`：
  - 拒绝空白/控制字符、模板占位值（`your-*`、`change-me`、`<...>` 等）；
  - 拒绝历史已公开的共享 Secret（按 SHA-256 指纹）；
  - 环境变量显式设为空字符串会清空配置文件中的值，不会回填默认共享凭据。
- 无论主登录还是商店登录，缺少有效凭据时都保持关闭，不做降级。

### 2.2 服务端流程

入口与回调都在 `server/routes/passport-auth.js`，挂载于 `/auth`。

**发起：`GET /auth/passport`**

1. Desktop Local 先校验 `x-crewrouter-desktop-token`（`CR_LOCAL_TOKEN`，仅本机回环地址）。
2. 检查实例 `metadata().auth.methods` 是否包含 `passport`；不包含则返回“不支持”。
3. 检查 `hasPassportCredentials(config.passport)`；未配置时：
   - 普通 Server 跳 `/?error=passport_not_configured`；
   - Desktop Local 返回 503 页面。
4. 计算回调地址：
   - Server：`config.app.publicOrigin` 优先，否则由 `req.protocol` + `Host` 推导；最终固定为 `{origin}/auth/passport/callback`。若请求带 `redirect_origin`，必须与该 origin 完全一致。
   - Desktop Local：必须是 `http://127.0.0.1|localhost|[::1]:{config.app.port}`，且 `redirect_origin` 必须匹配当前 Local origin。
5. 生成 state：
   - Server：`server/utils/passport-login-state.js` 写入 `req.session.passportLogin`，包含 state（32 字节 hex）、sessionID、origin、context（`[baseUrl, appId]` 的 JSON）、invite、5 分钟过期时间；同时删除旧 `passportState` / `passportInvite`。
   - Desktop Local：`server/utils/local-passport.js` 使用进程内 `pendingStates` Map + `req.session.localPassportState`，同样 5 分钟；同一 session 发起新授权会使旧 state 失效。
6. state 同时放进回调地址的 query 与授权 URL 的 `state` 参数（兼容只回传 code、不保留 query 的提供方）。
7. 跳转 `${baseUrl}/app/oauth?app_id=...&redirect_uri=...&state=...`。

**回调：`GET /auth/passport/callback`**

1. 校验 state：必须为 64 位 hex、与 session 中完全一致、sessionID/origin/context 匹配、5 分钟内、未被消费；同一进程用有界 Map 拒绝并发重放。
2. 先持久化“已消费”状态，再发起外部交换；跨进程的一次性仍依赖 IdP 的一次性 code。
3. 用 code 换身份：`server/utils/passport-verifier.js`
   - 主登录使用 **POST** `${baseUrl}/app/verify`，JSON 体 `{ app_id, app_secret, code }`，并要求响应包含 `apptoken`；
   - 商店使用 **GET** 同一端点，不要求 `apptoken`；
   - 只接受 HTTPS、无凭据/查询/fragment 的 base URL；
   - 固定 DNS 解析结果、禁止重定向、总超时 10 秒、响应上限 64 KiB；
   - 严格检查 UTF-8/JSON/身份字段；只返回 `username`、`admin`、`nickname`、`email`、`avatar`（主登录还保留 `apptoken`），不记录或透传密码等字段。
4. 用户落库（事务内）：
   - 按 `users.passport_username` `FOR UPDATE` 查找；
   - 不存在时：
     - 若 `setup_complete` 不存在且用户数为 0，则本次授权创建初始管理员；
     - 否则必须提供有效 `invite`（邀请码），无邀请返回 403；
     - 创建 `users`，写 `passport_username`、昵称/邮箱/头像，`is_admin` 由是否首管理员决定，`balance=10`；
     - 同时创建默认 API Key（名为 `CrewRouter`，模型 `claude-fable-5`）、加入默认/个人 Team、播种默认注入提示词；
     - 首管理员写入 `setup_complete`（`method=passport-authorized`）。
   - 并发通过 `AUTH_MODE_LOCK` 与 `731947` 两个 advisory lock 串行化。
5. 成功后 `session.regenerate()`，写入 `req.session.user`，调用 `reportLoginEvent()`（登录上报），跳 `/console`。
6. 失败状态码：state 无效 400、PassPort 未配置 503、实例不支持 403、邮箱冲突 409、其他 502。

**Desktop Local 回调差异**

由 `localCallback()` 处理：

- 必须带 Desktop token，且来源为回环地址；
- state 在异步交换前消费，并多次 `assertActive()`，取消/过期后不允许继续；
- 身份必须同时含 `username` 与 `apptoken`；
- 用户绑定规则（`chooseLocalUser()`）：
  - 已存在 `passport_username` 的用户：必须恰好一个、身份相同、且是管理员；
  - 没有绑定身份但已有用户：只有“唯一管理员且没有邮箱、密码、GitHub、飞书、2FA、PassKey”的旧本地管理员可被自动绑定；
  - 否则创建新用户。
- 创建个人 Team、写入全部可用模型、写 `setup_complete`（`method=local-passport-authorized`）；
- 成功后 session 标记 `localPassportAuth=true`，每请求由 `localSessionGuard()` 重新核对数据库中的 `passport_username` 与 `is_admin`。

**其他端点**

| 端点 | 作用 |
| --- | --- |
| `GET /auth/passport/redirect-uri` | 返回本实例将使用的回调地址；Desktop Local 或来源不合法时按本机规则返回 403 / 需确认 |
| `GET /auth/passport/cancel` | 仅 Desktop Local；校验 token、清空 pending state 并销毁会话，返回 204 |

### 2.3 前端

- `public/pages/index.html`、`public/pages/plain-login.html`：根据 `/auth/status` 显示 PassPort / 飞书按钮；Desktop Local 隐藏密码表单并显示本地授权说明。
- `public/pages/setup.html`：OOBE 的 PassPort 授权入口，先请求 `/auth/passport/redirect-uri`，必要时让用户确认公网回调 origin。
- 邀请参数：登录页把 `?invite=` 暂存到 `sessionStorage`，再拼到 `/auth/passport?invite=...`。
- Desktop：`CrewRouter-Desktop/src/app/local-passport.js` 拦截本地 `/auth/passport`，在独立安全窗口内完成授权，导航仅允许 PassPort 来源、已知第三方授权域、目标实例回调和 `/console`；取消时调用 `/auth/passport/cancel`。

---

## 3. 飞书企业登录

### 3.1 配置

优先级：`settings` 表 `key='feishu_login'` → `config.feishu` → 环境变量 `CR_FEISHU_APP_ID` / `CR_FEISHU_APP_SECRET` / `CR_FEISHU_TENANT_KEY`。

- `enabled=true` 且存在 `appId` 才对外可用（`isFeishuLoginAvailable()`）；`config` 回退时 `enabled` 直接由 `appId` 是否存在决定。
- 管理后台：
  - `GET /api/admin/feishu-login` 返回配置，`appSecret` 脱敏为 `********`；
  - `PUT /api/admin/feishu-login` 保存配置；启用时必须填 App ID，且已有 Secret 或本次提供 Secret；写审计日志。
- `GET /auth/feishu/status` 是公开端点，只返回 `{ enabled }`，供登录页判断是否显示按钮。
- 配置保存后会清空 App Access Token 缓存。

### 3.2 登录流程（`server/routes/feishu.js`）

1. **入口 `GET /auth/feishu`**
   - 检查实例允许 `feishu`；
   - 检查 `enabled` 与 `appId`；
   - 回调地址 `buildRedirectUri()`：`app.publicOrigin` 优先；否则依次使用 `x-forwarded-host`、`Host`、`x-forwarded-proto`/`req.protocol`；最后回退到 `http://localhost:{port}` 或 `https://{host}`；
   - state 为 16 字节 hex，存入 session，TTL 10 分钟，同时保存配置哈希（`appId + appSecret + tenantKey`）；
   - 跳转 `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=...&redirect_uri=...&state=...`。
2. **回调 `GET /auth/feishu/callback`**
   - 精确比对 session 中的 state 与过期时间；
   - 再检查实例策略、配置完整、配置哈希未变化；
   - `getAppAccessToken()`：调用飞书 `app_access_token/internal`，缓存到过期前 5 分钟；
   - 用 code 换 `user_access_token`：`authen/v1/oidc/access_token`；
   - 拉取 `authen/v1/user_info`；若无邮箱，尝试 `contact/v3/users/{open_id}` 获取 `enterprise_email` / `email`；
   - 若配置了 `tenantKey`，要求 `userInfo.tenant_key` 完全一致，否则拒绝（企业隔离）；
   - 身份键优先 `feishu_open_id`，其次规范化邮箱、飞书用户名。
3. **用户处理**
   - 已有 `feishu_open_id`：直接登录，更新头像/邮箱；邮箱冲突则失败；
   - 邮箱命中已有用户、或用户名命中已有用户：进入“绑定已有账号”流程；
   - 都没有：创建新用户，写 `feishu_open_id`，`email_verified=true`，`balance=10`，创建默认 `CrewRouter` API Key、播种提示词、分配初始 Team。
4. **绑定已有账号**
   - 会话写入 `feishuPending`（5 分钟），跳 `/feishu-bind`；
   - `GET /auth/feishu/pending` 返回待绑定信息；
   - `POST /auth/feishu/bind` 要求本地密码；若账号启用 2FA，还必须提供有效 TOTP；
   - 限流：同一 `IP + userId` 15 分钟内最多 5 次；
   - 使用条件 UPDATE 校验 `password_hash`、`two_factor_enabled`、`totp_secret` 未变化，避免验证后账号被并发修改；
   - 成功后写审计日志、轮换 session、上报登录。
5. 成功后跳 `/console`；未设置密码的用户跳 `/set-password`。失败统一用 `/?error=...` 返回（`feishu_state_invalid`、`feishu_not_enterprise`、`feishu_conflict` 等）。

### 3.3 前端

- 登录页 `public/pages/index.html` / `plain-login.html` 显示飞书按钮。
- 绑定页 `public/pages/feishu-bind.html` 调 `/auth/feishu/pending` 与 `/auth/feishu/bind`。
- 管理后台系统设置中维护飞书 App ID / Secret / Tenant Key。

---

## 4. 插件商店 PassPort 登录（独立身份）

商店登录与 CrewRouter 主站 session 完全隔离，仅用于插件提交、评分、审核等商店写操作；商店管理员身份也独立。

### 4.1 挂载与配置

- 仅在 `demo: true` 时挂载：
  - `/store` 页面与 `/store/*` 路由（`server/routes/store.js`）；
  - 商店数据初始化（`server/store/store.js`）。
- 配置在 `store.passport`：
  - `baseUrl`、`appId`、`appSecret`、`redirectUri`、`sessionSecret`、`adminUsernames`；
  - 环境变量优先级：`PASSPORT_*` / `CR_STORE_PASSPORT_*`（`PASSPORT_BASE_URL`、`PASSPORT_APP_ID`、`PASSPORT_APP_SECRET`、`PASSPORT_REDIRECT_URI`）；
  - 会话密钥来源依次为 `CR_STORE_SESSION_SECRET`、`PASSPORT_SESSION_SECRET`、`store.passport.sessionSecret`、`store.sessionSecret`、`app.sessionSecret`；
  - 会话密钥必须 32–4096 字节、非模板/默认值，否则商店登录关闭。
- `config.example.json` 明确注明：`store.passport` 仅用于插件商店；顶层 `passport` 用于主认证。

### 4.2 授权流程

**`GET /store/auth/login`**

1. 检查 appId / appSecret / sessionSecret；
2. 解析 `redirect_uri`：显式配置优先，否则 `{proto}://{host}/store/auth/callback`；
3. `server/utils/passport-store-state.js` 把 state 写入签名 Cookie：
   - HTTPS 下 Cookie 名 `__Host-cr-store-oauth`，否则 `cr_store_oauth`；
   - `HttpOnly`、`SameSite=Lax`、`Path=/`、5 分钟；
   - 载荷包含随机 32 字节 state、context（`[baseUrl, appId, 去掉 state 的 redirect_uri]` 的 SHA-256）、清洗后的 `returnTo`、过期时间；
   - HMAC-SHA256 签名，密钥为 `sessionSecret`；
   - `returnTo` 仅允许站内绝对路径，拒绝 `//`、反斜杠、控制字符，默认 `/store`；
   - 同进程另有 10,000 条已消费 state 缓存，阻止并发重放。
4. 跳 `${baseUrl}/app/oauth?app_id=...&redirect_uri=...&state=...`。

**`GET /store/auth/callback`**

1. 从 Cookie 读取并验签 state，校验 context、过期时间、一次性；
2. 使用 **GET** `${baseUrl}/app/verify?app_id&app_secret&code` 验证，不要求 `apptoken`（历史契约）；
3. 只接受 `username`、`avatar`、布尔 `admin`；
4. 管理员判定：PassPort 返回 `admin=true`，或用户名在 `adminUsernames` 白名单；
5. 写入独立 Cookie `bl_store_session`（HMAC-SHA256，7 天，载荷 `{username, avatar, admin, iat}`），跳回 `returnTo` 并附加 `auth=ok`。

**退出**

- `GET /store/auth/logout`：清 Cookie 后跳 `/store?auth=logout`；
- `POST /store/auth/logout`：清 Cookie 后返回 JSON。

### 4.3 与 Desktop 官方站登录的关系

`GET /store/api/install-targets?helper_login=1` 在未登录时也允许访问，按访问者 IP 与设备信息列出“登录过的 CrewRouter”，供 Desktop 选择目标实例。普通商店操作仍要求独立 PassPort 会话。

### 4.4 已知边界

- 商店 state 依赖浏览器 Cookie 签名，因此不同实例可以独立校验回调；跨进程的“一次性”仍依赖 PassPort 的一次性 code。
- 历史契约是 GET 交换，`app_secret` 会出现在查询串中，可能进入提供方及反向代理日志；HTTPS 只保护链路，不消除端点日志风险。
- 商店 Cookie 没有单会话撤销能力；轮换 `sessionSecret` 会让全部商店会话和待授权 state 失效。
- 商店只在 Demo 模式挂载；顶层 PassPort 配置不会自动配置商店。

---

## 5. CrewRouter 自有 OAuth 2.0 授权服务

实现：`server/routes/oauth.js`，非 demo 模式下挂载在根路径 `app.use('/', require('./routes/oauth'))`。
它**不是**用户登录入口，而是让已经登录控制台的用户给 CLI / Desktop / Helper 以及第三方应用授权，客户端拿到绑定到某个 API Key 的访问令牌。

### 5.1 客户端注册表与 scope

客户端有三个来源，按优先级合并（`server/utils/oauth-clients.js`）：

1. **内置客户端**：代码内定义，始终优先，后台不可编辑；
2. **`config.oauth.clients`**：部署时声明，只读；
3. **`oauth_clients` 表**：管理员在后台创建，可编辑、轮换密钥、删除。

内置客户端：

| client_id | 名称 | 类型 | 允许 scope | 回调策略 |
| --- | --- | --- | --- | --- |
| `crewrouter-desktop` | CrewRouter Desktop | 公共 | `events:report` | 任意 loopback 路径 |
| `crewrouter-helper` | CrewRouter Helper | 公共 | `events:report` | 任意 loopback 路径 |
| `crewrouter-cli` | CrewRouter CLI | 公共 | `gateway:invoke` | 任意 loopback 路径 |

第三方客户端分两类：

- **公共客户端（public）**：原生应用、CLI、SPA；无 client_secret，强制 PKCE；可登记 loopback、自定义 scheme 或 HTTPS 回调。
- **机密客户端（confidential）**：服务端应用；必须提供 client_secret，支持 `client_secret_basic` 与 `client_secret_post`；仍强制 PKCE。

回调地址规则：

- 登记的 HTTPS 地址按协议、主机、端口、路径、查询串精确匹配；
- 回环地址（`127.0.0.1`、`localhost`、`[::1]`）只允许 `http:`，并忽略端口，以兼容 RFC 8252 的动态端口；
- 自定义 scheme（如 `myapp://oauth/callback`）按完整地址精确匹配，且必须带 authority；仅建议公共客户端使用；
- 拒绝非回环 `http:`、`javascript:`、`data:`、`file:`、带凭据或 fragment 的地址；
- 内置客户端保留原有行为：任意 `http://127.0.0.1|localhost|[::1]:<port>/<path>`。

scope：

| scope | 含义 | 使用端点 | 可分配给第三方 |
| --- | --- | --- | --- |
| `events:report` | 上报客户端使用事件 | `POST /api/client-events` | 是 |
| `gateway:invoke` | 通过网关调用模型 | `/v1/*` 网关端点 | 是 |
| `console:read` | 预留给控制台读取类资源 | 当前没有 OAuth Bearer 保护的控制台读取端点；授予后目前不会额外开放控制台 API | 是，但暂未生效于资源访问 |

管理接口（仅管理员）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/oauth-clients` | 列出内置、配置和数据库客户端 |
| POST | `/api/admin/oauth-clients` | 创建客户端；机密客户端返回一次性 `client_secret` |
| PUT | `/api/admin/oauth-clients/:clientId` | 更新；可同时轮换密钥 |
| POST | `/api/admin/oauth-clients/:clientId/rotate-secret` | 轮换机密客户端密钥 |
| DELETE | `/api/admin/oauth-clients/:clientId` | 删除客户端，并吊销其授权码与全部令牌 |

`config.oauth.clients` 示例：

```json
{
  "oauth": {
    "clients": [
      {
        "clientId": "my-web-app",
        "name": "My Web App",
        "type": "confidential",
        "secret": "replace-with-at-least-32-random-characters",
        "scopes": ["gateway:invoke"],
        "redirectUris": ["https://app.example.com/oauth/callback"],
        "enabled": true
      },
      {
        "clientId": "my-cli",
        "name": "My CLI",
        "type": "public",
        "scopes": ["gateway:invoke"],
        "redirectUris": ["http://127.0.0.1/callback"],
        "enabled": true
      }
    ]
  }
}
```

> `config.oauth.clients` 中的 `secret` 是明文配置项，应与 `config.json` 一同保护，且至少 32 个字符；后台创建的客户端只保存 SHA-256 哈希和 6 位提示。

### 5.2 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/oauth/authorize` | 授权入口；要求控制台 session；校验参数后返回确认页 `public/pages/oauth-consent.html` |
| GET | `/oauth/authorize/info` | 确认页数据：客户端名、scope、回调地址、state、当前用户可用 API Key |
| POST | `/oauth/authorize/approve` | 同意/拒绝；同意时签发 10 分钟一次性授权码并 302 回 loopback |
| POST | `/oauth/device/code` | RFC 8628 设备授权申请，返回 `device_code`、`user_code`、验证 URI、有效期与轮询间隔 |
| GET | `/oauth/device` | 登录后输入用户码并查看客户端名称及请求 scope |
| POST | `/oauth/device/authorize` | CSRF 保护下同意或拒绝设备授权 |
| POST | `/oauth/token` | `authorization_code`、`refresh_token` 与 `urn:ietf:params:oauth:grant-type:device_code` 三种 grant |
| POST | `/oauth/desktop-session` | Desktop 用授权码 + PKCE 换取 Web Session Cookie |
| GET | `/oauth/authorizations` | 当前用户的活跃授权链列表（控制台“授权管理”） |
| POST | `/oauth/authorizations/revoke` | 吊销当前用户指定授权链 |
| POST | `/oauth/revoke` | RFC 7009 风格吊销；未知 token 返回 200 |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 元数据 |

补充：

- `/oauth/authorize/info` 额外返回 `client.type`、`client.first_party`、`client.description`；确认页对非首方客户端显示“第三方应用”警告和实际回调地址。
- `/oauth/token` 支持公共客户端（无密钥）和机密客户端（`client_secret_basic` 或 `client_secret_post`）。注册表出现前签发的旧 refresh 令牌仍允许按原 `client_id` 刷新，日志会记录“未知客户端”警告。
- 元数据公布 `token_endpoint_auth_methods_supported`（`none`、`client_secret_basic`、`client_secret_post`）。

### 5.3 授权码流程

1. `GET /oauth/authorize` 参数校验：
   - `client_id` 必须能解析到已启用客户端（内置、配置或数据库）；
   - `response_type=code` 必须显式提供；
   - `redirect_uri` 按该客户端的回调策略匹配：内置客户端允许任意 loopback 路径；注册客户端精确匹配登记地址，回环地址忽略端口；
   - `scope` 必须是该客户端白名单子集；为空时取客户端默认全集；
   - PKCE challenge 必须符合 RFC 7636 长度/字符集，且 `code_challenge_method=S256` 必须显式提供；客户端还应生成随机 `state` 并在回调时核验，授权服务器会原样带回成功或拒绝结果中的 state。
   - 未登录的 HTML 导航跳 `/?error=login_required`。
2. `POST /oauth/authorize/approve`：
   - `decision=deny` → 302 到回调地址，带 `error=access_denied` 与 state；
   - 同意时校验 `api_key_id`：必须是当前用户且启用的 Key；未提供或非法时取第一个启用 Key；
   - 授权码为 32 字节随机 base64url，10 分钟、一次性，存入 `oauth_auth_codes`（含 client、user、api_key、scope、PKCE challenge）；
   - 302 回调，带 `code` 与 `state`。
3. `POST /oauth/token` 的 `authorization_code`：
   - 必须通过 POST `application/x-www-form-urlencoded` 提交 `code`、`client_id`、原始 `redirect_uri`、`code_verifier`；机密客户端还须按注册方式认证；
   - **先原子认领 code（`used=TRUE`），再校验 PKCE**，错误 verifier 也会烧掉 code，防止暴力枚举；
   - 校验过期与 `S256(verifier) == challenge`（恒时比较）；
   - 签发：
     - access token：`crh_` + 32 字节随机 base64url，24 小时；
     - refresh token：同格式，30 天；
     - 库内只存 SHA-256，明文只在响应中出现一次；
     - access 行的 `rotated_from` 指向同批签发的 refresh 行，使吊销链遍历能覆盖每一代 access。
4. `POST /oauth/token` 的 `refresh_token`：
   - 事务 + 两个 advisory lock（用户/客户端主体锁、token hash 锁）串行化；
   - 缺失、已吊销、过期 → `invalid_grant`；
   - 已吊销仍被出示 → 视为重放，吊销整条链；
   - 若该 refresh 已有子代 refresh → 视为重用，吊销整条链；
   - 否则轮换出新 access + 新 refresh，更新旧 refresh 的 `last_used_at`。

### 5.4 RFC 8628 设备授权流程

适用于不能方便地打开浏览器或接收回调的 CLI、电视、远程主机等客户端。当前服务端协议已实现；CLI 命令 `cr login` 尚未接入该流程。

1. 客户端 POST 表单到 `/oauth/device/code`，提交 `client_id` 和可选 `scope`。机密客户端按注册要求提供 Basic 或表单 secret；公共客户端不得依赖共享 secret。
2. 成功响应包含 `device_code`（仅设备端持有）、`user_code`（用户输入）、`verification_uri`、`verification_uri_complete`、`expires_in`（当前 600 秒）和 `interval`（当前 5 秒）。数据库只存 device code 的 SHA-256；不要记录或向用户展示 device code。
3. 用户在浏览器登录后打开 `verification_uri`，输入用户码；确认页显示客户端名和请求的 scope。用户同意/拒绝需通过 session 与 CSRF 校验，用户码只可完成一次授权决定。
4. 设备端按 interval 轮询 `/oauth/token`，提交 `grant_type=urn:ietf:params:oauth:grant-type:device_code`、`device_code` 与 `client_id`。`authorization_pending` 表示继续等待，`slow_down` 表示轮询过快且后续 interval 增加 5 秒，`access_denied` 表示用户拒绝，`expired_token` 表示设备码失效。
5. 用户批准后设备端只可兑换一次 access token。该 grant 当前不发 refresh token；token 响应含 `access_token`、`token_type=Bearer`、`expires_in` 和 `scope`。重复兑换返回 `invalid_grant`。

### 5.5 令牌校验与使用

`server/middleware/oauth-bearer.js` 提供双鉴权：

- `Authorization: Bearer crh_...` → 走 OAuth 校验；其他凭证（`sk-...` 等）→ 原样回落普通 API Key 校验。
- OAuth 校验步骤：
  1. 按 SHA-256 查 `oauth_tokens`；
  2. 必须 `kind='access'`、未吊销、`expires_at` 有效；
  3. 按端点确定必需 scope：
     - `/api/client-events` → `events:report`；
     - 其他网关端点 → `gateway:invoke`；
  4. scope 不足返回 403 `insufficient_scope`，并设置 `WWW-Authenticate`；
  5. 复用普通 Key 鉴权管线 `validateBoundApiKey()`，按 `api_key_id + user_id` 加载 Key 的所有者、生命周期、模型授权、额度、用户 RPM/TPM、Fusion、签名等策略；
  6. 设置 `req.apiUser.viaOAuth`、`oauthClientId`、`oauthScope`；
  7. 异步更新 `last_used_at`，失败只记日志。
- OAuth token 不进入普通 API Key 缓存，避免把临时授权当成长期 Key。

使用 `oauthBearer` 的端点：

- `POST /v1/chat/completions`
- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/responses`
- `POST /api/client-events`

`/api/client-events` 的读接口允许控制台 session 或 OAuth。

### 5.6 Desktop 官方站登录

链路：Desktop → 官方站 `/store` → 目标实例 `/oauth/authorize` → Desktop 回环回调 → `/oauth/desktop-session`。

1. Desktop 主进程生成 nonce、PKCE verifier/challenge，在 `127.0.0.1` 动态端口启动一次性回调服务器。
2. 打开 `${CREWROUTER_DEMO_URL 或 https://crewrouter.bloret.net}/store?helper_login=1&state=<nonce>&redirect_uri=http://127.0.0.1:<port>/callback&client_id=crewrouter-desktop&scope=events:report&code_challenge=...&code_challenge_method=S256`。
3. 官方站列出该访问者登录过的 CrewRouter；用户选择后跳到目标实例 `/oauth/authorize`，state 为 `base64url({nonce, router_url})`。
4. Desktop 回调只接受 `GET /callback`：
   - `state.nonce` 必须等于本次 nonce；
   - 必须有 `code`；
   - `router_url` 必须通过 URL 策略；
   - 无效回调返回 400，但**不终止**等待，避免本机其他进程伪造回调打断登录；5 分钟超时。
5. Desktop 向 `router_url/oauth/desktop-session` POST `{code, client_id, code_verifier}`。
6. 服务端原子认领 code、校验过期与 PKCE、读取用户、`session.regenerate()`，写入正常控制台 session，返回 `{ok:true}`；Desktop 解析 `Set-Cookie`，写入 Electron session（`httpOnly`，HTTPS 时 `secure`），再通过 `ConnectionManager` 连接。
7. Desktop 不保存授权码、Token 或 API Key 明文；持久化的是与浏览器等价的 Web Session Cookie。

`/oauth/desktop-session` 的 CSRF 例外只适用于：POST、JSON Content-Type、且没有浏览器 `Origin`/`Referer`/`Sec-Fetch-*` 头。浏览器表单或跨源 fetch 仍走正常 CSRF 校验。

### 5.7 授权码、令牌与吊销的数据模型

`ensureOAuthTables()` 在首次使用时懒建，不修改 `init-db.js`：

- `oauth_clients`：client_id、name、first_party、client_type、redirect_uris、scopes、allow_loopback_any_path、secret_hash、secret_hint、description、enabled、created_at、updated_at；写入三个内置种子。旧表会在首次使用时自动补齐新增列。
- `oauth_auth_codes`：code、client_id、user_id、api_key_id、scope、code_challenge、expires_at、used；超过 1 天的过期码会清理。
- `oauth_tokens`：id、token_hash（唯一）、user_id、api_key_id、client_id、scope、kind（`access`/`refresh`）、expires_at、revoked、rotated_from、created_at、last_used_at。
- 索引：`expires_at`、`rotated_from`、`user_id`。

吊销链（`revokeChain()`）：

- 以目标 token 为锚点，先向上递归找根，再向下递归吊销整个连通分量；
- `rotated_from` 同时承载 refresh→下一代 refresh、refresh→同批 access 两种父子边；
- 递归使用 `UNION` 去重，畸形环也能终止；
- 只沿同一 `user_id + client_id` 遍历，不跨用户/客户端；
- 上限 10,000 行，超过则抛 `OAUTH_REVOKE_LIMIT` 并回滚；
- 使用 `pg_advisory_xact_lock(hashtext('crewrouter-oauth-token-principal'), hashtext([userId, clientId]))` 与轮换串行化；
- 吊销失败或超时返回 503，不谎报成功。

### 5.8 控制台与确认页

- 确认页：`public/pages/oauth-consent.html` + `public/js/oauth-consent.js`
  - 读取 URL 参数，请求 `/oauth/authorize/info`；
  - 展示客户端名、scope 说明、API Key 选择；
  - 非首方客户端显示第三方警告和实际回调地址；
  - 用原生表单 POST `/oauth/authorize/approve`，隐藏域回填全部授权参数；
  - scope 文案：`events:report` = 上报客户端使用事件，`gateway:invoke` = 通过网关调用模型接口，`console:read` = 控制台读取 scope（当前没有对应 OAuth 保护端点，因此授予后不增加实际访问能力）。
- 授权管理：`public/js/app.js` 的 `loadAuthorizations()` / `revokeAuthorization()`，调用 `/oauth/authorizations` 与 `/oauth/authorizations/revoke`。
- 应用管理：管理后台「系统设置 → 登录与认证 → OAuth 应用」可创建、编辑、轮换密钥和删除数据库客户端；内置与配置文件客户端显示为只读。客户端密钥只在创建或轮换后显示一次。
- Demo 模式使用 `server/demo/oauth.js` 返回只读示例授权列表，吊销只返回成功。

### 5.9 CLI 支持状态

虽然内置客户端注册表保留了 `crewrouter-cli`（允许 `gateway:invoke`），且服务端已经提供授权码和设备授权 grant，当前 `cr login` 命令尚未实现 OAuth 浏览器/设备码流程。CLI 目前支持用户名/密码（含 2FA）或 API Key 登录；不要把 CLI 当前的登录界面或 `crewrouter-cli` 客户端登记误认为已能通过 OAuth 登录。

### 5.10 内部 OAuth 令牌

`server/utils/internal-oauth.js` 为服务端内部调用签发令牌：

- client_id 固定 `crewrouter-internal`，scope `gateway:invoke`；
- 绑定用户某个启用的 API Key（优先指定 Key，否则名为 `CrewRouter` 的 Key）；
- 24 小时有效，库内只存 SHA-256；
- 内存缓存 5 分钟，使用前仍会查库确认未吊销未过期；
- 并发签发用 `pendingTokens` 去重；
- 主要用途：会话总结（`server/routes/sessions-view.js`）调用本地 `/v1/chat/completions`，避免读取 API Key 明文。

### 5.11 第三方应用接入示例

**公共客户端（原生 / CLI）**

1. 管理员在「OAuth 应用」创建公共客户端，登记回调，例如 `http://127.0.0.1/callback` 或 `myapp://oauth/callback`。
2. 生成 PKCE：
   - `code_verifier`：43–128 位随机字符串；
   - `code_challenge = base64url(SHA-256(code_verifier))`。
3. 打开授权页：

```text
https://your-router/oauth/authorize
  ?client_id=app_xxx
  &response_type=code
  &redirect_uri=http://127.0.0.1/callback
  &scope=gateway%3Ainvoke
  &state=<random>
  &code_challenge=<challenge>
  &code_challenge_method=S256
```

4. 用户同意后，回调地址收到 `code` 和 `state`。
5. 换令牌：

```bash
curl -X POST https://your-router/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code' \
  -d 'code=<code>' \
  -d 'client_id=app_xxx' \
  -d 'code_verifier=<verifier>'
```

**机密客户端（服务端 Web）**

- 创建时选择 `confidential`，保存返回的 `client_secret`（只显示一次）；
- 换令牌时使用 Basic 认证或表单字段：

```bash
curl -X POST https://your-router/oauth/token \
  -u 'app_xxx:<client_secret>' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code' \
  -d 'code=<code>' \
  -d 'redirect_uri=https://app.example.com/oauth/callback' \
  -d 'code_verifier=<verifier>'

# 或
curl -X POST https://your-router/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code' \
  -d 'client_id=app_xxx' \
  -d 'client_secret=<client_secret>' \
  -d 'code=<code>' \
  -d 'code_verifier=<verifier>'
```

**刷新**

```bash
curl -X POST https://your-router/oauth/token \
  -u 'app_xxx:<client_secret>' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=refresh_token' \
  -d 'refresh_token=<refresh_token>'
```

公共客户端刷新时不带 `client_secret`，但仍需带 `client_id`。刷新令牌每次轮换，旧 refresh 再次使用会吊销整条授权链。

**调用网关**

```bash
curl https://your-router/v1/chat/completions \
  -H "Authorization: Bearer crh_..." \
  -H 'Content-Type: application/json' \
  -d '{"model":"...","messages":[{"role":"user","content":"hello"}]}'
```

访问令牌绑定用户在授权时选择的 API Key；额度、模型授权、限流和签名设置都按该 Key 执行。

---

## 6. 旧版 GitHub 登录

- 路由：`app.use('/auth/github-legacy', require('./routes/oauth-github'))`。
- `server/routes/oauth-github.js` 对任何请求固定返回：

```json
{
  "error": "旧版 GitHub 登录已停用，请使用当前实例提供的登录方式",
  "type": "auth_method_disabled"
}
```

- 不做 code 交换、不写数据库；原因是旧路由绕过认证方式策略，并按邮箱关联已有账号，没有本地证明。
- 但仓库仍保留：
  - `config-loader.js` 的 `CR_GITHUB_CLIENT_ID` / `CR_GITHUB_CLIENT_SECRET` / `CR_GITHUB_REDIRECT_URI` 映射；
  - `.env.example` 的 GitHub OAuth 段；
  - `users.github_id` 列与唯一索引。
- `docs/ARCHITECTURE.md` 仍把 `server/routes/oauth.js` 描述为 GitHub OAuth，这是过时信息：该文件现在是自有 OAuth 授权服务。

---

## 7. 上游供应商 OAuth Token（不是用户登录）

这部分容易被误认为“OAuth 登录”，实际是管理员把上游账号的 token 导入供应商配置，供额度查询或调用使用：

- `providers` 表字段：`oauth_access_token`、`oauth_refresh_token`、`oauth_expires_at`、`oauth_account_id`、`oauth_issuer`、`oauth_client_id`（`server/scripts/init-db.js`）。
- 管理端导入：
  - `POST /api/admin/import-grok`：解析 Grok `auth.json`，写 token、账号 ID、issuer、client_id；
  - `POST /api/admin/import-codex`：解析 Codex `auth.json`（`tokens.access_token` / `refresh_token`），写 token 与账号 ID；
  - 两者都要求管理员权限，并先校验供应商存在。
- Token 刷新：
  - Codex：`https://auth.openai.com/oauth/token`（`server/utils/codex-usage.js`）；
  - Grok：issuer 的 `/oauth2/token` 或回退 `/oauth2/token`（`server/utils/grok-usage.js`）；
  - 额度查询：Codex `chatgpt.com/backend-api/wham/usage`，Claude `api.anthropic.com/api/oauth/usage`（`server/utils/cpa-usage.js`）。
- CrewRouter 不提供“点击登录上游账号”的 OAuth 流程；没有浏览器授权入口，均依赖导入或已有 token。

---

## 8. 配置速查

### 8.1 主 PassPort 登录

| 项 | 位置 |
| --- | --- |
| App ID | `passport.appId` / `CR_PASSPORT_APP_ID` |
| App Secret | `passport.appSecret` / `CR_PASSPORT_APP_SECRET` |
| Base URL | `passport.baseUrl`（默认 `https://passport.bloret.net`；无环境变量映射） |
| 回调来源 | `app.publicOrigin` 或请求 Host；`redirect_origin` 必须匹配 |
| 设备/会话 | `app.sessionSecret`；PostgreSQL `user_sessions` 表 |

### 8.2 Desktop Local PassPort

| 项 | 位置 |
| --- | --- |
| App ID | `CREWROUTER_DESKTOP_PASSPORT_APP_ID` |
| App Secret | `CREWROUTER_DESKTOP_PASSPORT_APP_SECRET`，或 `LocalServerManager` 的 `config.passport` |
| 本机请求令牌 | 每次启动生成 `CR_LOCAL_TOKEN`，经 `x-crewrouter-desktop-token` 传递 |
| 允许来源 | `http://127.0.0.1/localhost/[::1]:{port}` |

Desktop 的 PassPort 配置按整组选择，优先级为显式 `config.passport` → `options.env` → 进程环境变量；不会把不同来源的 App ID 和 Secret 混配。通用 `CR_PASSPORT_*` 不用于 Desktop Local。

### 8.3 飞书登录

| 项 | 位置 |
| --- | --- |
| App ID | `settings.feishu_login.appId` → `feishu.appId` → `CR_FEISHU_APP_ID` |
| App Secret | 同级 `appSecret` → `CR_FEISHU_APP_SECRET` |
| Tenant Key | 同级 `tenantKey` → `CR_FEISHU_TENANT_KEY` |
| 启用开关 | `settings.feishu_login.enabled`（config 回退时由 `appId` 决定） |
| 管理接口 | `GET/PUT /api/admin/feishu-login` |

### 8.4 商店 PassPort

| 项 | 位置 |
| --- | --- |
| App ID | `store.passport.appId` / `PASSPORT_APP_ID` / `CR_STORE_PASSPORT_APP_ID` |
| App Secret | 同级 `appSecret` / `PASSPORT_APP_SECRET` / `CR_STORE_PASSPORT_APP_SECRET` |
| Base URL | `store.passport.baseUrl` / `PASSPORT_BASE_URL` / `CR_STORE_PASSPORT_BASE_URL` |
| Redirect URI | `store.passport.redirectUri` / `PASSPORT_REDIRECT_URI` / `CR_STORE_PASSPORT_REDIRECT_URI` |
| 会话密钥 | `CR_STORE_SESSION_SECRET` → `PASSPORT_SESSION_SECRET` → `store.passport.sessionSecret` → `store.sessionSecret` → `app.sessionSecret` |
| 商店管理员白名单 | `store.passport.adminUsernames` |
| 挂载条件 | `app.demo === true` |

### 8.5 自有 OAuth 授权服务

| 项 | 位置 |
| --- | --- |
| Issuer | `config.oauth.issuer` / `OAUTH_ISSUER`；否则由请求协议与 Host 推导 |
| Access token 前缀 | `crh_` |
| Access 有效期 | 24 小时 |
| Refresh 有效期 | 30 天 |
| 授权码有效期 | 10 分钟，一次性 |
| 客户端来源 | 内置三个首方客户端 + `config.oauth.clients` + `oauth_clients` 表 |
| 客户端类型 | 公共（无密钥、强制 PKCE）/ 机密（client_secret） |
| 客户端认证 | `none`、`client_secret_basic`、`client_secret_post` |
| 回调 | 内置：任意 loopback 路径；注册：登记地址精确匹配，回环地址忽略端口 |
| 管理接口 | `/api/admin/oauth-clients`（仅管理员） |

---

## 9. 安全机制汇总

| 机制 | 位置 / 说明 |
| --- | --- |
| state 防 CSRF | PassPort 主登录用 session + 5 分钟 TTL + sessionID/origin/context；商店用签名 Cookie；OAuth 服务用 session 登录态 |
| state 一次性 | 主登录进程内 Map + session 删除；商店签名 Cookie + 进程内 Map；OAuth 授权码原子 `UPDATE ... WHERE used=FALSE` |
| PKCE | OAuth 服务强制 S256；Desktop 官方登录与 `/oauth/desktop-session` 也使用 PKCE |
| 令牌只存哈希 | `oauth_tokens.token_hash = SHA-256(token)`；明文只在签发响应出现一次 |
| refresh 轮换与重用检测 | 旧 refresh 再次使用或已有子代 refresh → 吊销整条链 |
| 吊销串行化 | advisory lock + 事务；上限 10,000 行；失败返回 503 |
| 客户端注册与认证 | 内置优先；配置/数据库客户端校验启用状态、类型、登记回调与 scope；机密客户端恒时比较 secret 哈希 |
| scope 校验 | `oauthBearer` 按端点要求 `events:report` 或 `gateway:invoke` |
| 复用 Key 策略 | OAuth 通过 `validateBoundApiKey` 走普通 Key 的额度、限流、模型授权、签名等全部检查 |
| 凭据校验 | 拒绝模板值、空白、控制字符、历史泄露 Secret；商店会话密钥至少 32 字节 |
| IdP 响应校验 | HTTPS、固定 DNS、禁止重定向、10 秒超时、64 KiB 上限、严格 JSON/UTF-8 |
| 企业隔离 | 飞书可选 `tenantKey` 校验；不一致拒绝登录 |
| 绑定本地证明 | 飞书绑定已有账号必须密码；启用 2FA 时还必须 TOTP；有尝试限额和并发条件更新 |
| Desktop Local 身份绑定 | 只允许唯一管理员、无其他认证身份的旧本地账号自动绑定；每请求复核 `passport_username` 与 `is_admin` |
| CSRF 边界 | `/oauth/token`、`/oauth/revoke` 按 token 鉴权豁免；`/oauth/desktop-session` 仅 JSON 且无浏览器头时豁免；其余 POST 走 Origin/CSRF token |
| 登录上报 | `server/utils/login-reporter.js` 在 PassPort / 飞书 / 密码登录成功后上报匿名事件，不含用户名/邮箱 |

---

## 10. 测试与审计记录

### 10.1 相关测试

| 测试 | 覆盖内容 |
| --- | --- |
| `server/scripts/test-oauth-bearer-policy.js` | OAuth access token 的 Key 所有人、禁用/过期、scope、额度、策略字段；OAuth 不进入 Key 缓存 |
| `server/scripts/test-oauth-clients.js` | 客户端注册表、回调 URI 策略、scope 子集、公共/机密客户端认证、配置与数据库客户端合并 |
| `server/scripts/test-oauth-clients-postgres.js` | 隔离 PostgreSQL：旧表升级、创建/列出/更新/轮换/删除、停用与轮换时吊销令牌 |
| `server/scripts/test-oauth-revocation-security.js` | 吊销链向上/向下遍历、跨用户隔离、环、10,000 行上限、并发轮换、503 语义、token 对事务回滚 |
| `server/scripts/test-passport-login-security.js` | state、回调、凭据缺失、认证模式、重定向来源 |
| `server/scripts/test-passport-credentials.js` | 凭据校验、模板/历史 Secret 拒绝、空环境变量行为 |
| `server/scripts/test-passport-verifier-security.js` | 提供方响应校验、超时、大小限制、URL 校验 |
| `server/scripts/test-passport-store-security.js` | 商店 state Cookie、回调、returnTo、配置隔离 |
| `server/scripts/test-store-session-security.js` | 商店会话 Cookie 签名、字段校验、密钥强度、过期/时钟偏差 |
| `server/scripts/test-feishu-binding-security.js` | 飞书绑定密码/TOTP、并发条件更新、限流、审计 |
| `server/scripts/test-local-passport.js` | Desktop Local token、state、绑定、取消、会话安全 |
| `server/scripts/test-auth-status-security.js` | `/auth/status` 不泄露凭据、认证策略、Desktop Local 的 PassPort-only |
| `server/scripts/test-csrf-boundaries.js` | CSRF 豁免边界 |
| `CrewRouter-Desktop/test/official-login.test.js` | Desktop 官方站 PKCE、回环回调、nonce 校验、Web Session 交换 |
| `CrewRouter-Desktop/test/local-passport.test.js` / `local-passport-interactions.js` | Desktop 本地 PassPort 窗口与导航约束 |
| `CrewRouter-Desktop/scripts/test-local-passport-flow.js` | 隔离数据库 + mock PassPort 的 Electron 新库/旧库登录验收 |

`package.json` 中可直接运行的相关脚本：

- `npm run test:oauth-bearer-policy`
- `npm run test:oauth-clients`
- `npm run test:oauth-clients-postgres`（需要本机 `initdb` / `pg_ctl`）
- `npm run test:passkey-security`（认证安全相关，含 PassKey 与登录会话）
- `npm run test:security-guards`（认证守卫相关）
- `npm run audit:blora-pages`（扫描包含 `oauth-consent` 在内的全部公开页面）

### 10.2 2026-10-25 安全审计结论（与 OAuth 登录相关）

- 旧版共享 PassPort Secret 已公开，代码已拒绝其 SHA-256 指纹；但上游是否撤销/轮换仍需应用所有者在 PassPort 侧完成。
- 商店独立身份 Cookie 的默认密钥曾可被用于伪造 `admin=true`；现已拒绝默认/模板/过短密钥，并要求 32–4096 字节。
- OAuth 中间件曾自行拼装身份，遗漏 Team 额度、用户 RPM/TPM、模型授权等策略；现已改为复用普通 Key 鉴权管线。
- 过期边界已修正：无效日期或 `expires_at <= now` 均拒绝。
- PassKey 登录曾绕过实例登录方式策略与本地 TOTP；已在 PassKey 的 options/verify 阶段检查实例认证方式，并在启用 2FA 时要求二次验证。
- 审计记录：`audit/security-passport-review-2026-10-25.md`、`audit/security-passkey-oauth-review-2026-10-25.md`。
- `security-audit.js` 现在也会统计 `oauth_clients`：非法客户端类型、机密客户端缺少密钥、scope/回调 JSON 形状异常；停用客户端数量作为信息项。

---

## 11. 现状中的不一致与注意事项

1. **文档过时**：`docs/ARCHITECTURE.md` 仍写 `server/routes/oauth.js` 是 GitHub OAuth；实际已是自有 OAuth 授权服务。
2. **GitHub 配置残留**：`.env.example` 和 `config-loader.js` 仍保留 `CR_GITHUB_*`，但 `/auth/github-legacy` 固定 410，且没有实例声明支持 GitHub 登录。
3. **`redirectCallbackHost` 未使用**：顶层 `passport.redirectCallbackHost` 仍出现在默认配置/示例，但主登录路由没有读取它。
4. **主 PassPort 的 `baseUrl` 无环境变量映射**：只能写 `config.json`；商店则支持 `PASSPORT_BASE_URL` / `CR_STORE_PASSPORT_BASE_URL`。
5. **商店仅在 Demo 模式可用**：`app.use('/store', createStoreRoutes())` 位于 `if (isDemo)` 内；非 demo 部署不会暴露商店 OAuth。
6. **商店 GET 交换会暴露 `app_secret` 到查询串**：这是历史契约；若提供方支持 POST，应优先迁移，但当前代码没有自动重试或回退。
7. **提供方是否保留 `redirect_uri` 上的 state 未验证**：代码同时把 state 放在 `state` 参数和回调 URI 中，兼容两种行为；跨实例的一次性仍依赖 IdP 的一次性 code。
8. **当前不支持的能力**：没有 RFC 7591 动态客户端注册（需管理员在后台或配置文件中登记）；CLI `cr login` 尚未接入 OAuth 授权码或设备码流程；不签发 `id_token`，不是 OpenID Connect；未为浏览器 SPA 配置 CORS，SPA 建议使用后端代理或原生客户端模式。
9. **`console:read` 可分配但尚无资源端点**：管理员可给客户端配置此 scope，用户也可在授权时批准；但当前没有 OAuth Bearer 保护的控制台读取端点，故 token 不会因此获得控制台 API 访问能力。新增端点前必须实现 scope 检查和测试。
10. **CLI 设备码支持**：CLI 使用内置 `crewrouter-cli` client 和 `gateway:invoke`，执行 `cr login --oauth`。批准页面选择的启用 API Key 会绑定到 token；CLI 会把 access token 单独存为 OAuth 凭据并仅发送到发现元数据声明的同一 origin。此 access token 当前不支持 refresh grant，过期后需重新授权。
10. **Desktop 官方登录与商店耦合**：`helper_login=1` 的实例列表按访问者 IP/设备弱关联，不要求商店 PassPort 会话；这是有意设计，但需要理解其隐私与冒用边界。

---

## 12. 快速定位

| 主题 | 文件 |
| --- | --- |
| 认证策略 / edition | `server/utils/instance-edition.js`、`server/utils/auth-mode.js`、`server/routes/auth.js` |
| PassPort 主登录 | `server/routes/passport-auth.js`、`server/utils/passport-login-state.js`、`server/utils/passport-verifier.js`、`server/utils/passport-credentials.js` |
| Desktop Local PassPort | `server/utils/local-passport.js`、`CrewRouter-Desktop/src/app/local-passport.js` |
| 飞书登录 | `server/routes/feishu.js`、`server/utils/feishu-config.js`、`public/pages/feishu-bind.html` |
| 商店 PassPort | `server/routes/store.js`、`server/store/passport.js`、`server/store/session.js`、`server/utils/passport-store-state.js` |
| 自有 OAuth 服务 | `server/routes/oauth.js`、`server/middleware/oauth-bearer.js` |
| OAuth 客户端注册表 | `server/utils/oauth-clients.js` |
| OAuth 客户端管理 API | `server/routes/admin-oauth-clients.js` |
| OAuth 确认页 | `public/pages/oauth-consent.html`、`public/js/oauth-consent.js` |
| OAuth 授权管理 UI | `public/js/app.js`（`loadAuthorizations`、`revokeAuthorization`） |
| OAuth 应用管理 UI | `public/pages/admin.html`、`public/js/admin.js`（`loadOAuthClients`、`openOAuthClientDialog`） |
| Desktop 官方站登录 | `CrewRouter-Desktop/src/app/official-login.js`、`CrewRouter-Desktop/src/redirect-flow.js`、`CrewRouter-Desktop/docs/remote-redirect.md` |
| 内部 OAuth | `server/utils/internal-oauth.js`、`server/routes/sessions-view.js` |
| 旧 GitHub 登录 | `server/routes/oauth-github.js` |
| 上游供应商 token | `server/routes/admin.js`（`import-grok` / `import-codex`）、`server/utils/codex-usage.js`、`server/utils/grok-usage.js`、`server/utils/cpa-usage.js` |
| 登录上报 | `server/utils/login-reporter.js` |
