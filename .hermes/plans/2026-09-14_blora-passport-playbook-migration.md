# CrewRouter Blora Design 迁移任务书（Passport playbook 版）

> 派发方式：单会话长上下文，从阶段 0 跟到收尾。不要多会话接力，不要批量提交后一起验收。
> 核心纪律：**改一页 → 构建验证一页 → commit → 等用户截图反馈 → 再改下一页。**

## 背景（已确认，不要重做）

- 本仓库之前有一轮 ~50 commits 的批量迁移（分支 `blora-migration`，HEAD 462a61d），因界面混乱被用户整体回滚。**禁止 merge / cherry-pick / reset 到该分支**；你可以 `git show blora-migration:<path>` 只读参考个别文件，但不得整段照搬。
- `main` 当前 HEAD = `2fcd114`（统一模型管理页面控件样式），工作树干净，只有未跟踪目录 `blora-design/`（上游框架源码克隆，含 docs 与 examples），保持未跟踪，不要 commit 它。
- npm 依赖已是 `@bloret-crew/blora-design@2.0.8`（package.json）。迁移文档：`blora-design/docs/migration/from-any-ui-to-blora-design.md`；视觉基准：`blora-design/examples/bbbs-replica/index.html`。
- 前端缓存版本：`public/pages/console.html` 用 `app.js?v=55`，`admin.html` 用 `admin.js?v=19`。**凡改 public/js/app.js 必须 v=56 起递增，改 admin.js 同理递增**，改完 `npm run build`。
- 构建 `npm run build`（esbuild + 混淆，约 30s）。验证命令：`node server/scripts/test-request-source.js`、`node server/scripts/test-usage-accuracy.js`。
- 服务由 MCSManager 守护 :20003，kill -9 后自动拉起；**你不需要重启服务，用户会自己刷新页面验收**。

## 迁移次序（一页一个 commit）

从视觉入口页开始，按用户验收节奏推进，建议顺序：

1. `public/pages/login` 相关（index.html / set-password.html / oauth-consent.html）
2. `console.html`（模型库 → 会话 → 设置，一区块一 commit）
3. `admin.html`（用户 / 用户组 / Team / 模型管理，一区块一 commit）
4. 其余低频页（usage / store / playground / purchase / data / feishu-bind / setup / plugin-install / showcase）

每页要求：

- 严格按迁移文档选择控件；能用 Blora 组件（blora-pagination / blora-checkbox / blora-tabs / message 等）就不手写。
- 图标一律 SF：`img.bloret.net/SF/<name>?color=white`，class `sf-icon`。禁止 Lucide、禁止 emoji 图标。
- 改完该页先 `npm run build` + 相关验证脚本通过，再 commit（Conventional Commits，简体中文正文）。
- commit 后停手，输出一句「已完成 <页面>，等截图验收」，不要继续下一页。

## 红线

- 禁止碰 `server/store/passport.js`。
- 禁止操作 `blora-migration` 分支（merge/rebase/reset/cherry-pick/push 全部禁止）。
- 禁止把 `blora-design/` 未跟踪目录加入任何 commit。
- 禁止 reset / push / 强制操作；只 commit 在 main 上。
- 禁止一次性迁移多页；用户截图反馈发现问题就修当前页，修完同样等验收。

## 输出要求

每个 commit 后输出：改动页面、用了哪些 Blora 控件、构建与验证结果。不写总结长文。

## 用户验收反馈（2026-09-14 晚，stage 1 登录页）

用户原话：「明显不对，继续改设计，另外我没有做注册功能啊」

已核实的事实（不要重新调查）：
- 服务端没有注册路由：POST /auth/register 返回 404，server/routes/auth.js 只有 login / login/2fa / logout / me / set-password / change-password。
- 但迁移前的 index.html（2fcd114）就带 registerPanel/registerForm 死面板，本轮迁移原样保留了它，还在上面放了 blora-segmented 登录/注册切换。

