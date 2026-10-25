# Guard、权限与 public CREATE 专项续审

日期：2026-10-25；基线：`c6b80287f426492f1db46f3d2f865f727d5fc171`。**本轮仅修改仓库和运行离线/隔离测试；没有访问、修改或重启生产服务，没有生产数据库连接、写入、迁移、撤权、网络隔离、凭证处置或 push。修复尚未部署，完整回归不是全绿。**

## 仓库和历史核对

初始 `main` 比 `origin/main` 超前 45 次本地提交；已跟踪文件无未提交改动。仅 `.blora/` 与 `CLIProxyAPI/` 未跟踪，本轮原样保留，不纳入提交。核对最近认证、权限、迁移与数据修复提交，重点比较 `b46cd33e` 的个人版供应商授权、`47e1264e` 的管理员 guard，以及 `8ee978c9` 的 incident guard 历史；没有重做或回退既有 OAuth、PassKey、模型授权、队列锁或启动迁移修复。

生产事实只引用旧报告，不重新把旧快照当成当前状态。2026-10-25 16:43 的历史报告记载应用角色仍有 `publicSchemaCreate=true`、旧进程与未生效 guard；**本轮没有复查这些状态，当前生产运行态及角色所有权未知**。

## 实际代码修复

### 会话和权限 guard

`server/middleware/auth.js` 的原 `requireAuth` 只检查 `req.session.user` 是否存在。用已删除用户的陈旧 session 调用真实 Express POST 路由，在替身数据库明确返回不存在的情况下，仍返回 200 并执行受保护 handler；新增回归在修复前共 66 项、16 通过/50 失败，其中真实 HTTP 场景为 `200 !== 401`。

现在四个身份入口共享正整数 ID 检查，缺 session、缺 ID、非数值、非安全整数等无效主体在查询前返回 401。`requireAuth` 每次查询当前用户及 `is_admin`，不存在返回 401，数据库故障返回 503，不放行 handler。`requireAdmin` 从数据库 boolean 严格判权，降权时同步清除陈旧 `isAdmin=true`；供应商权限上下文也刷新该标志，但保留 personal 与 team 的既有授权策略。将 `next()` 移到权限查询的 catch 外，避免把后续 handler 的异常吞成权限 503。

这是请求进入时的存续/权限核验，会增加会话认证的数据库查询；**不是取消已经通过检查的在途请求，也不是把全部业务操作与撤权变更原子化**。既有关键写事务锁仍保留；其他没有使用这些 guard 的入口不因此自动得到同样保证。没有将这些代码缺陷归因成已证实的生产利用路径。

### Incident guard 生命周期

原 unit 的 `ExecStop=nft delete table ...` 会在服务停止时撤销内核防护。仓库模板现删除该动作，新增与启动相同的 `ExecReload`；停止 unit 本身不再主动删表。nft 文件用同一批次的 `add table`、`delete table` 和完整定义替换专属表，意图避免已有表重复加载时追加规则；不使用 `flush ruleset`，不更改其他表，不改变历史 allowlist 和数据库回复例外的范围。

本轮仅做 unit 文本约束和逐条规则离线模型测试，覆盖 10 个已记录失陷 IPv4/IPv6 地址、管理端口白名单、未知 Tailnet、外部入站、loopback 和 PostgreSQL 回复例外。**没有调用 nft 检查/加载内核规则，也没有验证真实 systemd 启停、nft 语法/事务兼容性或网络可达性；这些是部署前 blocker，不能以 5 个离线测试取代。**

此规则仍是有限 INPUT 过滤、`policy accept`，没有 OUTPUT/FORWARD 隔离。允许的 TCP 80、历史管理节点及数据库例外不因本补丁变成可信；root、其他防火墙管理器或显式删表仍可移除规则。`active (exited)`、文件存在或零计数器都不能证明实际防护。

### 数据库角色与可执行处置

`server/scripts/security-audit.js` 在原有效 CREATE 检查外新增三个必须存在的 boolean：`publicSchemaMemberCreate`、`publicSchemaOwner`、`databaseOwner`，分别记录成员角色的 CREATE、schema 所有权关系和数据库所有权关系。缺字段仍失败关闭、退出 2；任一风险为 true 退出 1。MEMBER 检查有意保守，不把 PostgreSQL 新版中禁止 SET/INHERIT 的某些成员关系直接断言为可利用。

