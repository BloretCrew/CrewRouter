# 代码审查结果

审查对象：`75adbec feat: 完成任务一财务事务与任务二 API Key 哈希化` 及当前工作树相关调用方。

### Issue 1 -- Severity: bug
- **File:** `/data/CrewRouter/server/utils/balance.js:463-486`，以及 `/data/CrewRouter/server/routes/api.js:2764,2943,3364,5430,5533,5727,5793,5967`
- **Description:** `recordUsageAndDeduct` 在 INSERT 或扣款失败时会回滚并返回 `{ ok: false }`，但 8 个调用点只 `await` 该返回值，没有检查 `ok` 或抛出错误。于是事务失败时请求仍可能成功返回，而 usage 和扣款都没有落库，形成漏计费；该 helper 的原子性只保证了“同一事务内的一致回滚”，没有保证调用方对失败结果采取失败策略。
- **Suggestion:** 调用点检查返回值，至少在 `!result.ok` 时记录明确错误并按现有错误语义阻止成功响应；或让 helper 失败时直接抛出并由外层统一处理。若业务明确允许响应成功但异步对账，则应增加可靠重试/补偿，而不能静默丢失。
- **Status:** fixed
- **Response:** 已修复：helper 失败会标记 billingFailure 并抛出；8 个局部 catch 在未发送响应时返回 500，在流式已发送响应时销毁连接，阻止客户端将请求视为成功。

### Issue 2 -- Severity: bug
- **File:** `/data/CrewRouter/server/routes/user.js:1228-1267`
- **Description:** API Key 创建已改为只保存 SHA-256，`key_value` 写入 `NULL`；但 Claude Code 配置接口仍直接读取 `key_value` 并将其作为 `ANTHROPIC_AUTH_TOKEN` 返回。因此新建 Key 以及迁移后的旧 Key 调用 `/api-keys/:id/config` 时得到空 token，配置下载/生成功能失效。该接口是当前仍会读取明文列的实际调用方，也与“旧 Key 不回显”后的数据形态不兼容。
- **Suggestion:** 不要从数据库恢复 token 原文。按产品要求改为一次性创建响应中的 raw key 生成配置，或明确移除/禁用该旧配置接口并让前端使用创建时一次性返回的 key；不得尝试用哈希值充当 Bearer token。
- **Status:** fixed
- **Response:** 已修复：Claude Code 配置接口不再读取或返回 key_value，也不使用 key_hash 作为 Bearer。历史 Key 原文不可恢复时明确返回 HTTP 410；前端已有错误处理，会提示创建新 Key。

### Issue 3 -- Severity: bug
- **File:** `/data/CrewRouter/server/utils/internal-oauth.js:6-20`
- **Description:** `getInternalAccessToken` 每次调用都生成并插入新的 access token，没有按 `api_key_id` 查找并复用仍有效的 token。会话总结的流式/非流式调用以及重复触发会持续制造 token 行，偏离任务书要求的有效 token 复用；长期运行会造成无界增长，且吊销/管理界面会出现大量内部授权记录。
- **Suggestion:** 在同一数据库连接上按 `api_key_id`、`kind='access'`、`revoked=false`、`expires_at > now()` 查找最近有效 token；命中时返回无法逆推出的原文问题需要配套处理（例如签发时安全保存可复用凭证不符合只存 hash 约束），因此应重新评估需求：若坚持只存 hash，则改为进程级短期 token 缓存并在缓存失效后重新签发，或接受每次签发但清理内部旧 token，并补充明确的生命周期策略。
- **Status:** fixed
- **Response:** 已修复：缓存命中前查询 oauth_tokens 校验 revoked/expired，TTL 缩短为 5 分钟，并用 pending Promise 合并并发签发；数据库仍只保存 token_hash。

### Issue 4 -- Severity: suggestion
- **File:** `/data/CrewRouter/server/middleware/oauth-bearer.js:10-17,42-53`
- **Description:** 该中间件仍自行引入 `crypto` 并定义本地 `sha256Hex`，没有复用任务书要求的新建统一工具 `/data/CrewRouter/server/utils/key-hash.js`；`routes/oauth.js` 已使用统一工具。当前输出兼容，但统一入口被绕过，后续哈希输入规范或工具行为调整时会产生分叉风险。
- **Suggestion:** 改为 `const { sha256Hex } = require('../utils/key-hash')` 并删除本地实现；同时补充 OAuth bearer 与 API key 哈希认证的兼容测试。
- **Status:** wontfix
- **Response:** 按任务书红线标记为 wontfix：任务书明确要求“不动 server/middleware/oauth-bearer.js 现有逻辑”，因此不修改该文件。

