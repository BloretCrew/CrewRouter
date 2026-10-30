# 安全续审：未提交改动的静态与纯内存复核

日期：2026-10-26。本记录仅覆盖用户最新严格安全限制生效后的执行阶段。目标仍是完成仓库内安全缺口闭环，**当前尚未完成，不以本轮小范围通过替代全部目标**。

## 安全范围

- 首先只查看当前 worktree diff 和 `ps -eo pid,ppid,stat,comm`，没有读取进程参数或环境，不将进程名当作生产健康证明。
- 没有读取、解析、stat 或使用任何凭证/证据指针、秘密文件、`.env`、认证 token 或部署配置；没有读取先前临时日志来核对历史测试结果。本报告不引用其哈希或将历史结果当成当前验收。
- 自本次限制生效起，实际数据库测试执行数为 **0**。没有启动真实 PostgreSQL、创建真实数据库连接、访问上游、生产服务或生产数据库；没有运行防火墙、systemd、权限修改、部署或 push 操作。
- Shell 工具在这一阶段的后续调用使用 `login=false`；Node 测试和语法检查使用 `env -i`，不继承 `NODE_OPTIONS`、`NODE_PATH` 或数据库连接环境。
- `.blora/`、`CLIProxyAPI/` 原样保留，未读取其内容。没有暂存、提交、覆盖提交或清理已有改动。

## 当前未提交改动的评估

### 已存在的密码条件更新

本阶段开始时，`server/routes/auth.js` 的三个密码写入口已经改为：

```sql
UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
WHERE id = $2 AND password_hash IS NOT DISTINCT FROM $3
```

写入行数不是 1 时返回 `409 / credential_changed`，不继续修改首次设置标志、不保存成功 session，也不产生该路径的成功审计。本阶段没有再修改该生产文件。

新增纯内存测试执行完整的当前 auth 路由源码，数据库和 bcrypt 均为显式替身；覆盖三种入口状态的旧快照拒绝、用户删除、正常写入和错误旧密码。另有三个控制用例只在内存源码副本移除旧哈希条件，确认能够重现无条件覆盖，不改写磁盘源码。

这支持对条件写入分支的离线检查，**不证明真实 PostgreSQL 的 MVCC、锁等待或 bcrypt/浏览器/session store 端到端兼容性**，更不等于已完成近期重认证、其他会话撤销或全套凭证管理加固。

### 已存在的数据库夹具转换

六个既有测试文件共八个数据库场景已经改成自行创建私有集群、显式使用 `cluster.connection`、业务 SQL 前调用 `assertIsolation`，而不是消费外部数据库 URL：

- `test-latency-stats-postgres.js`：1 个场景。
- `test-provider-quota-stats-db.js`：1 个场景。
- `test-quota-cycle-analysis.js`、`test-quota-cycle-incremental.js`、`test-quota-cycle-review.js`：各 1 个场景。
- `test-quota-request-context.js`：3 个场景。

静态看到 `createIsolatedPostgres` 新建目录、执行 initdb、以 `-h ''` 和专属 socket 目录启动、清空子进程数据库环境，并检查 `data_directory`、`listen_addresses`、`unix_socket_directories`。新增纯内存契约用例把该模块的文件系统和 `execFileSync` **全部替换**，检查这些参数构造与环境白名单；没有实际调用这些操作。

**本阶段仍不运行这些 DB 场景。** 参数/替身契约不等于真实无 TCP 监听证明；可执行文件发现、root 下的目录 chown 分支、真实启动及失败清理也没有获得本阶段运行验证。不能在此安全约束下直接运行原全文件发现命令或 npm 数据库专项。以后任何真实数据库测试都必须在执行前独立证明新建私有集群、Unix-socket-only、无外部 URL/config 消费且不违反权限操作限制；证明不足就保持不执行。

## 两项先复现、后修复的问题

新增 `server/scripts/test-security-static-fixtures.js`，只直接导入 Node 内置模块，仅读取以下三份仓库源码：`routes/auth.js`、`scripts/test-support/isolated-postgres.js`、`scripts/test-provider-quota-stats-db.js`。未知依赖立即拒绝，不加载应用配置、数据库 singleton、pg 包或真实子进程模块。

1. **注册 after hook 失败会遗留新集群。** 原未提交 wrapper 先创建集群，再注册清理钩子；钩子同步抛错时没有 stop。纯内存失败回归观察到 stop 次数为 0 而不是 1。最小修复是在 hook 注册外捕获错误，停止本夹具集群后重抛。正常清理仍尝试关闭全部去重连接，连接关闭报错也执行 stop，错误不伪装成通过。
2. **quota fixture 给新子路由提供了 object 而非 middleware。** `fakeRequire('./admin-model-library')` 落入通用 Proxy 替身，返回 object；该返回值不满足 Express Router.use 契约。纯内存回归先得到 `object !== function`。最小修复仅在测试依赖表为该模块返回空的 `express.Router()`；不改生产路由、认证门控或安全策略。此单项通过不证明完整 quota SQL/HTTP 集成已经通过。

## 本阶段实际验证

