# 安全续审：已记录失败的离线测试夹具修复

日期：2026-10-26（Asia/Shanghai）。基线：`089a7469`，分支 `main`。严格续接 `audit/security-guard-permissions-review-2026-10-25.md` 的四项失败，按报告顺序逐项复现、修复和专项运行；没有重新调查或处置生产环境。

**只修改四个测试文件及本轮审计记录。没有修改生产 SSRF、认证、权限、配额实现或离线预加载器。没有访问或修改生产服务/数据库，没有部署 guard、生产撤权、生产迁移、改凭证、网络隔离或 push。**既有 PostgreSQL 专项仅在自行新建、无 TCP 监听的私有 Unix socket 临时集群执行测试 DDL/授权/回滚，未使用部署数据库或常驻本地数据库。

## 初始状态与边界

- 已读取前轮报告、机器可读结果、根目录 `AGENTS.md` 和相关源码。初始已跟踪文件没有改动；`.blora/`、`CLIProxyAPI/` 未跟踪，原样保留，不读取其数据、不暂存、不清理。
- 环境为 Node.js `v24.13.1`、PostgreSQL/psql `18.3`。原 34 文件和 29 脚本清单均与前轮 SHA-256 相同，见本轮结果 JSON；没有改变扩大回归选择条件。
- 除专门验证插件自身隔离性的干净环境执行外，复现、专项、安全回归及扩大集统一使用既有 `server/scripts/test-support/offline-security-preload.js`。它清除继承数据库连接变量、阻断应用数据库 singleton 操作及应用启动，只允许测试自有临时 loopback 端口和符合条件的新建私有 PostgreSQL socket。
- 预加载器与 VM 依赖替身只是可信测试的隔离辅助，不是恶意代码沙箱或操作系统网络隔离。本轮未执行防火墙命令、systemd 命令、部署脚本或应用启动。

## 逐项先失败、后修复

### 1. model-identity 缺失 transport fixture

修复前只选择 `real transport and retry helper count each network attempt once`，实际 **1 项、0 通过、1 失败、0 跳过，退出 1**，断言仍为 `networkCalls: 0 !== 12`。

最小修复：`test-model-identity.js` 同时提取真实 `proxyFetch` 和它依赖的 `proxyFetchTransport`，增加提取边界断言。保留原有内存 axios 拒绝替身和 12 次网络尝试计数断言，不发网络请求，不修改 `server/proxy-pool.js`。修复后完整文件 **39/39 通过，0 失败、0 跳过，退出 0**。

### 2. plugin-capabilities 数据库依赖

修复前前三组 manifest/权限断言通过，usage 查询被预加载器以 `OFFLINE_TEST_BLOCKED_APPLICATION_DATABASE_OPERATION` 拒绝，脚本退出 1；没有给它真实数据库 URL，也没有解除阻断。

最小修复仅在 `test-plugin-capabilities.js`：将真实 host 和 plugin-data-read 源码在显式依赖注入的 VM 中执行。未列入注入表的 `require` 立即失败；应用数据库、配置、日志、代理模块均不加载。内存 pool 只接受两次预期的 SELECT，核对用户范围和参数、拒绝正文列及 `SELECT *`，返回一行非空聚合数据；通过真实 `buildContext` 创建的 `ctx.usage.summary` 执行原断言，避免空集伪通过。`connect`、意外 audit 写入或 hook 注册会抛错。

修复后脚本 **退出 0，四组原有检查输出 PASS**，不是四个 Node 子测试。另在 `env -i` 干净环境、不使用预加载器的进程中重复运行，并在 exit hook 断言应用 database/config/logger/proxy 模块从未进入 require cache，退出 0。此结果验证夹具和 SQL 构造契约，**不等于真实 PostgreSQL 查询、生产插件数据权限或恶意插件隔离验收**。

### 3. inject-prompt-cache-lifecycle 旧签名

