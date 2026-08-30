# 第二轮独立代码审查结论

审查对象：当前工作树最新提交 `af8a9c0` 及其全部最新改动；对照 `/data/CrewRouter/.hermes/review.md` 中 Issue 1-8 逐项复核。

## Issue 1
- **Severity:** bug
- **Status:** open
- **File:** `/root/.grok/worktrees/data-crewrouter/subagent-01a04d3a-1436-7951-8063-5062c888ba77/server/routes/api.js:2764-2778,2944-2968,3366-3380,5433-5450,5537-5551,5732-5746,5799-5812,5974-5988`
- **Description:** `recordUsageAndDeduct` 现在在事务失败时抛异常，8 个调用点也确实执行了 `if (!usageResult.ok) throw ...`；但这并没有传播到响应层。8 个调用点都位于会吞掉异常的局部 `try/catch` 中，catch 只记录日志，随后仍继续原有成功流程：非流式路径继续 `res.json(...)`/`return`，流式路径则已完成上游流输出后正常结束。因此数据库 INSERT 或扣款失败时，请求仍可被客户端视为成功，usage/扣款仍然可能静默缺失。静态测试只验证了检查语句存在及其位于 `recordQuotaData` 前面，未验证外围 catch 是否阻断成功响应，故不能证明原问题已修复。对于已发送 header 的流式响应，确实不能回退为 HTTP 错误，但至少应发送协议级错误/终止标记并记录可靠补偿；对于尚未发送响应的非流式路径，应让异常到达外层错误处理并返回失败状态。
- **Suggestion:** 将计费失败从这些局部 catch 继续向上抛出，或在 catch 中明确设置失败响应/阻止成功响应；流式场景实现可被客户端识别的错误事件并配套可靠重试/补偿队列，避免已产生上游结果却永久漏计费。同步增强测试，注入 usage INSERT/扣款失败，分别断言流式和非流式响应行为。

## Issue 2
- **Severity:** suggestion
- **Status:** fixed
- **File:** `/root/.grok/worktrees/data-crewrouter/subagent-01a04d3a-1436-7951-8063-5062c888ba77/server/routes/user.js:1228-1244`; `/root/.grok/worktrees/data-crewrouter/subagent-01a04d3a-1436-7951-8063-5062c888ba77/public/js/app.js:7333-7340,7463-7465,7537-7542`
- **Description:** 服务端不再从数据库恢复或返回 token 原文，对不可恢复的 Key 返回 HTTP 410；前端调用统一检查 `!res.ok`，并读取错误 JSON 后提示用户。因此 HTTP 410 在当前调用方式下不会被当作成功配置处理，也不会产生空 token 配置。该问题的接口兼容性修复真实有效，但功能上历史 Key/新建 Key 在离开创建响应后均不能通过该接口重新生成配置，这是只存 hash 方案下的明确产品限制。

## Issue 3
- **Severity:** bug
- **Status:** open
- **File:** `/root/.grok/worktrees/data-crewrouter/subagent-01a04d3a-1436-7951-8063-5062c888ba77/server/utils/internal-oauth.js:6-43`
- **Description:** 进程级缓存和 pending Promise 合并能避免同进程并发重复签发，也会淘汰本地 TTL 过期项；但缓存命中完全绕过数据库的吊销状态检查。若该内部 access token 被 `/oauth/revoke`、管理端吊销，或被其它实例吊销，`getInternalAccessToken` 在本地缓存尚未过期时仍返回同一个已吊销 token，调用方会持续拿到无效凭证，直到 24 小时 TTL 到期。`issueInternalToken` 仅在重新签发时删除已吊销/过期行，不能修复缓存命中期间的吊销。多进程部署还会各自缓存并签发 token，pending 合并只在单进程有效。
- **Suggestion:** 缓存命中时以低成本查询/版本标记确认 token 仍未吊销未过期，或在内部调用收到 401 `token has been revoked` 时立即删除对应缓存并重试一次；若要求多进程合并，应把复用/签发放入数据库事务并使用 advisory lock/唯一约束，不能只依赖进程内 Map。必要时缩短缓存 TTL，并补充吊销后立即重新获取及多实例行为测试。

## Issue 4
- **Severity:** suggestion
- **Status:** wontfix
- **File:** `/root/.grok/worktrees/data-crewrouter/subagent-01a04d3a-1436-7951-8063-5062c888ba77/server/middleware/oauth-bearer.js:10-17,42-53`
- **Description:** 本地 SHA-256 实现未复用统一工具，但任务书明确要求不修改该中间件；当前 hash 结果兼容，未发现新的功能性问题。

