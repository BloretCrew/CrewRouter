# CrewRouter 插件系统第三期：插件商店（demo 模式）

- 日期：2026-08-23
- 需求方：Detrital
- 参考实现：`/data/bloret-launcher-website/`（launcher.bloret.net/apps），源码含 `server.js`、`lib/passport.js`、`lib/session.js`、`lib/plugins-store.js`、`lib/db.js`、`apps/apps.js`、`OauthAPI.md`。
- 前置：一期 `1dbac06`、二期 `f0ac09b` 已交付（插件框架/管理系统）。

---

## 1. 背景与目标

CrewRouter 需要一个**插件商店**（插件市场），让用户浏览/提交/评分插件，管理员审核上架。本期做成 **demo 模式**：商店作为独立功能页接入现有 PostgreSQL，但**逻辑隔离于网关核心**——只用自己的一套 `plugin_store_*` 表，绝不触碰 `plugins` / `plugin_data` / `providers` / `api_keys` 等系统表。

商店的身份体系独立：使用 **Bloret PassPort OAuth** 登录，登录用户只获得**商店身份**（提交者/评分者），复用 PassPort 的 `admin` 字段或本地白名单判定管理员，**不**写入 CrewRouter 的会话权限体系。

## 2. 「demo 模式」的定义与边界

- 商店是 **CrewRouter 的新功能页**（管理后台/控制台均可入口），独立于网关核心：网关行为、providers、api_keys 等系统表一律不改动。
- 商店用自有 `plugin_store_*` 前缀多表，连接**现有** PostgreSQL（复用 `server/models/database.js` 的 `pool`），与 `plugins` / `plugin_data` 逻辑隔离。
- 只做**增量**建表（`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`），不破坏现有结构；商店表为空时可写入少量演示数据（可通过配置关闭）。
- OAuth 登录用户仅获得商店身份（提交者/评分者），**不影响** CrewRouter 自身 session 权限体系；管理员判定复用 PassPort `admin` 字段或 CrewRouter 本地管理员白名单。
- 未接 PassPort 或配置缺失时**优雅降级**：商店可浏览；登录/提交/评分接口返回「未配置」提示，前端展示弱化引导。

### 关键隔离点
1. **会话隔离**：商店复用参考实现的做法，使用**独立的签名 cookie**（HMAC-SHA256，cookie 名 `bl_store_session`），不写 `req.session`、不建 `user_sessions` 行、不依赖 express-session。
2. **表隔离**：所有读写仅限 `plugin_store_*` 三张表；与 `plugins` / `plugin_data` 无任何 JOIN 或外键。
3. **路由隔离**：商店路由统一挂载于 `/store` 前缀（页面 `/store`，API `/store/api/*`，OAuth `/store/auth/*`），不落到 `/v1` 网关代理。

## 3. 架构

```
浏览器
 ├─ GET /store                         → public/pages/store.html（SPA）
 │      └─ public/js/store.js          渲染 列表/详情/提交/我的/审核，调用 /store/api/*
 ├─ /store/auth/login                  → 302 到 passport.bloret.net/app/oauth
 ├─ /store/auth/callback?code=...      → /app/verify 换用户信息 → 写独立签名 cookie → 302 回商店
 ├─ /store/auth/logout                 → 清 cookie
 └─ /store/api/*                       → REST（列表/详情/评分/提交/审核/install-click/me）
```

服务端模块（`server/store/`）：
- `passport.js`：`getPassportConfig`（读 config.json `store.passport` + 环境变量）、`buildAuthorizeUrl`、`verifyCode`、`resolveRedirectUri`、`isAdminUser`。
- `session.js`：`encodeSession`/`decodeSession`/`setSessionCookie`/`readSessionFromReq`/`clearSessionCookie`（HMAC-SHA256，cookie 名 `bl_store_session`）。
- `store.js`：`plugin_store_*` 存储层（建表、插件 CRUD、评分 crud、审核、sha256 校验、`bloret://plugin/install` 深链）。
- `server/routes/store.js`：`createStoreRoutes()`，挂 OAuth 三路由 + `me` + 插件 API。

## 4. 表设计（`plugin_store_*` 前缀，独立于系统表）

```sql
CREATE TABLE IF NOT EXISTS plugin_store_plugins (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  version          TEXT NOT NULL,
  author           TEXT NOT NULL DEFAULT '',
  author_username  TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  long_description TEXT NOT NULL DEFAULT '',
  url              TEXT NOT NULL DEFAULT '',
  icon             TEXT NOT NULL DEFAULT '',
  download         TEXT NOT NULL,
  sha256           TEXT NOT NULL DEFAULT '',
  permissions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags             JSONB NOT NULL DEFAULT '[]'::jsonb,
  screenshots      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected')),
  reject_reason    TEXT NOT NULL DEFAULT '',
  install_count    INTEGER NOT NULL DEFAULT 0,
  rating_avg       NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count     INTEGER NOT NULL DEFAULT 0,
  featured         BOOLEAN NOT NULL DEFAULT FALSE,
  pending_update   JSONB NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at      TIMESTAMPTZ NULL,
  reviewed_by      TEXT NULL
);
CREATE INDEX ... plugin_store_plugins(status/author_username/updated_at/tags GIN)

CREATE TABLE IF NOT EXISTS plugin_store_ratings (
  plugin_id  TEXT NOT NULL REFERENCES plugin_store_plugins(id) ON DELETE CASCADE,
  username   TEXT NOT NULL,
  stars      SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plugin_id, username)
);

CREATE TABLE IF NOT EXISTS plugin_store_rating_replies (
  id             BIGSERIAL PRIMARY KEY,
  plugin_id      TEXT NOT NULL,
  rating_username TEXT NOT NULL,
  username       TEXT NOT NULL,
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (plugin_id, rating_username)
    REFERENCES plugin_store_ratings (plugin_id, username) ON DELETE CASCADE
);
```

