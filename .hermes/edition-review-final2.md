# Edition 最终代码第三轮审查

审查范围：当前最终 worktree，包含 `08f98f8c5662c87fac642e78e672553dfa2da6fc` 及此前 edition 实现/fix 提交。  
任务书：`/data/CrewRouter/.hermes/plans/2026-08-31_crewrouter-editions_task.md`

## Issues

**0 open issues。**

## 上一轮唯一问题复核

已修复。旧安装迁移成功后，后端 `/api/setup/edition` 现在返回 `existingInstallation` 和 `setupComplete`；前端 `chooseEdition()` 检测这两个字段后直接隐藏 edition 卡片并展示 `stepReady`，不会再进入因 `setup_complete` 已存在而必然返回 403 的账号模式选择步骤。相关修复位于：

- `/root/.grok/worktrees/data-crewrouter/subagent-01a057e4-1291-7b71-b545-46f6cf618702/server/routes/setup.js:70-83`
- `/root/.grok/worktrees/data-crewrouter/subagent-01a057e4-1291-7b71-b545-46f6cf618702/public/pages/setup.html:264-283`

新增测试也覆盖了页面存在该分支及完成页面跳转逻辑：

- `/root/.grok/worktrees/data-crewrouter/subagent-01a057e4-1291-7b71-b545-46f6cf618702/server/scripts/test-instance-edition.js:22-24`

## 回归审查结论

- edition 仍只接受 `personal`/`team`；持久化单例、数据库 CHECK 约束、事务 advisory lock 和冲突拒绝逻辑保持不变。
- 旧安装启动时检测历史用户、Team、成员、共享 Key 和邀请数据，不会由配置/env 静默选择 edition；迁移 API 仍要求管理员认证，并在服务端重新检查历史数据。
- Personal Edition 的团队管理、用户组、邀请、共享 Key 成员、项目统计、操作日志和管理员多维统计入口均保留后端 Team guard；核心 `/v1`、个人 Key、模型、用量、会话和 Playground 路径未被本次修复误伤。
- Team guard 位于路由级认证/授权处理之前，但未登录请求仍交给既有 `requireAuth`/`requireAdmin`，Personal 已登录请求获得稳定 `team_edition_required` 403；未发现中间件顺序回归。
- `/api/instance` 仍只返回 edition/capabilities，不包含数据库配置、Provider key、session secret 或原始环境变量。
- console/admin 前端按服务端 metadata 的 `data-capability` 隐藏入口，直接 hash 访问项目工作、操作日志或团队管理页面会回退到可用页面；`app.js` 和 `admin.js` 的缓存版本参数已递增。
- `initializeEdition()` 同时兼容带 `connect()` 的 PostgreSQL Pool 和无 `connect()` 的 query adapter；现有 fake adapter 测试通过。未发现本次提交引入 adapter 兼容回归。

## 验证

- `node --check server/utils/instance-edition.js`：通过。
- `node --check server/routes/setup.js`：通过。
- `node --check public/js/app.js`：通过。
- `node --check public/js/admin.js`：通过。
- `node server/scripts/test-instance-edition.js`：通过。
- `node server/scripts/test-instance-edition-persistence.js`：通过。
- `git diff --check HEAD^ HEAD`：通过。
- 未运行隔离临时服务及真实 HTTP acceptance 矩阵；未触碰生产端口 `20003`、Show 端口 `20004` 或生产数据库。
- 本次未重新运行 `npm run build`；上一轮该命令因 worktree 缺少 `esbuild`（`Cannot find module 'esbuild'`）失败，当前环境未见依赖变化。

## 结论

当前最终 worktree 中，上一轮唯一 open bug 已真实修复，未发现新的 edition 回归或其它应列为 open 的问题。审查结论为 **0 open issues**。隔离服务和完整构建仍属于未验证项，不作为代码问题列出。
