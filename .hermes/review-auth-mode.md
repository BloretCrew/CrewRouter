# Auth Mode 实现审查

提交：`efa1563b2bf55567a3365cd077928dcfe112c1de`  
任务书：`/data/CrewRouter/.hermes/plans/2026-08-28_auth_mode_impl_task.md`

## Issues

### 1
- **Severity:** bug
- **File:** `server/utils/auth-mode.js:16`、`server/index.js:412`
- **Description:** `settings.value` 的数据库类型是 `JSONB`，但 `setAuthMode()` 和迁移回填分别以未 JSON 编码的 `feishu`/`passport` 参数写入。PostgreSQL JSONB 输入要求合法 JSON（字符串应为 `"feishu"`），因此 OOBE 调用 `/api/setup/mode` 会因 `invalid input syntax for type json` 失败；已部署实例的回填也会在同一迁移函数中失败。该问题直接阻断模式选择，并使兼容回填不成立。
- **Suggestion:** 写入时使用 `JSON.stringify(mode)`；读取时兼容 pg 返回的 JSON 字符串值，并增加针对真实 JSONB settings 表的迁移/OOBE 集成测试。
- **Status:** open

### 2
- **Severity:** bug
- **File:** `public/pages/index.html:135-136`、`server/routes/passport-auth.js:23-26,29-30`
- **Description:** 管理员生成的邀请链接带在首页查询参数 `/?invite=...`，但 PassPort 登录按钮固定跳转 `/auth/passport`，没有把 `invite` 放入 OAuth state/session；回调只从 `req.query.invite` 读取。用户从邀请链接点击登录后，OAuth 回调通常没有 invite，所有尚不存在的 PassPort 用户都会被 403 拒绝，邀请注册主流程无法完成。
- **Suggestion:** 入口读取并严格限制邀请 token 后，将其与随机 state 一起写入 session（或绑定到服务器端 state 记录），回调只使用服务器端保存的 invite；同时在首页处理后清理地址栏中的明文 token，避免继续暴露在历史记录/Referer 中。
- **Status:** open

### 3
- **Severity:** bug
- **File:** `server/routes/passport-auth.js:47-60`
- **Description:** 邀请校验、创建用户、标记邀请已使用分属多个非事务查询。两个并发回调可同时通过 `validateInvite()`，各自插入用户，随后都把同一个邀请标记为 used，违反一次性 token 生命周期；创建用户失败或进程在标记前退出时也会留下已创建但未消费邀请的状态。
- **Suggestion:** 使用同一数据库 client 开启事务，在事务内以 `SELECT ... FOR UPDATE` 锁定邀请，并通过 `UPDATE ... WHERE used = FALSE AND expires_at > ... RETURNING id` 原子消费；创建用户与消费邀请一起提交，失败整体回滚。
- **Status:** open

### 4
- **Severity:** bug
- **File:** `server/routes/passport-auth.js:53-58`
- **Description:** 首人管理员判定是先 `COUNT(*)` 再 INSERT，没有事务锁或数据库约束。两个首次 PassPort 回调并发时都可能看到管理员数为 0，两个用户都会成为管理员；这同时绕过了“首人即管理员”的唯一性语义。
- **Suggestion:** 将判定和插入放在事务中并锁定管理员引导资源/使用 advisory lock，或采用数据库层可证明只有一个首个管理员的约束与冲突处理；补充并发测试。
- **Status:** open

### 5
- **Severity:** bug
- **File:** `server/routes/passport-auth.js:49-57`
- **Description:** 用户名冲突只尝试一次 `${username}_pp`。若原用户名和该后缀都已存在，INSERT 会触发 `users.username` 唯一约束并返回 502，合法邀请用户无法注册。另一个兼容问题是直接写入 `data.email`；`users.email` 仍是全局 UNIQUE，PassPort 用户使用已存在邮箱时同样会失败，和独立 `passport_username` 命名空间设计不一致。
- **Suggestion:** 在事务中循环生成并检查唯一用户名（必要时追加递增后缀），并明确邮箱冲突策略：复用已有账号/置 null/生成本地占位邮箱，避免未经设计地撞击全局邮箱唯一约束；对 Passport 标识做长度和规范化校验。
- **Status:** open

### 6
- **Severity:** bug
- **File:** `server/routes/passport-auth.js:60-67`
- **Description:** 任务书要求新 PassPort 用户复用飞书注册的默认 Key/Team/Group 播种逻辑。当前实现只播种提示词、把用户加入已有默认 Team、设置默认 Group；没有创建默认 API Key，也没有创建每用户个人 Team。新用户因此缺少飞书新用户已有的默认能力，且“Team”播种行为不一致。
- **Suggestion:** 抽取并复用飞书新用户的完整播种流程（默认 Key、个人 Team 及 user_teams、默认组、提示词），每个非关键播种步骤用明确的 savepoint/独立错误处理，避免半成品登录状态。
- **Status:** open