校验规则：插件 id `^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$`（长度 3–128）；`download`/`url` 必须是 `https://`；`sha256` 64 位十六进制；评分 1–5；评论/回复 ≤ 500 字。

## 5. API（全部挂 `/store`，前缀 `/store/api`）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/store/api/me` | 公开 | 返回 `{loggedIn, user, config}`；未登录/未配置返回 `loggedIn:false` |
| GET | `/store/api/plugins` | 公开 | 列表；`scope=public|mine|admin`、`q`、`tag`、`sort=rating|installs|updated` |
| GET | `/store/api/plugins/:id` | 公开 | 详情；`?include=related` 返回相关插件 |
| POST | `/store/api/plugins` | 登录 | 提交插件（初始 `pending`） |
| PATCH | `/store/api/plugins/:id` | 作者/管理员 | 更新；已上架作者编辑进入 `pending_update` |
| POST | `/store/api/plugins/:id/review` | 管理员 | `action=approve|reject`，可带 `reason` |
| POST | `/store/api/plugins/:id/install-click` | 公开 | 累加安装计数 |
| GET | `/store/api/plugins/:id/install-link` | 公开 | 生成 `bloret://plugin/install` 深链 + sha256 |
| GET | `/store/api/plugins/:id/ratings` | 公开 | 评分分布 + 列表 |
| PUT | `/store/api/plugins/:id/ratings` | 登录 | 评分（1–5） |
| DELETE | `/store/api/plugins/:id/ratings` | 登录 | 删除评分 |
| POST | `/store/api/plugins/:id/ratings/:user/replies` | 登录 | 回复评分 |
| DELETE | `/store/api/plugins/:id/ratings/replies/:replyId` | 作者/管理员 | 删除回复 |

OAuth（`/store/auth`）：`login`（302 授权）、`callback`（验 code 写 cookie）、`logout`。

未配置 PassPort 时：`me` 返回 `config.configured:false`；`login` 返回引导页/302 到商店；涉及登录的写接口（提交/评分/审核）返回 503「未配置 PassPort」。

## 6. 前端（`public/pages/store.html` + `public/js/store.js`）

- 复用 `themes.css` / `main.css`，加少量 `store.css`。
- 语言切换（zh/en）沿用 `public/js/i18n.js`；文案用 `data-i18n` / `t()`。
- SPA 视图：列表（搜索/标签/排序/卡片 + 登录按钮 + 「提交」「我的」「审核」入口）、详情（含截图、评分分布、评分表单、安装深链）、提交表单、我的插件、管理员审核。
- 未配置 PassPort：顶部弱提示，browse 正常；登录/提交/评分按钮触发提示。

## 7. 安全

- 商店会话 cookie：`httpOnly`、`sameSite=lax`、HMAC-SHA256 签名、`secure` 跟随 HTTPS；不携带 apptoken。
- `verifyCode` 仅在后端执行；`app_secret` 永不返回前端。
- `state`（base64url 的 `{return_to}`）解析后仅接受以 `/` 开头、且非 `//` 的相对路径，防开放重定向。
- 所有写接口做登录/作者/管理员校验；`download`/`url`/`icon`/截图做 `https://` 校验；sha256 做格式校验。
- 参数化查询（pg `$1`）；无拼接 SQL（除白名单排序字段映射）。
- 前端渲染 `escapeHtml` 防 XSS；`config.json` 不暴露。

## 8. 分期步骤

1. 写计划文件并 commit（docs）。
2. 后端：`store/passport.js`、`store/session.js`、`store/store.js`、`routes/store.js`；在 `server/index.js` 挂 `/store` 页面与 `/store/*` 路由。
3. 配置：`config.json` / `config.example.json` 增加 `store.passport` 段落。
4. 前端：`store.html` + `store.js` + `store.css`；管理后台/控制台侧边栏加「插件商店」入口。
5. i18n：补充 `lang/zh.json` / `lang/en.json` 商店文案。
6. 验证：`node --check`；启动服务；`curl` 验证各接口；清理测试数据。
7. commit（feat）。

## 9. 验证方式

- `node --check` 通过所有新增 JS。
- 启动 `node server/index.js`（连接现有 PG），日志显示商店表就绪。
- `curl` 接口级验证：`GET /store/api/me`（未配置 → `configured:false`）、`GET /store/api/plugins`（浏览）、`POST` 提交（未登录 → 503/401）、登录态写接口（用本地 mock OAuth 或跳过 external 校验）、`PUT ratings`、`review`（admin）。
- 确认系统表 `plugins` / `plugins_data` 行数与结构未变（`SELECT count(*)` 前后一致）。
- 浏览器：`/store` 页面可浏览、切换语言、提交/评分/审核流程（依赖 PassPort 配置时以「未配置」降级提示验证）。

## 10. 测试数据清理

结束验证后删除 `plugin_store_*` 三张表内的验证期间写入的行（删除演示种子与手工验证数据），保留表结构（或按需求删除整组表）。系统表不动。