真实临时 PostgreSQL 18.3 已复现：NOINHERIT 角色当前 CREATE 为 false，但成员角色拥有 CREATE；schema owner 撤销自身普通 CREATE ACL 后有效 CREATE 也可为 false，但仍保有重新授权能力。只看原来的 boolean 不足以验收运行角色的权限收缩。

新增 `audit/review-public-schema-create.sql`：默认只读检查；显式授权的 apply 模式默认真实撤权后回滚，只有再显式 `commit=true` 且断言通过才提交。核对目标库和角色、记录 ACL/owner/成员关系，拒绝 owner、高危角色属性及残余成员 CREATE，避免部分成功。只撤销 `PUBLIC` 和指定应用角色的 CREATE，不碰业务数据、USAGE、表/序列授权、口令或归属。

准确操作顺序、命令、授权边界、兼容性和精确回退见 `audit/security-public-schema-create-runbook-2026-10-25.md`。**生产角色来源尚未重新核准，应用仍有启动/功能初始化 DDL；未完成恢复副本的运行/迁移身份兼容性验证前，不得提交生产撤权。**本脚本不会自动创建迁移角色、转移对象归属或删除成员关系。已存恶意对象、运行角色的表所有权、其他可写 schema 和历史完整性不在此次撤权的解决范围内。

## 测试结果：专项通过，扩大回归有 blocker

环境：Node.js `v24.13.1`、PostgreSQL/psql `18.3`。先运行既有 provider-manager、Batch E 和 security-audit 基线，均通过；再新增失败回归、修复并复跑专项，最后扩大范围。以下计数有包含关系，**不相加成独立测试总数**。

| 最终验证 | 实际结果 |
| --- | --- |
| `npm run test:security-guards` | Node 71/71；另 provider-manager 与 Batch E 两脚本均退出 0 |
| `npm run test:public-schema-create` | 9/9；psql 执行仓库原 SQL，私有 socket 新集群 |
| `npm run test:security-audit` | Node 41/41；另真实隔离 PostgreSQL 聚合检查退出 0 |
| `test-offline-security-preload.js` | 5/5；在扩大回归中也执行 |
| 34 个含 node:test 的服务端文件 | **465 项：456 通过、1 失败、8 跳过，退出 1** |
| 29 个额外安全/权限/并发脚本 | **26 个退出 0、3 个退出 1**；具体见下 |

最终 Node 完整命令：

```sh
mapfile -t tests < <(
  for file in server/scripts/test-*.js; do
    if head -25 "$file" | rg -q 'node:test'; then printf '%s\n' "$file"; fi
  done
)
NODE_OPTIONS=--require="$PWD/server/scripts/test-support/offline-security-preload.js" \
  node --test --test-concurrency=1 --test-timeout=30000 "${tests[@]}"
```

该集合不是整个多仓库/桌面/浏览器端到端测试，也不包括需要另行提供数据库 URL 的所有旧脚本。没有运行可能覆盖部署制品的 release build。最终代码语法、diff whitespace、暂存范围和提交状态另作检查。

### 没有伪装成通过的结果

1. `test-model-identity.js:464`：`real transport and retry helper count each network attempt once` 失败，`networkCalls=0` 而非 12。该测试及 `server/proxy-pool.js` 均与基线完全一致。关闭临时预加载器、仅选择此内存测试仍同样失败；独立提取原 fixture 后直接得到 `ReferenceError: proxyFetchTransport is not defined`，没有发生网络请求。原 fixture 只提取 `proxyFetch` wrapper，没有提取其已依赖的 transport。这是未修改的既有夹具失败，不把它算作此次修复通过，也没有越界顺手改动。
2. `test-plugin-capabilities.js`：前置权限门控通过，但其 usage 聚合步骤直接调用真实应用数据库 singleton；防误连工具在调用前拒绝，脚本退出 1。没有为使它变绿而允许连接部署数据库。需要另行提供独立 fixture；这不是证明生产插件功能故障。
3. `test-inject-prompt-cache-lifecycle.js`：未修改的源码提取夹具使用旧签名定位，现有 `validateApiKey(req, res, next, boundKey = null)` 不匹配，导致 `validateApiKey is not defined`。这是既有夹具失败，未修改队列/缓存产品实现或该测试。
4. `test-upstream-stream-safety.js`：未修改的 loopback 测试被现有 `quotaFetch` SSRF 校验拒绝，日志为内网地址 `127.0.0.1`，结果 0/42、退出 1。需更新测试专用 transport/配额 fixture；不能为了测试放行生产私网 SSRF。本轮没有更改相应 SSRF 或上游代码。
5. 8 个 Node 子测试因没有专用数据库 URL 跳过：延迟统计、quota overview、quota cycle analysis/incremental/review 和 quota request context 的三个数据库场景。没有借用生产或常驻本地数据库填充这些变量；跳过不是通过。