### 7
- **Severity:** bug
- **File:** `server/routes/setup.js:49-53,73-78`
- **Description:** `/api/setup/admin` 没有要求 `auth_mode` 已被选择。攻击者/误操作可以直接 POST 创建管理员并写入 `setup_complete`，绕过 OOBE 模式选择；随后 `getAuthMode()` 默认返回飞书，导致实际认证模式与用户在 OOBE 中看到的流程不一致，也使“必须先选模式”无法成立。
- **Suggestion:** `/setup/admin` 在事务内要求存在且为合法的 `auth_mode`；同时让 `/setup/mode` 与设置完成动作在同一事务/锁内协调，防止模式选择和 setup 完成竞态。
- **Status:** open

### 8
- **Severity:** bug
- **File:** `server/utils/auth-mode.js:10-17`、`server/routes/setup.js:45-52`
- **Description:** “检查是否冻结”与 upsert 是两个独立查询，两个并发 `/setup/mode` 请求都可在 `setup_complete` 写入前通过检查并相互覆盖模式。模式冻结依赖业务时序而非原子数据库操作，不能保证选择后不可改；同时已有 `auth_mode` 值未验证时，`/setup/status` 会原样返回该值，前端会误判为已选。
- **Suggestion:** 在事务中锁定 settings 的 setup 状态/使用 advisory lock，并以条件写入（仅 `setup_complete` 不存在且 auth_mode 未确定时允许）保证只成功一次；status 对存储值做合法枚举校验并按 JSONB 语义返回。
- **Status:** open

### 9
- **Severity:** suggestion
- **File:** `server/routes/passport-auth.js:13-15,20-26`
- **Description:** 回调地址在未配置时根据 `req.protocol` 和 `Host` 头拼接。虽然当前固定使用 `https` scheme fallback，但反向代理配置不当或 Host 未受信任时仍可能把攻击者控制的 Host 注册到 OAuth 授权请求，造成回调错配；PassPort base URL 也被硬编码，无法复用已有 `server/store/passport.js` 的配置与错误处理。
- **Suggestion:** 使用受信任的显式 `redirectCallbackHost`（并校验为 HTTPS、允许路径），或使用受信任代理配置后的 canonical origin；复用统一 PassPort helper/base URL，并对 verify 非 JSON 响应、超时和上游错误做一致处理。
- **Status:** open

### 10
- **Severity:** suggestion
- **File:** `server/routes/passport-auth.js:35-41`
- **Description:** OAuth verify 返回的 `apptoken` 被完全丢弃。任务书明确要求完成 code/token 流程并取得 `apptoken`；当前实现仅依赖 username，未验证 token 字段存在、有效性或其响应契约，接口变更时可能把不完整响应当作成功登录。
- **Suggestion:** 按 PassPort 实际响应 schema 明确校验 username 与 apptoken（如该 token 是登录必需凭据则安全存储/使用，绝不写日志），并覆盖成功、错误 JSON、非 JSON、超时测试。
- **Status:** open

### 11
- **Severity:** suggestion
- **File:** `public/js/admin.js:178-186`
- **Description:** 管理后台邀请面板的 `render()`、生成和撤销请求均不检查 HTTP 状态；401/403/500 的 JSON 会被静默当成空列表或继续刷新，失败原因对管理员不可见。生成响应中的 token 只显示 URL，且没有任务书要求的复制操作；`innerHTML` 直接拼接数据库返回的 status/date，扩展字段后存在 XSS 风险。
- **Suggestion:** 统一检查 `response.ok` 并显示错误，提供复制按钮；使用 DOM textContent 创建行而非拼接 innerHTML，对日期/status 做白名单格式化。
- **Status:** open

### 12
- **Severity:** bug
- **File:** `server/routes/passport-auth.js:69-71`
- **Description:** Passport OAuth 登录设置的 session 用户对象与飞书路径不完全一致：没有 `needsPasswordSetup`（这点本身可接受，因为没有密码），但也没有刷新数据库中后续更新的用户字段；更关键的是入口直接修改 session 后立即 redirect，未像飞书入口一样显式 `req.session.save()` 保存 state。对于数据库 session store/异步 session 持久化配置，回调可能收不到 state，导致随机出现 state invalid。
- **Suggestion:** OAuth 入口在重定向前显式 `req.session.save()`；回调登录后继续显式保存并处理错误。用实际生产 session store 做跨请求 state 测试，而不是只测内存 session。
- **Status:** open

## 结论

本提交存在多个会阻断 PassPort OOBE/邀请注册的高影响问题，且邀请一次性消费与首人管理员判定存在明确竞态；不建议合并。飞书路由文件本身未被修改，但新增全局迁移/OOBE 路径的 JSONB 写入错误会影响既有飞书实例的兼容回填，需先修复后再进行飞书回归验证。

未修改任何代码文件；仅写入本审查报告。
