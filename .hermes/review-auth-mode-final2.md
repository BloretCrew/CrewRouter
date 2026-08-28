# CrewRouter 账号系统双模式最终复审

- 审查对象：`ffa3b92f0bbd72195401179a34ed14cef196077a9`（`fix: secure invite origin configuration`）
- 对照任务书：`/data/CrewRouter/.hermes/plans/2026-08-28_auth_mode_impl_task.md`
- 对照此前复审：`review-auth-mode.md`、`review-auth-mode-round2.md`
- 审查范围：仅复核任务书范围内的此前问题修复状态，以及 `ffa3b92` 可能引入的回归；未修改代码。

## Open issues

**0 issues。**

## 复核结论

### 1. `app.publicOrigin` / 邀请链接 origin 安全：已修复

- `server/routes/auth-invites.js:9-20` 优先读取显式配置 `config.app.publicOrigin`，其次使用主认证 `config.passport.redirectCallbackHost` 的 origin。
- 配置值必须解析为 HTTPS；返回 `url.origin`，不会把回调路径拼入邀请链接。
- 未配置时不再直接信任任意 `Host`：仅接受严格的域名格式、`localhost` 及可选端口，并统一生成 HTTPS URL。
- `server/routes/auth-invites.js:24-35` 生成链接时使用受控 origin，并通过 `encodeURIComponent` 编码 token；token 仍只以 SHA-256 摘要存储。
- 前序修复的首页 token 严格校验、`sessionStorage` 传递、`replaceState` 清理地址栏及回调端服务端 session 绑定仍保留，未发现该提交造成回归。

### 2. `config.example.json` 顶层 Passport 配置：已修复

- `config.example.json:22-26` 已增加顶层 `passport`，包含主认证实际读取的 `appId`、`appSecret`、`redirectCallbackHost`。
- `config.example.json:91-105` 保留 `store.passport`，并通过 `store.passportNote` 明确其仅用于插件商店 OAuth，未混淆两套配置。
- `server/config-loader.js:27-34,50-54,87-112` 已提供顶层默认值和 `CR_APP_PUBLIC_ORIGIN`、`CR_PASSPORT_*` 环境变量映射；`passport-auth.js` 读取路径与样例一致。

### 3. 回归检查

- `config.example.json` 可被 Node 正常解析，且包含所需的 `app.publicOrigin` 与顶层 `passport` 字段。
- `node --check server/routes/auth-invites.js`、`server/config-loader.js`、`server/routes/passport-auth.js` 通过。
- `git diff --check ffa3b92^ ffa3b92` 通过。
- `node server/scripts/test-auth-mode.js` 未能执行：当前工作树缺少依赖 `pg`（`MODULE_NOT_FOUND`）。因此未完成真实 PostgreSQL、session store、OAuth provider 和并发集成测试；这属于验证环境限制，不构成基于静态复审可确认的 open issue。

## 最终结论

`ffa3b92` 已闭环此前第二轮提出的邀请链接 origin 信任和顶层 Passport 配置样例问题。在指定任务书范围内未发现新的安全问题或回归，**0 issues**。
