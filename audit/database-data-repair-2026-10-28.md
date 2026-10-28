# 数据库数据修复执行记录（2026-10-28）

本轮已实际写入生产库，不是仅提供方案。上海时间 12:03:09 完成时间恢复事务，12:07:00 独立只读复核。**确定可恢复的时间已修复；不能因此认定历史数据库完整。**

## 实际完成

- 从 `usage_message_analysis.created_at` 恢复同一 `usage_id` 的 66,055 条用量时间：58,046 条原值为空、1,436 条超出有效范围、6,573 条看似有效但与原始副本不符。
- 来源必须唯一关联、用户一致、创建时间及分析时间有效且顺序正确；已有关联记录中另有 95,145 条时间在毫秒精度上一致，为副本语义提供交叉验证。恢复保留来源的毫秒精度，不伪造已丢失的微秒；同毫秒的现存原值不改动。
- 更新前锁定目标和来源行，将原值及来源同步落盘；单一事务分批更新并核对影响行数，异常整体回滚。已确认提交 66,055 行，复核可恢复候选为 0。
- 12:02:48 已直接在数据库事务中安装并提交三个写入保护触发器，用量、消息分析、请求尝试三表均为启用状态；无需等待应用重启。本轮没有重启或部署工作区中的其他应用改动。

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 用量记录总数 | 161,205 | 161,205 |
| 用量时间为空 | 58,049 | 3 |
| 用量时间早于 2000 年、超前 5 分钟或非有限值 | 1,436 | 0 |
| 至少一个 Token 字段为负的用量记录 | 16,505 | 16,505 |
| 消息分析缺少 `usage_id` | 56,109 | 56,109 |
| 请求尝试缺少 `created_at` | 12,035 | 12,035 |

## 备份与复核

私有证据目录：`/root/crewrouter-audit-evidence/20261028T035927880Z-data-repair-6HOGfv`。目录权限 0700，证据文件 0600，不进入 Git。

- `before-repair.dump`：修复前全库逻辑备份，18,516,582 字节；已使用 `pg_restore --file=/dev/null` 完整解码校验，没有执行恢复 SQL。SHA-256：`bd0885ad836c786ee9617f36b9550a27af2c14136cc6596a698b6e3c56cf6c26`。
- `timestamp-repair/original-values.json`：每条更新的原始时间、恢复时间、来源 ID 及分析时间。SHA-256：`fe6605c8cd65a98c8c62c3a3e8f9a5d27ae808cc903785660d46bb7ea093aad1`；`result.json` 记录已提交结果。
- `before-table-fingerprints.json`、`after-table-fingerprints.json`：90 表行数和行内容摘要；用量表仅排除本次修改的 `created_at`。87 表摘要一致，包括用量其他字段、分析、请求尝试、用户、API Key 和账目相关表。
- 在线核验期间另有三表变化：`quota_capture_instances` 为 380 → 380 行但内容变化，`quota_logical_requests` 为 92,287 → 92,297 行，`user_sessions` 为 1 → 1 行但内容变化。业务未暂停，这三表不在修复 SQL 的更新目标中；未回滚这些变化，也不凭摘要差异断言其来源。
- `verification.json`、`verification-assessment.json`：100 个声明外键反查均无非空孤儿，41 个序列均不落后，三个写入保护触发器启用。全部 API Key 仍禁用，没有启用 Key、删除记录、重算账目或修改 Token。
- `ALL_SHA256SUMS` 覆盖全部私有证据。当前库备份仅用于此次操作回退，本身包含既有异常，不是证明历史无损的可信原始备份。回退原有坏时间会被写入保护拒绝，须明确处理保护后再操作，不能直接覆盖在线库。

## 尚不能恢复的数据

仍有 5 条用量没有关联的分析副本：其中 3 条时间为空，另 2 条保留可疑的 2000 年时间。没有将它们填成当前时间。