修复前脚本 **退出 1**，复现 `ReferenceError: validateApiKey is not defined`。旧提取字符串只匹配三个参数，无法找到带 `boundKey = null` 的现有函数。

最小修复：以 `async function validateApiKey(` 为函数入口、从入口向后定位既有结束标记，并断言两个边界存在；执行完整现有函数，不改认证、队列、提示词缓存实现。修复后原有 binding 转换、禁用/删除、多 worker、在途快照/禁止陈旧回填和查询失败断言全部执行，脚本 **退出 0**；该脚本没有 Node 子测试计数。

### 4. upstream-stream-safety loopback SSRF fixture

修复前 **0/42 通过，42 失败，退出 1**，原因仍为真实 `quotaFetch` 拒绝内网地址 `127.0.0.1`；没有为复现接触外部上游。

最小修复：只给该测试原有依赖替身表增加 quota-request-context fixture，绕开与流式 reader 生命周期无关的持久化/配额入口。替身与 axios 拦截器共同断言 URL 必须为无用户名密码的 `http://127.0.0.1:<本测试当前临时端口>`，传输仍执行真实 `proxyFetchTransport` 和本测试 HTTP server；axios 继续禁用环境代理。生产模块中的 `allowPrivate: false` 和 URL/DNS 固定逻辑完全未改。

修复后六条流式路径 × 七种终止/错误/取消场景 **42/42 通过，0 失败、0 跳过，退出 0**。它验证真实 reader 取得、取消、释放锁、上游关闭及不重发，不覆盖被替身替代的生产 quota/SSRF 入口。

另直接调用**未替换的真实** `quotaFetch`，分别对 `127.0.0.1`、`10.0.0.1`、`172.16.0.1`、`192.168.0.1`、`169.254.169.254`、`100.64.0.1`、`::1`、`fc00::1` 的数字地址 URL 断言 SSRF 拒绝且 transport 调用次数为零：**8/8 通过，0 失败、0 跳过**。这些拒绝不发起网络请求，也没有以流式夹具的通过替代生产 SSRF 检查。

## 最终回归结果

以下集合存在包含关系，**不得相加作为独立测试总数**。

| 验证 | 通过 | 失败 | 跳过 | 退出码 |
| --- | --- | --- | --- | --- |
| `test-model-identity.js` 完整专项 | 39 项 | 0 | 0 | 0 |
| `test-plugin-capabilities.js` | 1 脚本（四组 PASS） | 0 脚本 | 无跳过标记 | 0 |
| `test-inject-prompt-cache-lifecycle.js` | 1 脚本 | 0 脚本 | 无跳过标记 | 0 |
| `test-upstream-stream-safety.js` | 42 场景 | 0 | 0 | 0 |
| 真实 quota SSRF 拒绝检查 | 8 项 | 0 | 0 | 0 |
| `npm run test:security-guards` | Node 71 项，另 2 脚本退出 0 | 0 | 0 | 0 |
| `npm run test:public-schema-create` | 9 项（临时 PostgreSQL） | 0 | 0 | 0 |
| `npm run test:security-audit` | Node 41 项，另临时 PostgreSQL 聚合脚本退出 0 | 0 | 0 | 0 |
| 前轮原样 34 文件 node:test 扩大集 | **457 项** | **0** | **8 项** | **0** |
| 前轮原样 29 个额外脚本 | **29 脚本退出 0** | **0 脚本** | 无跳过标记 | 全部 0 |

扩大集共 **465 项 = 457 通过 + 0 失败 + 8 跳过**；其中离线预加载器自身的 5 项子进程回归也全部通过。29 个脚本按进程退出码统计，不冒充 Node 子测试数量。原四项已记录失败都不再出现在最终回归中；首轮失败复现日志仍保留，不计为修复后的通过结果。

### 仍然跳过的八项

