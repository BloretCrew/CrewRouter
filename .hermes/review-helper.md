# CrewRouterHelper 提交评审

评审提交：`5bfd014316151ba41617c1b6bf22b3f7f5d52415` 相对 `main`

## Issues

### 1
- Severity: bug
- File: `CrewRouterHelper/bin/cr-report.js:39`
- Description: CLI 已在 `VALID` 和帮助文本中声明 `repair`，但 `main()` 没有把 `repair` 分派给 `fixDoctor()`（末尾 extras 列表也没有 `repair`）。因此 `cr-report repair --dry-run` 通过参数校验后直接结束，不输出修复计划，也不执行 Repair；该任务要求的 Repair 实际上只是 CLI 表面接入。
- Suggestion: 在 `main()` 中为 `repair` 调用 `api.fixDoctor(process.argv[1], { apply: Boolean(o.yes) && !o['dry-run'], yes: Boolean(o.yes) })`（或等价的明确分派），并覆盖无参数、`--dry-run`、`--yes` 三种路径。
- Status: open

### 2
- Severity: bug
- File: `CrewRouterHelper/bin/cr-report.js:37`; `server/routes/client-events.js:188-193`
- Description: `remote status|capabilities|recent-events` 使用 `api.requestJson()` 携带 Bearer token，但服务端三个只读端点都挂在 `requireAuth` 上，只接受浏览器 session，不接受 `oauthBearer`/API Key。由 CLI 发起的远程调用会得到 401，因而这些远程命令无法工作。与此同时，`requireAuth` 不设置 `req.apiUser`，即使通过浏览器 session 访问 `recent-events`，查询条件也固定为 `user_id = NULL`，正常用户看不到自己的事件。
- Suggestion: 为远程 API 端点使用与事件上报一致的 Bearer 鉴权（或显式同时支持 session 和 Bearer），并从 session 用户填充用户 ID；查询应始终绑定当前认证用户。补充带 OAuth/API Key 和 session 的路由测试。
- Status: open

### 3
- Severity: bug
- File: `CrewRouterHelper/bin/cr-report.js:28,39`; `CrewRouterHelper/src/doctor.js:5`
- Description: `doctor --fix` 仍以 `apply: !o['dry-run']` 调用 Repair。没有 `--dry-run` 时它会进入实际修复分支，并因为缺少 `--yes` 抛出错误，而不是按要求默认返回只读 dry-run 计划；只有显式 `--dry-run` 才是计划模式，显式 `--yes` 才真正修改。该行为既不符合“兼容的 doctor --fix 默认 dry-run”，也使默认命令不是安全的可重复检查。
- Suggestion: 将 `doctor --fix` 的默认 `apply` 设为 false，只有同时显式提供 `--yes` 且未提供 `--dry-run` 时才 apply；默认输出与 `repair --dry-run` 一致的计划和变更标记。
- Status: open

### 4
- Severity: bug
- File: `CrewRouterHelper/src/recordings.js:23`; `CrewRouterHelper/bin/cr-report.js:37`
- Description: `events replay FILE` 的 `read()` 会把 schema 无效、重复或过期记录加入 `rows`，仅把问题写进 `diagnostics`；当使用 `--remote` 时 CLI 仍遍历全部 `rows` 并调用 `api.report()`。因此损坏/过期/重复录制会被实际远程重放，且重放请求携带录制格式的 `schema_version`/`recorded_at`，没有在发送前完成严格 schema 校验或去重。
- Suggestion: 将无效记录排除出可回放集合；远程回放前验证统一事件 schema、明确处理过期事件和重复事件（默认拒绝或要求显式确认），并报告成功/失败数量，而不是只输出诊断信息后照发。
- Status: open

### 5
- Severity: suggestion
- File: `CrewRouterHelper/bin/cr-report.js:37`; `CrewRouterHelper/src/config.js:15`
- Description: 远程命令直接输出 `requestJson()` 返回的完整 JSON body（`body: r.body && {...r.body}`），而 `requestJson()` 会读取并解析响应正文。当前服务端新增接口返回的是最小字段，但 CLI 没有响应字段白名单；配置指向任意受控/被篡改服务时，远端可将错误详情或敏感字段原样显示。网络层也没有响应体大小上限。
- Suggestion: 远程命令只输出固定的状态和经过白名单过滤的 capabilities/recent-events 字段；对响应正文设置字节上限，超限即中止，错误只显示通用分类和 HTTP 状态，不显示原始正文。
- Status: open

## 执行的命令与结论

- `cd /tmp/CrewRouterHelper && npm test`（目标提交快照）：通过，16/16。
- `node server/scripts/test-client-events.js`：通过，12 项契约断言。
- `node server/scripts/test-task5a-static.js`：通过。
- `node --check server/routes/client-events.js`：通过。
- `node --check CrewRouterHelper/bin/cr-report.js` 及 `CrewRouterHelper/src/*.js`：通过。
- 关键 CLI smoke：`repair --dry-run` 返回 0 但无任何输出，确认未分派；`events replay` 缺少文件时报 ENOENT；`remote nonsense` 正确拒绝未知子命令；其余无配置命令受环境配置影响，未发现语法错误。

结论：既有 Helper 测试和服务端静态契约均通过，但新增 Repair/远程接口存在功能性阻断，且 doctor 默认修复语义、录制回放校验和远程响应泄露边界不满足任务要求。Issues 共 5 项，均为 `open`。