### 测试的安全隔离与失败启动记录

新增 `server/scripts/test-support/offline-security-preload.js` 只供可信测试预加载：清除继承的数据库 URL/连接变量，提供合成配置和静默日志替身，应用数据库操作会抛错且置失败退出码，拒绝应用启动和直接读部署 config；只允许当前测试自行绑定过的 loopback 临时端口，以及匹配私有测试目录且创建时间不早于预加载启动前一秒的 PostgreSQL socket，测试自身另行验证真实集群身份。它不是对恶意代码的沙箱或 OS 网络隔离，不能用来运行不可信插件。

首轮扩大回归的临时保护器没有识别 Node 已归一化的 socket 参数数组，误拒绝自有 loopback 连接；随后还明确拒绝了一些传输测试导入的配置/日志/数据库模块。保留这些失败日志，仅修正测试保护器：合成配置/静默日志替身、禁止操作的数据库替身，并补 5 项独立子进程回归。最终完整测试使用已入库的预加载器重新运行；首轮被中止/失败的执行不算通过。只停止了本轮创建并已核对 PID 的测试进程，没有停止生产进程。

所有本轮 PostgreSQL 写入、角色授权与撤销仅发生于新建私有 Unix socket 测试集群。测试断言空 TCP 监听、真实 data_directory 和清理；最终检查未见 `/tmp/cr-data-*` 或 `/tmp/cr-oauth-revoke-*` 遗留目录。没有连接历史生产审计证据所指的数据库。

## Guard 人工部署审阅步骤：本轮不执行

1. 先在可丢弃 Linux 环境验证同版本 nft 的批次语法、重复加载、失败原子性以及 systemd start/reload/stop；停止 unit 应保留表。当前缺少这份真实内核验收，必须阻断自动部署。
2. 从可信终端重新确认管理节点、失陷节点、IPv6 地址、数据库例外与真实暴露端口，取得上游防火墙、应用、证据保全和回退的批准。有独立控制台，不能依赖将被更改的唯一 SSH 通路。
3. **只有取得人工生产变更授权后**，才审阅执行以下模板；需要先备份现存配置并核对内容，不能盲目使用本文件中的历史 IP。

```sh
install -d -o root -g root -m 0755 /etc/nftables
install -o root -g root -m 0644 audit/cr-incident-guard.nft /etc/nftables/cr-incident-guard.nft
install -o root -g root -m 0644 audit/cr-incident-guard.service /etc/systemd/system/cr-incident-guard.service
nft --check --file /etc/nftables/cr-incident-guard.nft
systemctl daemon-reload
systemctl enable cr-incident-guard.service
systemctl reload-or-restart cr-incident-guard.service
```

这些命令会读取/修改实际主机状态；本轮一条也没有执行。命令模板不是授权。若 `nft --check` 非零即停止，不执行后续 enable/reload；旧 unit 若仍含 ExecStop，必须先完成新 unit 的 daemon-reload，不能先停旧服务以免删规则。

4. 保存 `systemctl show cr-incident-guard.service` 与 `nft list table inet cr_incident_guard` 的实际输出，在受控独立位置核验 IPv4/IPv6 和例外；文件、unit 状态与网络行为三者分别验收。不要在生产通过停止 guard 来回归测试。
5. 新 unit 故意不自动删表。退役/恢复时，由另一次明确授权的变更在上游替代防护生效后才显式移除专属表；仅停 unit 不是网络回滚。此有限过滤不能替代可信重建和上游隔离。

## 交付与仍未闭环事项

版本化机器可读结果与本地日志 SHA-256 见 `audit/security-guard-permissions-test-results-2026-10-25.json`。原始日志保留在其中列出的 `/tmp` 路径，属于本机、可消失的辅助证据；哈希不提供独立可信性，应由人工异机保全，不向仓库写入秘密或生产原始数据。

当前阻断项包括：未部署的修复、未重新核准的生产状态、未实测的 nft/systemd 兼容性、运行/迁移角色分离与启动验收、上述既有测试失败/安全阻断，以及先前报告中的可信恢复源、历史数据对账、凭证处置和敏感凭证管理重认证。它们不因此次专项通过而解除。本轮只做本地 Git 提交，不 push。