## Issue 5
- **Severity:** bug
- **Status:** open
- **File:** `/root/.grok/worktrees/data-crewrouter/subagent-01a04d3a-1436-7951-8063-5062c888ba77/server/scripts/init-db.js:468-498`
- **Description:** 新增的旧表兼容分支把缺失的 `key_hash` 定义为 `VARCHAR(255) NOT NULL UNIQUE`，但该分支直接对已存在的 `api_keys` 表执行 `ALTER TABLE ... ADD COLUMN key_hash ...`。如果历史表已有数据，PostgreSQL 新增 NOT NULL 列没有默认值会因现有行包含 NULL 而失败；同时直接创建 UNIQUE 约束还可能因历史数据/已有 hash 冲突失败。该初始化路径没有先从 `key_value` 回填 hash、处理重复值、再加 NOT NULL/唯一约束，也没有事务回滚保护。因此“空库 DDL 一致”已修复，但“兼容旧表补列”并不安全，可能令 init-db 在升级库上失败。
- **Suggestion:** 对旧表采用分阶段迁移：先以可空方式 ADD COLUMN，按原始 `key_value` 回填 SHA-256，校验并处理重复 hash，再删除/清空明文，最后设置 NOT NULL 并创建唯一索引；整个迁移放入事务，并对已存在列分别检查约束而不是在 ADD COLUMN 类型字符串中直接附加约束。若迁移脚本负责该转换，则 init-db 应调用/复用同一套安全迁移逻辑。

## Issue 6
- **Severity:** suggestion
- **Status:** fixed
- **File:** `/root/.grok/worktrees/data-crewrouter/subagent-01a04d3a-1436-7951-8063-5062c888ba77/scripts/migrate-api-keys-hash.js:7-45`
- **Description:** `--apply` 现在在单一事务中重新锁定待迁移行，重复 hash 会抛错并整体回滚；更新语句也只处理仍有明文的行。dry-run 默认只读。未发现原问题所述的部分提交漏洞。脚本仍缺少真实数据库运行验证，但这属于验证覆盖不足而非已证实的新逻辑 bug。

## Issue 7
- **Severity:** nit
- **Status:** fixed
- **File:** `/root/.grok/worktrees/data-crewrouter/subagent-01a04d3a-1436-7951-8063-5062c888ba77/.hermes/implementation-summary.md:39-50`; `/root/.grok/worktrees/data-crewrouter/subagent-01a04d3a-1436-7951-8063-5062c888ba77/server/scripts/test-financial-usage-static.js:1-19`
- **Description:** 摘要已明确区分静态检查通过与数据库/端到端未验证。静态脚本实际运行通过，并确认 8 个调用点、参数占位符数量和失败检查存在；但其正则/字符串位置断言不能证明运行时响应流程正确，尤其不能覆盖 Issue 1 的外围 catch 吞错行为。因此原“验证记录表述不清”已修复，测试覆盖边界仍作为 Issue 1 的一部分保留。

## Issue 8
- **Severity:** suggestion
- **Status:** fixed
- **File:** `/root/.grok/worktrees/data-crewrouter/subagent-01a04d3a-1436-7951-8063-5062c888ba77/server/scripts/test-financial-usage-static.js:3-18`
- **Description:** 静态测试确实覆盖 8 个 `recordUsageAndDeduct` 点位、`userId`/`pointsToDeduct` 参数、SQL 占位符与值数组数量，以及 `usageResult.ok` 检查顺序。未发现该测试本身会漏掉这几类静态结构变化；但它不能替代请求级失败传播测试。

## 结论

本轮发现 **3 个 open issue**：
1. usage 失败仍被 8 个局部 catch 吞掉，非流式仍可能成功返回，流式缺少可识别错误/补偿路径；
2. internal-oauth 进程缓存不感知 token 吊销，吊销后最长 24 小时持续返回无效 token；
3. init-db 对已有数据的旧表补 `key_hash NOT NULL UNIQUE` 不具备安全迁移流程。

已执行 `node server/scripts/test-financial-usage-static.js`，结果通过；关键 JS 文件语法检查通过。由于当前环境未连接数据库且缺少可用 `pg`/测试库，未能实测迁移、吊销、并发及端到端流式/非流式响应。
## 本轮修复响应

- Issue 1：8 个计费局部 catch 对 billingFailure 返回 HTTP 500（未发 header）或销毁流连接（已发 header），不再继续成功响应；静态测试覆盖 8 个外围 catch。
- Issue 3：缓存命中前低成本查询 oauth_tokens，感知 revoked/expired；缓存 TTL 缩短至 5 分钟，并发签发继续合并。
- Issue 5：init-db 对旧表采用可空补列、hash 回填、重复检查、清空明文、最后设置约束和唯一索引，初始化整体事务回滚。