| 执行 | 通过 | 失败 | 跳过 | 退出码 |
| --- | ---: | ---: | ---: | ---: |
| 精简 PATH 的首次 Node 启动 | 未启动测试 | 不计为子测试失败 | 不计 | 127（找不到 node） |
| 纯内存回归，修复前 | 19 | 2 | 0 | 1 |
| 同一纯内存回归，修复后 | **21** | **0** | **0** | **0** |
| 11 个 JS 的 `node --check` | 11 个文件 | 0 个文件 | 0 | 0 |
| `git diff --check` | 无空白错误 | 0 | 不适用 | 0 |

21 项包含 13 项 auth 分支/控制用例、6 项清理生命周期用例、1 项完全替身化的启动参数契约和 1 项子路由替身契约。**它们全部是离线/内存检查，没有真实数据库场景。**

新增文件与 `/dev/null` 的 `git diff --no-index --check` 会因存在差异返回 1；这不是 Node 测试失败。最终检查单独解释这一状态，并将大于 1 的检查错误与正常新增文件差异区分，不混入测试计数。

原八个数据库场景和完整安全/扩大集在本阶段是**未执行、验收受阻**，不是本次 Node 框架的 8 个 SKIP，也不是通过。本阶段没有运行现存的 `test-auth-password-concurrency.js` 或 `test-isolated-postgres-fixture.js`；仅对它们做语法检查。不得用之前回合的 PostgreSQL 输出补齐当前代码的验收状态。

## 尚未关闭的仓库内缺口与边界

- PassKey 注册当前可见入口仍为已登录会话与登录模式检查，尚需统一的近期重认证设计和相应回归；不能将密码 CAS 视为防止被盗活动 session 添加持久凭证的完整修复。
- `two-factor.js` 的 enable/disable 仍为独立读取后写入；disable 只校验密码。启用尝试限制、消费时间步防重放、结构化审计及并发凭证状态绑定仍需单独的失败回归和有界修复。
- 密码/2FA 变更后撤销其他长寿命会话仍未在本阶段实现或验收。
- 八项 DB 场景、真实密码并发和夹具清理集成仍需符合上述前置证明的专用环境；本阶段不解除阻断。
- 其他历史专项仍需逐项以当前源码和安全可执行证据核对；本轮没有证明整个仓库、多进程认证状态、桌面/浏览器端到端或运行/迁移角色分离已全部闭环。
- 生产部署、防护实际生效、可信恢复、历史对账与凭据处置均不在本次授权范围，不进行现场复查，也不因仓库测试通过而宣称解决。

## 触及文件的命令清单

命令在执行前均已向用户报告；完整参数和补丁内容也在本次工具调用中。以下列出读写范围，不包含或指向任何私有凭证/历史证据。

1. `git diff --no-ext-diff --no-textconv --stat`；指定 auth/helper 的 `git diff --no-ext-diff --no-textconv -- ...`。同时仅查看 `ps -eo pid,ppid,stat,comm`。
2. `git diff --no-ext-diff --no-textconv -- server/scripts/test-*.js`。
3. `sed -n '1,135p' server/scripts/test-support/isolated-postgres.js`；`sed -n '125,155p' server/scripts/test-provider-quota-stats-db.js`。
4. `apply_patch`：新增 `server/scripts/test-security-static-fixtures.js`。
5. `env -i PATH=/usr/bin:/bin LANG=C node --test --test-reporter=tap server/scripts/test-security-static-fixtures.js`：启动失败，未执行测试；随后只执行 `command -v node` 定位可执行文件。
6. 下列命令分别在修复前、修复后执行一次，输出直接返回，没有重定向到文件：

   ```sh
   env -i PATH=/usr/bin:/bin LANG=C /root/.nvm/versions/node/v24.13.1/bin/node --test --test-reporter=tap server/scripts/test-security-static-fixtures.js
   ```

7. `apply_patch`：仅修改 `test-support/isolated-postgres.js` 的 hook 失败清理，以及 `test-provider-quota-stats-db.js` 的子路由替身。
8. `rg -n` 静态检索上述六个 DB 测试文件的连接构造/URL/隔离检查，以及 `routes/two-factor.js`、`routes/passkey.js`、`routes/auth.js` 的认证边界；没有执行所检索模块。
9. 对下列每个文件执行 `env -i PATH=/usr/bin:/bin LANG=C /root/.nvm/versions/node/v24.13.1/bin/node --check <文件>`：`routes/auth.js`、上述六个 DB 测试、`scripts/test-support/isolated-postgres.js`、`scripts/test-auth-password-concurrency.js`、`scripts/test-isolated-postgres-fixture.js`、`scripts/test-security-static-fixtures.js`（全部相对 `server/`）。
10. `sed -n '75,104p' server/routes/passkey.js`；`sed -n '86,181p' server/routes/two-factor.js`；`git diff --no-ext-diff --no-textconv --check`；`git --no-optional-locks status --short --untracked-files=normal`。
11. `apply_patch`：新增本审阅报告；随后仅补充新增文件比较的退出码说明。
12. 最终只核对当前 diff/status、对新增文件做 `git diff --no-index --check /dev/null <文件>`，并以 `rg -n` 定位本轮改动。没有 `git add`、`git commit`、push 或文件删除命令。