现有分析记录的 Token 和费用除一条外均为空；请求尝试仅一条能关联到现存用量且已有正确副本；区间请求快照全部为空；模型探针表为空。检查到的 JSON 响应也没有原始上游 `usage`。因此无法据此恢复 16,505 条负 Token、缺失的分析关联和请求尝试创建时间；未取绝对值、清零、按行号配对或以开始时间冒充精确创建时间。继续完成这些历史恢复仍需要可信原始备份、原始请求凭证或可验证的物理恢复产物。

## 可重复执行与测试

- `node server/scripts/repair-usage-timestamps.js`：只读预览，当前候选为 0。
- `node server/scripts/repair-usage-timestamps.js --apply --backup-dir /绝对路径/尚不存在的私有目录`：有可靠新候选时恢复，否则不写入；不自动修改无法证明的字段。
- `npm run test:usage-repair`：6 项通过，覆盖只读、唯一来源筛选、备份失败拒写、失败批次全量回滚、静默跳过检测、精度保留、非时间字段不变和幂等性。
- `npm run test:usage-write`：6 项通过。两组数据库测试都使用全新独立 Unix socket PostgreSQL，未访问生产测试数据。

## 继续追查恢复来源（12:33）

2026-10-28 12:33:49 上海时间再次只读核验：用量缺失时间 3 条、负 Token 16,505 条、分析缺少关联 56,109 条、请求尝试缺少创建时间 12,035 条，均未变化。本轮没有新增生产写入，也没有清零、删除或配对无法证明的历史记录。

本机历史取证包 `/root/Downloads/bloret-incident-evidence-20261024.tar.gz` 内的 `06-reports/CREWROUTER-RECOVERY.md` 提供了此前尚未实读的远端恢复材料路径：

- `bloret-core:/root/crewrouter-recover/sql/`：报告记载的 12 张表 CSV 导出；尚不能确认是否包含本轮待修复的目标表。
- `bloret-core:/root/crewrouter-recover/keytables/`：旧表物理文件及 `before-drop_*.bin`。
- `bloret-core:/root/crewrouter-recover/pg_attribute.before-insert` 和 `bloret-core:/root/crewrouter-relmap.tsv`：原始列目录材料及表与物理文件映射。
- `bloret-core:/mnt/ssd1/pgdata/base/16384.corrupt`：报告记载的旧数据库目录。

这些只是历史报告中的位置记载，**没有确认文件当前仍存在，也没有将报告等同于可信恢复源**。只读取了归档条目，没有执行归档内命令、脚本或恢复 SQL。现有 SSH 身份采用批处理、严格已知主机核验、禁用密码交互和代理转发访问 `bloret-core`，返回认证拒绝；没有尝试其他账号、搜索登录凭据、调整防火墙或提升数据库权限。当前数据库角色没有 `pg_read_server_files` 成员权限，不能直接读取这些服务端文件。

额外检查了其他用户 schema 及可能保存重复事实的业务表：只有 `public`；`trace_events`、`trace_sessions`、`agent_messages`、`client_events`、`balance_preconsumes`、`quota_cycle_reports` 均为空；10 条会话消息的 `meta` 全空，唯一插件数据的 `value` 为空，请求配额样本未找到可用的快照对象字段。未发现新的、能够唯一核对到待修记录的 Token、精确时间或关联副本。

因此，下一步必需的是上述恢复材料的**本机可读私有副本或现有授权只读访问方式**，而不是继续改写现库。取得材料后还须核准来源、目标表和列布局，再按稳定记录身份逐字段对照；不能承诺文件一到就能完整恢复全部历史。

本轮私有证据：`/root/crewrouter-audit-evidence/20261028-source-inventory-9jnFiQ`，包含历史恢复报告副本、实时数据库指标、访问受阻事实及校验清单。取证包 SHA-256 为 `28b9fc8bfc4f5c935b2864d14876ed59a9c6d5e745e7790f6dc1926ce3fc7fda`，报告条目 SHA-256 为 `c920099f20b8ce08618fc8c8438465447d6b82df2d86ca33d80c9033923dcc76`；自算哈希只用于固定本轮读取内容，不证明历史材料可信。
