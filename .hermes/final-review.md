# HEAD~4..HEAD 整合变更独立审查

审查范围：`HEAD~4..HEAD`（21 个变更文件），重点覆盖任务书生产安全红线、CLI 参数契约、`event_id` 幂等与通知、迁移备份/回滚、TUI/前端安全及兼容性。

验证：`cd CrewRouterHelper && npm test`，23 项测试全部通过；`git diff --check HEAD~4..HEAD` 通过。以下问题来自代码审查，现有测试未覆盖的生产并发和迁移 CLI 场景仍需单独验收。

## Findings

### 1. `event_id` 去重路径引用未定义变量，实际请求永远无法完成去重

- Severity: bug
- 文件:行：`server/routes/client-events.js:157-165`
- 描述：代码在收到 `event_id` 时执行查询参数 `[userId, harness, eventId]`，但本路由没有定义 `userId`。这会抛出 `ReferenceError`，随后被 `try/catch` 吞掉；请求继续返回 `{ ok: true }`，并继续执行通知逻辑。因此新客户端的事件不会按 `user/harness/event_id` 去重，且错误路径反而可能触发重复通知。
- 建议：使用已鉴权身份中的 `req.apiUser?.userId`，并为带 `event_id` 的成功插入/重复返回增加真实集成测试；不要将幂等检查异常当作普通落库失败继续处理。
- Status: open

### 2. `event_id` 的 SELECT 后 INSERT 存在并发竞态，无法保证幂等或通知至多一次

- Severity: bug
- 文件:行：`server/routes/client-events.js:159-181`
- 描述：即使修复未定义变量，当前逻辑仍先 `SELECT` 再 `INSERT`，数据库表没有 `(user_id, harness, event_id)` 唯一约束。两个并发请求可同时查不到记录、同时插入，并分别进入异步 `notifyHookEvent`；这会产生重复事件和重复站内/Bark 通知，违背任务书的幂等承诺。
- 建议：将 `event_id` 提升为独立列（或建立可靠的表达式唯一索引），使用 `INSERT ... ON CONFLICT DO NOTHING`，根据插入结果决定是否通知；迁移需兼容旧记录和无 `event_id` 的旧客户端。
- Status: open

### 3. 迁移备份与 CLI 的 list/restore/rollback 使用了两套不兼容的备份命名空间

- Severity: bug
- 文件:行：`CrewRouterHelper/src/migration.js:13-23`；`CrewRouterHelper/bin/cr-report.js:42`
- 描述：迁移备份写入 `crewrouter-helper-backups/<timestamp-random>/`，由 `listMigrationBackups()` 管理；但 `migration.listBackups()` 却转调 `src/backup.js` 的 Hook 备份列表。CLI 的 `backup list` 调用前者，无法列出 `backup create` 刚创建的迁移备份；CLI 的 `backup restore` 也把 Hook 备份名交给迁移 `restoreBackup`，通常会报“备份不存在”。`rollback` 无 ID 时同样从错误的 Hook 备份列表选取 ID。
- 建议：明确区分命令语义并统一实现：迁移备份相关命令全部使用 `listMigrationBackups`，Hook 备份保留独立命令/名称空间；为 `backup create -> list -> restore` 和 `migrate -> rollback` 增加临时 HOME 的端到端测试。
- Status: open

### 4. 迁移回滚不是原子操作，恢复失败可能留下半恢复状态

- Severity: bug
- 文件:行：`CrewRouterHelper/src/migration.js:18,20`
- 描述：`restoreBackup` 按文件逐个 `atomicCopy`。如果配置已恢复而 Hook 文件在后续校验、读取或复制时失败，函数会中断但不会恢复已经写入的前一个文件；`migrate` 的异常处理再次调用同一个恢复函数，并且把恢复异常吞掉。因此“失败时尝试恢复”不能保证配置和 Hook 一致，可能留下半迁移状态。
- 建议：恢复前先完整校验 manifest、所有源文件和目标路径；将每个目标写入临时文件后再统一替换，失败时用预恢复快照回滚；恢复失败必须显式报告并返回非零状态。不要吞掉二次回滚错误。
- Status: open

### 5. 迁移备份 manifest 中的 SHA-256 未在恢复时校验

- Severity: suggestion
- 文件:行：`CrewRouterHelper/src/migration.js:14,18`
- 描述：创建备份时记录了 `sha256`，但恢复时只检查文件存在和普通文件属性，不校验 manifest 的文件名、哈希及完整结构。备份内容损坏或被替换时仍可能被恢复，削弱了生产迁移的安全回滚保障。
- 建议：恢复前严格校验 manifest 的版本、ID、允许文件集合、路径及每个文件的 SHA-256；发现不匹配时拒绝恢复，并保留原文件不变。
- Status: open

### 6. `clients setup NAME --yes` 没有执行 setup/install，CLI 参数契约与帮助及 README 不一致

- Severity: bug
- 文件:行：`CrewRouterHelper/bin/cr-report.js:42`
- 描述：`extras` 中 `sub === 'inspect' || sub === 'setup'` 两种子命令都调用 `api.clientInspect(...)`，没有调用 `api.setup(...)`，也没有消费 `--yes`。因此文档承诺的 `clients setup grok --yes` 不会安装 Hook，只会输出探测信息；对 Grok 来说这是静默的契约失效。
- 建议：`clients setup` 调用 `api.setup`，将 `--yes` 映射为确认状态，并在实际写入前保留冲突拒绝、备份和验证；`inspect` 继续保持只读。补充 CLI 黑盒测试验证无 `--yes` 只计划、有 `--yes` 才应用。
- Status: open

### 7. 远程测试会进入正常通知链，可能向生产用户发送测试通知

- Severity: suggestion
- 文件:行：`CrewRouterHelper/src/reporter.js:10-25`；`server/routes/client-events.js:185-194`
- 描述：`remote test` 使用普通 `/api/client-events` 上报真实事件类型和固定测试会话；服务端对其没有测试标识或抑制逻辑，仍会异步匹配通知规则并发送站内通知/Bark。生产环境执行验收命令可能产生用户可见的假告警，违反“测试不扰动生产通知”的安全预期。
- 建议：为远程测试增加不可伪造或服务端可验证的测试标志/专用 endpoint，并在服务端明确跳过持久通知；至少在响应和文档中警示会触发通知，并增加启用通知规则时的测试覆盖。
- Status: open

### 8. `live` 聚合对历史非数值 latency 数据不具备兼容性，可能导致整个看板 500

- Severity: suggestion
- 文件:行：`server/routes/client-events.js:220-225`
- 描述：SQL 直接执行 `(payload->>'latency_ms')::numeric`。历史数据、旧客户端或人工导入数据只要存在非数值 `latency_ms`，整个聚合查询就会抛错，前端实时活动看板无法加载；当前客户端入口的数值限制不能保护既有数据库内容。
- 建议：在 SQL 中先用正则/JSON 类型安全判断后再转换，或迁移 latency 字段为数值列并清洗旧数据；增加包含脏历史 payload 的查询测试。
- Status: open

## 结论

当前变更不能标记为“无问题”：至少存在 `event_id` 去重失效、并发幂等不成立、迁移备份 CLI 不可用、迁移回滚非原子以及 `clients setup` 契约失效等生产阻断问题。现有 Helper 单元测试全部通过，但未覆盖上述服务端并发、通知副作用和迁移命令端到端场景。