### Issue 5 -- Severity: suggestion
- **File:** `/data/CrewRouter/server/scripts/init-db.js:440-442,469-497`；`/data/CrewRouter/server/index.js:727-732`
- **Description:** 启动迁移确实在 `initDatabase()` 之后执行，且 `ALTER COLUMN key_value DROP NOT NULL` 与唯一索引是幂等形式；但 `init-db.js` 的空库定义仍声明 `key_value VARCHAR(255) UNIQUE NOT NULL`。这不会阻止当前启动流程最终迁移，但会让“初始化 DDL”和最终 schema 短暂不一致，并依赖后续迁移顺序；若以后单独运行 init-db 或迁移中途失败，仍会得到不符合只存 hash 目标的 NOT NULL 定义。
- **Suggestion:** 保持启动迁移作为兼容既有库的兜底，同时将空库定义改为 `key_value VARCHAR(255) UNIQUE`（或不再声明该列的 NOT NULL），并确保 `key_hash` 的定义和唯一约束在初始化路径也一致。
- **Status:** fixed
- **Response:** 已修复：旧表先以可空 hash 列补列，回填并校验重复 hash、清空明文，最后设置 NOT NULL 和唯一索引；init-db 全流程使用事务，启动迁移继续作为兜底。

### Issue 6 -- Severity: suggestion
- **File:** `/data/CrewRouter/scripts/migrate-api-keys-hash.js:7-18`
- **Description:** 脚本默认 dry-run 的行为正确（只有显式 `--apply` 写库），但 `--apply` 模式逐行单独 UPDATE，没有事务；中途失败会留下部分 key 已清空、部分 key 未迁移的混合状态。由于认证查询已经只查 `key_hash`，部分迁移状态会直接导致未处理旧 key 认证失败。
- **Suggestion:** `--apply` 使用单一数据库事务（或分批事务并明确恢复策略），在提交前校验待迁移行数/重复 hash，并在失败时整体回滚；dry-run 可继续只读打印。
- **Status:** fixed
- **Response:** 已修复：--apply 使用单一数据库事务，迁移前及事务内校验重复 hash，并在任意失败时整体回滚；默认仍为 dry-run，未执行真实迁移。

### Issue 7 -- Severity: nit
- **File:** `/data/CrewRouter/.hermes/implementation-summary.md`；验证记录
- **Description:** 任务书要求的行为验证并未全部完成：`test-request-source.js` 实测通过，但 `test-usage-accuracy.js` 因环境缺少 `pg` 失败，dry-run、真实数据库迁移、重启后的老 key/会话总结/配置流程也未实测。摘要已说明部分未执行，但“2A-2H 完成”表述容易被理解为运行时已验证。
- **Suggestion:** 保持实现摘要中的未验证项明确，并在具备数据库依赖和测试库后补跑 `test-usage-accuracy.js`、迁移 dry-run 及端到端认证/会话总结测试。
- **Status:** fixed
- **Response:** 已修复：implementation-summary 已区分静态检查、无数据库测试通过和数据库/端到端未验证项；补充了静态 8 点位计数/失败传播断言。

### Issue 8 -- Severity: nit
- **File:** `/data/CrewRouter/server/routes/api.js:2764-5975`
- **Description:** 已发现 8 处 usage INSERT，列集合分别保留了原有差异（包括 `request_params` 和 `plugin_meta`），这一点符合任务书；但事务 helper 以动态 SQL 字符串和位置参数承载列集合，缺少自动化断言，后续新增点位容易漏传 `userId` 或 `pointsToDeduct`。
- **Suggestion:** 增加不连接真实数据库的 helper 参数/SQL 列数测试，至少断言 8 个点位的占位符数量与值数组长度一致，并断言 helper 返回失败时调用方不会继续成功完成计费流程。
- **Status:** fixed

## 结论

发现 3 个功能性问题、3 个改进建议和 2 个验证/可维护性提示。其中 Issue 1（事务失败被静默吞掉）和 Issue 2（配置接口仍依赖已清空的明文 key）会直接造成财务漏计费或现有功能失效，建议在合并前优先修复。未修改源代码。
- **Response:** 已修复：helper 失败直接抛出，8 个调用点均显式检查返回值；增加无数据库静态断言，校验 8 个 usage 点位及占位符/参数数组数量。