没有提供专用数据库 URL，且预加载器会清除继承值，因此以下测试**未执行、不算通过**；本轮不通过借用生产/常驻数据库填补覆盖率：

1. `test-latency-stats-postgres.js`：延迟百分位、限流快照与用户范围（缺 `LATENCY_STATS_TEST_DATABASE_URL`）。
2. `test-provider-quota-stats-db.js`：权限撤回、多 Team、分页、归档互斥和明细清理回退（缺 `QUOTA_STATS_TEST_DATABASE_URL`）。
3. `test-quota-cycle-analysis.js`：多窗口、partial、重置充值、修正回补、重叠、保留、权限和导出（缺 `QUOTA_TEST_DATABASE_URL`）。
4. `test-quota-cycle-incremental.js`：1000 样本增量预算、两 phase、导出和 late usage（同上）。
5. `test-quota-cycle-review.js`：缺 series、长期快照和导出版本一致性（同上）。
6. `test-quota-request-context.js`：logical request schema 幂等（同上）。
7. `test-quota-request-context.js`：max1 并发扣费、attempt correction 与失败隔离（同上）。
8. `test-quota-request-context.js`：被拒 logical request 不持久化凭证文本（同上）。

### 可复跑命令

```sh
export NODE_OPTIONS="--require=$PWD/server/scripts/test-support/offline-security-preload.js"

# 每项修复前先运行同一入口；model 初次仅选择已记录失败项。
node --test --test-name-pattern='real transport and retry helper count each network attempt once' server/scripts/test-model-identity.js
node --test server/scripts/test-model-identity.js
node server/scripts/test-plugin-capabilities.js
node server/scripts/test-inject-prompt-cache-lifecycle.js
node server/scripts/test-upstream-stream-safety.js

npm run test:security-guards
npm run test:public-schema-create
npm run test:security-audit

mapfile -t tests < <(
  for file in server/scripts/test-*.js; do
    if head -25 "$file" | rg -q 'node:test'; then printf '%s\n' "$file"; fi
  done
)
node --test --test-reporter=tap --test-concurrency=1 --test-timeout=30000 "${tests[@]}"
```

扩大集执行前，实际将生成清单与前轮清单逐字节比较，相同才继续。29 脚本也只使用前轮清单；两份完整清单、逐脚本退出码、每项前后日志、安全专项日志及 SHA-256 均在 `audit/security-fixture-followup-test-results-2026-10-26.json`。真实 SSRF 检查日志记录八项 Node 子测试，检查代码是向真实 `quotaFetch(url, {}, transportSpy)` 传入上述数字 URL，并要求 `assert.rejects(..., /SSRF/)` 及 `networkCalls === 0`。

## 校验、保留项与尚未完成事项

- 四个修改后测试文件均通过 `node --check`，`git diff --check` 通过。已逐文件审阅具体 diff；只有测试和本轮审计材料进入暂存范围，不改变前轮报告和提交。
- 所有自行创建的 PostgreSQL 夹具均由既有测试清理；运行结束未发现 `/tmp/cr-data-*`、`/tmp/cr-oauth-revoke-*` 目录。没有停止、探测或重启任何生产进程。
- 初始未跟踪的 `.blora/`、`CLIProxyAPI/` 保留且不入提交；只创建新的本地提交，不 amend、reset、rebase 或 push，不覆盖既有提交。
- 原始日志在本机 `/tmp/crewrouter-security-fixtures-20261026-xMRelr/`，可随临时目录清理消失；SHA-256 只便于核对，不提供外部可信性或长期保全。
- **已执行项零失败，不等于所有测试全部通过**：八项数据库场景仍跳过；未运行整仓库桌面/浏览器端到端或 release build。
- 前轮生产部署、真实 nft/systemd 生命周期、运行/迁移角色分离、生产状态重新核准和历史安全处置 blocker 均不因此解除；没有把旧快照当作当前生产事实。本轮没有授权或执行这些变更。
