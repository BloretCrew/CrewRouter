# Edition 实现审查

审查提交：`e263a4f765d693058599e6d14b4a4257bb725473`（相对父提交的全部改动）  
任务书：`/data/CrewRouter/.hermes/plans/2026-08-31_crewrouter-editions_task.md`

## Issues

### Issue 1
- severity: bug
- file: `/root/.grok/worktrees/data-crewrouter/subagent-01a057e4-1291-7b71-b545-46f6cf618702/server/index.js:2744-2750`
- description: 启动时只要配置了 `config.edition`（包括 `CR_EDITION` 或复制 `config.example.json` 得到的值），就会在发现数据库没有 `instance_settings` 记录后直接调用 `initializeEdition`。这条路径没有执行 setup 路由中的旧安装兼容检测，也没有要求 `confirmExisting`。因此，一个已经存在用户、团队或其它历史团队数据但尚未写入 edition 的旧安装，重启时可被 `CR_EDITION=personal`（当前示例配置甚至默认是 personal）静默标记为 Personal，违反“不能猜测、不能静默标记 live existing database”的要求；之后个人版的 gating 会改变该实例的可用 API 表面。
- suggestion: 将“无 persisted edition”的配置初始化限制为明确的新安装判定，或在启动时检测完整的历史团队信号（至少用户数量、`users.team_id`、`user_teams`、`teams`、`api_key_members` 等）并拒绝自动初始化，要求通过一次受保护且明确确认的迁移流程完成。示例配置不应在旧库启动时形成隐式选择；冲突/兼容错误应以可操作的启动错误呈现。
- Status: open

### Issue 2
- severity: bug
- file: `/root/.grok/worktrees/data-crewrouter/subagent-01a057e4-1291-7b71-b545-46f6cf618702/server/routes/admin.js:27,1012-1040`
- description: Personal Edition 仅对 `/user-groups` 和 `/audit-logs` 加了 guard，但管理员的多维统计 `/api/admin/stats/multi/filters` 与 `/api/admin/stats/multi` 仍可访问，并且会直接返回/聚合 users、teams、groups、projects 等团队管理维度。该入口未被 gating，Personal 管理后台仍能读取团队/项目数据，违反“团队成员/项目/团队配额管理不可用”以及“Personal 不得通过 alternate endpoints 暴露团队数据”。
- suggestion: 把真正团队专属的管理员统计及其筛选接口纳入集中 capability guard（或拆分出 Personal 安全的统计查询）；为 Personal 请求增加路由级稳定 `403` 和 `team_edition_required` 测试，同时确认其它管理员核心模型/供应商/个人用量接口仍可用。
- Status: open

### Issue 3
- severity: bug
- file: `/root/.grok/worktrees/data-crewrouter/subagent-01a057e4-1291-7b71-b545-46f6cf618702/public/js/app.js:200-201,414-497`；`/root/.grok/worktrees/data-crewrouter/subagent-01a057e4-1291-7b71-b545-46f6cf618702/public/pages/console.html:84-103`
- description: Personal bootstrap 只隐藏 `[data-team-only]`、包含 `adminTeams`/`adminUserGroups` 的链接，但“项目工作”（`projectWork`）和用户侧“操作日志”（`auditLogs`）导航没有这些标记，仍会在 Personal 版显示。项目工作实际调用被 gating 的 `/api/user/project-stats`，用户侧操作日志调用 `/api/user/audit-logs`；用户点击后会看到不可用/403 页面。`auditLogs` 也没有在隐藏选择器中处理。这样既误导用户，也未满足桌面/移动导航一致的 gating 展示要求。
- suggestion: 给所有明确由 `projects`/`auditLogs` capability 控制的导航项和对应页面入口统一加语义标记，并在 bootstrap 后根据 capability 隐藏；同时在 `navigateTo`/hash 恢复时把直接访问这些 page 的请求重定向到可用页面，不能只依赖 CSS。为移动导航和旧 hash 链接补充静态/浏览器测试。
- Status: open

### Issue 4
- severity: bug
- file: `/root/.grok/worktrees/data-crewrouter/subagent-01a057e4-1291-7b71-b545-46f6cf618702/server/routes/setup.js:50-79`
- description: `/api/setup/edition` 在 `setup_complete` 已存在时仍允许任何未认证请求进行旧安装 edition 迁移；`requireEditionSetup` 只检查 edition 是否为空。即使这是有意支持旧安装，接口没有认证或一次性迁移凭据，且 `confirmExisting: true` 只是客户端可伪造的 JSON 字段。对没有被当前两张表检测到团队数据的旧库，远程请求者可以抢先永久选择版本；对有数据的库也只需直接发送确认字段即可绕过 UI 确认。该接口会改变实例级不可变安全配置。
- suggestion: 旧安装迁移应要求已有管理员 session、一次性管理操作/本地安装令牌，或在受信任的启动/CLI 流程完成；服务端在同一事务内重新执行全面兼容检测并记录迁移状态。`confirmExisting` 只能作为已认证管理员的明确确认，不应被视为授权。
- Status: open

## 结论

提交实现了基本的 singleton 表、事务 advisory lock、配置冲突检查、公开 metadata 和部分 route guard；新增纯函数及 fake DB 测试也通过。但当前不能判定满足任务书：旧安装可被配置静默转换，管理员统计存在绕过 gating 的团队数据入口，Personal 前端仍展示至少两个实际不可用的入口，并且旧库 edition 迁移端点缺少授权。建议先修复上述 open issues，再进行任务书要求的隔离服务验证及完整回归测试。

## 已执行验证

- `git diff --check e263a4f^ e263a4f`：通过。
- `node --check server/utils/instance-edition.js`：通过。
- `node --check server/routes/setup.js`：通过。
- `node server/scripts/test-instance-edition.js`：通过。
- `node server/scripts/test-instance-edition-persistence.js`：通过。
- 未启动临时服务，未触碰生产端口 `20003`、Show 端口 `20004` 或生产数据库；因此任务书要求的隔离服务矩阵、真实 HTTP gating、完整现有回归测试和 build 未在本次审查中宣称已验证。