本轮要求：
1. 彻底移除登录页的注册入口：删除 blora-segmented 切换器、registerPanel/registerForm/register* 字段及 index.html 内对应 JS 切换逻辑。登录表单成为唯一主体（页面结构参照 blora-design/examples/bbbs-replica 与 Passport 登录页：Logo+标题居中，表单为主，底部语言/主题切换低调排布）。
2. 顺带检查 index.html 内残留的注册相关 CSS（auth-register-form 等）一并清理。
3. 改完 npm run build + 双验证脚本，一个 commit（简体中文 conventional message）。
4. 不碰 blora-migration 分支、不提交 blora-design/、不 push。

## 进度记录

- 2026-09-14 晚：stage 1（index.html / set-password.html / oauth-consent.html）登录页经用户确认验收通过。
- 下一站：stage 2 — console.html，按任务书「一区块一 commit」：模型库 → 会话 → 设置。每区块改完 build+验证+commit 后停下等截图验收。
- 注意：改 public/js/app.js 必须 v=56 起递增；admin.js 同理。

## 进度更新

- stage 1 登录三页 ✅、模型库 ✅、版本徽章打磨 ✅
- 当前：stage 2 继续 — 会话区块（console.html 的会话部分，一区块一 commit，改完停手等截图验收）
- API Key 区块的打磨清单已记录在会话 87e555d 的报告里，迁到该区块时一并处理
- app.js 当前 v=57；再改则 v=58 起

## 本轮继续任务（2026-09-20，Grok Build）

当前工作树存在并行/既有未提交改动，**不得 reset、stash、清理、切换分支或覆盖它们**。本轮只做会话区块的验收与必要修复；不要碰 `CrewRouter-Desktop/`、`server/index.js`、`review-desktop*.md`、`public/css/settings-blora.css`、`blora-design/`，也不要覆盖并行会话的 `app.js` 改动。禁止 push。

### 第一阶段：恢复并完成会话区块视觉验收（必须先做）

1. 先执行 `git status --short`、`git diff --stat`、`git log --oneline -8`，确认只在允许范围内工作；不要把其他未提交改动纳入提交。
2. 检查并恢复隔离验收环境：只用临时端口 `21003` 和临时数据库/配置，不碰生产端口、生产数据库或生产页面。若测试夹具缺失，恢复一个测试账号和 3 个测试会话。不要把 `router.bloret.net` 或生产页作为证据。
3. VNC `:1` 的 Chrome 必须实际打开正确的临时测试页（目标应为 `http://127.0.0.1:21003/...`），按真实用户路径进入 console 的“会话”区块并截图。截图前确认地址栏和窗口标题，避免截到生产页、旧标签页、登录页或其他区块。
4. 使用 Read 工具实际读取截图内容，并明确输出三选一：`PASS`、`OLD RENDER`、`STALE`。只有截图中确实可见以下内容才算 PASS：顶栏标题为“会话”；两个筛选下拉初始值分别为“最近 7 天”和“全部客户端”；布局未裁切、无白屏/登录页/加载失败。截图文件存在不等于通过。
5. 若不满足，立即只修会话区块，尤其检查运行时默认值、标题文本、缓存版本（`app.js` 若需修改必须从 v=58 递增），实际重新启动临时环境并重新截图读图；不要继续下一块。
6. 会话区块通过后，运行 `npm run build`、`node server/scripts/test-request-source.js`、`node server/scripts/test-usage-accuracy.js`，只提交本轮会话区块相关允许文件，提交信息用简体中文 Conventional Commit。提交前检查 `git diff --cached`，绝不纳入红线文件或其他并行改动。然后停手。

### 第二阶段（只有第一阶段 PASS 且已提交后才允许）

继续下一个单独区块：会话详情/时间线。先读现状和相关 API，按一区块一 commit 实现；同样 build + 双验证 + 实际临时环境截图 + Read 读图，完成一个区块就停手，不要顺带改 console.html 后续其他区块。

