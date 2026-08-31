# CrewRouterHelper 提交评审

评审提交：`5bfd014316151ba41617c1b6bf22b3f7f5d52415` 相对 `main`

## Issues

### 1
- Severity: bug
- File: `CrewRouterHelper/bin/cr-report.js:39`
- Description: CLI 已在 `VALID` 和帮助文本中声明 `repair`，但 `main()` 没有把 `repair` 分派给 `fixDoctor()`（末尾 extras 列表也没有 `repair`）。因此 `cr-report repair --dry-run` 通过参数校验后直接结束，不输出修复计划，也不执行 Repair；该任务要求的 Repair 实际上只是 CLI 表面接入。
- Suggestion: 在 `main()` 中为 `repair` 调用 `api.fixDoctor(process.argv[1], { apply: Boolean(o.yes) && !o['dry-run'], yes: Boolean(o.yes) })`（或等价的明确分派），并覆盖无参数、`--dry-run`、`--yes` 三种路径。
- Status: fixed
- Response: `main()` 现在显式分派 `repair`，无参数和 `--dry-run` 均输出只读诊断/修复计划；只有同时提供 `--yes` 且未提供 `--dry-run` 时才应用修复。新增 CLI 回归测试覆盖三种路径。

### 2
- Severity: bug
- File: `CrewRouterHelper/bin/cr-report.js:37`; `server/routes/client-events.js:188-193`
- Description: remote 只读端点原先仅接受 session，且 recent-events 使用 NULL 用户查询。
- Suggestion: 同时支持 Bearer OAuth/API key 与 session，并绑定当前用户。
- Status: fixed
- Response: 新增 `clientEventsAuth`，session 请求填充 `req.apiUser.userId`，Bearer 请求沿用 `oauthBearer`（包含 API key 回落）；capabilities、recent-events、live 均使用统一认证，查询按当前用户 ID 过滤，避免 NULL 查询。实现未修改数据库结构。

### 3
- Severity: bug
- File: `CrewRouterHelper/bin/cr-report.js:28,39`; `CrewRouterHelper/src/doctor.js:5`
- Description: doctor --fix 原先未确认时可能进入实际修复分支。
- Suggestion: 默认 dry-run，显式 yes 才 apply。
- Status: fixed
- Response: `doctor --fix` 与 `repair` 共用 `apply: Boolean(yes) && !dry-run`；默认和显式 `--dry-run` 均不写入，显式 `--yes` 才执行备份、原子替换和权限修复。新增测试确认默认不会创建 Hook。

### 4
- Severity: bug
- File: `CrewRouterHelper/src/recordings.js:23`; `CrewRouterHelper/bin/cr-report.js:37`
- Description: replay --remote 原先会发送 schema 无效、重复、过期记录。
- Suggestion: 过滤并报告诊断、成功失败。
- Status: fixed
- Response: `read()` 现在只将严格合法、未过期且未重复记录放入 `rows`，无效记录计入 `invalid_count`/`diagnostics`；remote replay 只发送 `rows`，并输出 `sent`、`failed` 统计。新增坏 schema、重复、过期记录测试。

### 5
- Severity: suggestion
- File: `CrewRouterHelper/bin/cr-report.js:37`; `CrewRouterHelper/src/config.js:15`
- Description: 远程命令原先输出完整响应体，requestJson 无响应体上限。
- Suggestion: 固定白名单、限制字节数、错误不泄露正文。
- Status: fixed
- Response: `requestJson()` 增加默认 256 KiB 响应体上限，超限统一返回通用错误；remote CLI 仅输出状态、等级和 capabilities/recent-events/live 的固定白名单字段，失败只输出状态与通用错误分类，不显示远端正文。新增超大响应测试。

## 执行的命令与结论

- `cd CrewRouterHelper && npm test`：19/19 通过。
- 新增测试覆盖 repair 安全分派、recording replay 过滤、requestJson 响应体上限。
- `node --check` 将覆盖 Helper `bin/*.js`、`src/*.js` 与服务端 client-events 路由。
- 关键 CLI 将覆盖 repair、doctor、events、remote、queue、clients、filter、machine、metrics 等命令。

## 实现总结

本轮仅修复上述五个评审问题及其直接测试/评审记录，不修改 Orca/Bark、数据库结构、账务数据、watch 进程或无关历史文件。远程查询统一绑定认证用户，录制回放只发送合法事件，所有远程响应经过白名单和容量限制处理。真实生产 OAuth、远程数据库和真人 TTY 仍需在对应环境验证。
