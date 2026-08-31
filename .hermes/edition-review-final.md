# Edition 最终代码第二轮独立审查

审查范围：当前 worktree 最终代码，包含 edition 原始实现及 `a7709802d878af266a3b1e574576a33545b5cd92`。  
任务书：`/data/CrewRouter/.hermes/plans/2026-08-31_crewrouter-editions_task.md`

## Issues

### Issue 1
- severity: bug
- file: `/root/.grok/worktrees/data-crewrouter/subagent-01a057e4-1291-7b71-b545-46f6cf618702/public/pages/setup.html:208-220,262-279`；`/root/.grok/worktrees/data-crewrouter/subagent-01a057e4-1291-7b71-b545-46f6cf618702/server/routes/setup.js:40-90`
- description: 旧安装迁移路径在 edition 选择成功后仍会把界面推进到账号模式选择（`stepMode`）。但旧安装已有 `setup_complete` 时，`/api/setup/mode` 始终由 `requireSetupMode` 返回 403（系统已初始化，无法再次执行 OOBE）。因此带有旧数据且缺失 edition 的实例，即使已按要求登录管理员并确认迁移，也会进入一个必然失败的 setup 状态；用户只能刷新页面后看到“无需重复配置”，无法在同一次迁移流程得到成功/完成反馈。该问题使任务书要求的“旧安装兼容路径可用”在真实 UI 流程中不成立。
- suggestion: edition 选择成功后重新读取 setup 状态：若 `setup_complete` 已存在，应直接显示迁移完成/返回登录或控制台，而不是显示账号模式选择；或者由 edition API 返回明确的 `existingInstallation`/`setupComplete` 状态并由前端结束流程。保留后端管理员认证、服务端二次 legacy 检测和不可变持久化。
- Status: open

## 上一轮 4 个问题复核

1. **旧安装被配置静默标记 Personal：已修复。** `ensureInstanceEdition()` 在有 `CR_EDITION` 且无持久化记录时调用 `inspectLegacyData()`；发现历史数据即以 `EDITION_LEGACY_CONFIRMATION_REQUIRED` 拒绝启动。`initializeEdition()` 也在 advisory transaction lock 内再次检查 legacy 数据，避免仅依赖请求前检查。
2. **管理员多维统计绕过 gating：已修复。** `/stats/multi` 与 `/stats/multi/filters` 已加入 admin router 的集中 Team guard。
3. **Personal 前端显示项目工作/操作日志：已修复。** console/admin 导航已使用 `data-capability`，bootstrap 按服务端 capabilities 隐藏；console 的 `navigateTo()` 也会对直接访问 `projectWork`/`auditLogs` 进行 fallback，admin 对直接团队 hash 有 fallback。
4. **旧安装 edition 迁移未认证：已修复。** `requireEditionSetup()` 对已有 `setup_complete` 的请求要求 session，并通过 `requireAdmin()` 重新读取管理员权限；迁移 API 内部还重新执行 legacy 检测并将确认传给原子初始化逻辑。

## 其它重点检查结论

- 持久化不可变性：`instance_settings` 单例主键/检查约束，加上事务级 advisory lock；重复同值初始化可接受，冲突值拒绝。未发现可通过配置覆盖已持久化 edition 的路径。
- 路由顺序与认证：Team guard 在各路由的 `requireAuth`/`requireAdmin` 之前运行，但对未登录请求放行，随后由既有认证中间件返回 401；已登录 Personal 请求得到稳定 `team_edition_required` 403。未发现因此误伤 `/v1`、个人 Key、核心用量、会话或 Playground 的问题。
- 团队入口覆盖：团队管理路由、邀请路由、Co-Key 成员、用户/管理员操作日志及管理员多维统计均有对应 gating；模型库等核心个人功能仍保留。前端缓存参数已随 `app.js`/`admin.js` 改动递增。
- 敏感信息：`/api/instance` 仅返回 edition/capabilities；未发现新增返回数据库配置、Provider key、session secret 或原始环境变量。
- 数据库 adapter：生产 `pg.Pool`/`pool.connect()` 与无 `connect()` 的 query adapter 形态均被 `initializeEdition()` 处理；事务/释放逻辑与 fake adapter 测试路径一致。当前新增 fake 测试没有覆盖真实 PostgreSQL 并发，但实现本身使用数据库 advisory lock 与 singleton constraint。

## 验证

- `git diff --check HEAD^ HEAD`：通过。
- `node --check server/utils/instance-edition.js`：通过。
- `node --check server/routes/setup.js`：通过。
- `node --check public/js/app.js`：通过。
- `node --check public/js/admin.js`：通过。
- `node server/scripts/test-instance-edition.js`：通过。
- `node server/scripts/test-instance-edition-persistence.js`：通过。
- `npm run build`：未通过，阻塞于当前 worktree 缺少 `esbuild`（`Cannot find module 'esbuild'`），不是由 edition 代码诊断出的构建错误。
- 未启动临时服务，未触碰生产端口 `20003`、Show 端口 `20004` 或生产数据库；因此任务书要求的真实 HTTP/隔离服务矩阵未完成，不能宣称通过。

## 结论

上一轮 4 个 bug 的后端与导航修复均已在最终代码中落地，且未发现新的持久化覆盖、认证顺序、核心 API 误 gating 或敏感信息暴露问题。但旧安装迁移的实际 OOBE 页面仍会错误进入不可执行的账号模式步骤，存在 1 个 open bug。修复该 UI 流程并在隔离临时服务中完成任务书规定的 HTTP 矩阵后，才可判定 edition 实现完整通过。