### 第二阶段验收结果（2026-09-21）
第一阶段实际结果：Grok 在临时环境 `http://127.0.0.1:21003/pages/console.html#sessions` 完成真实浏览器路径验收，截图 `/tmp/crewrouter-vnc-sessions-pass.png`，Read 判定 `PASS`。截图确认标题“会话”、默认筛选“最近 7 天”和“全部客户端”、无裁切/白屏/登录页/加载失败。`npm run build`、`node server/scripts/test-request-source.js`、`node server/scripts/test-usage-accuracy.js`、相关 node --check 均通过。会话区块无需修复，没有新增代码或 commit。`scripts/test-blora-public-batch-c.js` 仍有与本轮无关的旧模型库断言失败，不得借此改模型库。

现在只推进下一个独立区块：会话详情/时间线。先检查当前工作树、最近提交和会话详情现状/API；不得 reset、stash、清理、切换分支或覆盖并行未提交改动。只允许修改会话详情/时间线相关文件，禁止顺带改 console.html 后续其他区块。按一区块一 commit 实现：使用现有 Blora 控件与 SF 图标，完成后运行 `npm run build`、`node server/scripts/test-request-source.js`、`node server/scripts/test-usage-accuracy.js`，在隔离临时环境（优先 :21003，临时数据库/夹具，不碰生产）按真实用户路径打开详情/时间线并截图，使用 Read 实际读图并输出 `PASS`/`OLD RENDER`/`STALE`。截图和静态验证都通过后，只提交本区块允许文件；提交前审查 `git diff --cached`，不要纳入 CrewRouter-Desktop、server/index.js、review-desktop*.md、public/css/settings-blora.css、blora-design/ 或并行 app.js 改动。禁止 push。完成本区块后停手并报告真实 commit、改动文件、命令输出、临时 URL/截图路径和 Read 判定；若网关 429/520/ECONNRESET/usage limit，停止并如实报告。禁用继续其他区块。

### 输出

完成时报告：真实 commit、允许文件清单、build/两个脚本实际输出、临时端口/数据库与截图路径、Read 对截图的 `PASS/OLD RENDER/STALE` 判定；未验证或阻塞项必须明确写出。遇到 Grok 网关 429/520/ECONNRESET/usage limit，停止本轮，不要自己实现，也不要密集重试。

### 当前续派状态（2026-09-21，改用 Grok Build CLI）
- 已确认当前 HEAD 为 `f93f026 chore: 完成会话详情视觉验收`，此前 `7e151c7 fix: 完善会话详情标题与缓存刷新`；任务书记录的会话详情/时间线阶段已由先前执行器提交，但本轮必须由 Grok 重新检查真实 diff、验证证据和当前工作树，不能信任提交标题。
- 当前工作树有大量明确禁止纳入本轮提交的 Desktop、`server/index.js`、`public/css/settings-blora.css`、`review-desktop*.md`、`blora-design/` 等并行改动；绝不 reset/stash/清理/切换分支，也不要覆盖它们。
- 本轮使用 Grok Build CLI 执行。先检查 `git status --short`、`git diff --stat`、`git log --oneline -8`，再审查 `f93f026`/`7e151c7` 的实际改动范围；若会话详情/时间线已满足任务书且已有真实视觉与静态验证证据，则不要重复实现，进入下一独立 console 区块前先把缺口和允许文件范围写清楚。
- 如需继续实现，只推进一个独立区块，并严格遵守一区块一 commit、build + 双验证 + 隔离临时环境 `:21003` 实际浏览器路径 + 截图 Read 判定；禁止使用生产页面/生产数据，禁止碰任务书红线文件或并行 `app.js` 改动，禁止 push。
- Grok 输出必须包含真实 commit、改动文件、build/`test-request-source.js`/`test-usage-accuracy.js` 实际结果、临时 URL/数据库、截图路径和 Read 的 `PASS`/`OLD RENDER`/`STALE`；若网关 429/520/ECONNRESET/usage limit，立即停止并报告，不重试。
