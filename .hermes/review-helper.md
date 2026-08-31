# 实现代理提交 `ac27c4893880356fce8c48732ac13bd606bc1899` 审查

## Issues

### Issue 1
- Severity: bug
- File: `/data/CrewRouter/CrewRouterHelper/src/hooks.js:10`
- Description: `hooks install` 无论目标 `crewrouter-helper.json` 的现有内容是什么，都会把它复制到备份后整体替换。若该目标文件实际由用户维护、包含其他 Hook，安装仍会覆盖其生效配置；这违反任务书“不能覆盖其他 Hook”的红线。`installPlan()` 只报告 `exists`/`will_backup`，没有识别目标是否为本 Helper 自己的、可安全替换的配置。
- Suggestion: 安装前严格校验现有目标是否为本 Helper 生成的完整配置；若不是，dry-run 应明确报告冲突，真实安装直接拒绝且不改目标。即使目标是 Helper 配置，也应保留备份并在计划中区分“安全替换”和“冲突”。
- Status: open

### Issue 2
- Severity: suggestion
- File: `/data/CrewRouter/CrewRouterHelper/bin/cr-report.js:5-20`
- Description: 帮助中的 `hooks install|uninstall|test|list|backup|restore` 没有标明 `hooks install --dry-run`，也没有说明 dry-run 输出的目标路径、是否备份及退出码。实现已接受该参数，但用户仅查看 `--help` 时无法发现本次新增的安全预览入口。
- Suggestion: 在帮助文本中明确列出 `hooks install [--dry-run]`，并补充 dry-run 的只读语义以及参数错误/成功的退出码约定；如 CLI 不支持子命令帮助，至少在顶层帮助覆盖新增选项。
- Status: open

### Issue 3
- Severity: suggestion
- File: `/data/CrewRouter/CrewRouterHelper/test/helper.test.js:9`
- Description: 新增测试只通过模块 API 在“目标不存在”的临时目录中验证 `installPlan()`，没有通过 CLI 进程验证 `hooks install --dry-run` 的退出码和 JSON，也没有覆盖目标已存在时 dry-run 不创建备份、不改目标字节/权限，以及同目录 `orca-status.json`、`bark-notify.json` 保持不变等任务书关键边界。因此 worker summary 中的隔离 CLI 验证是手工证据，回归测试不能防止这些边界回归。
- Suggestion: 增加进程级 CLI 测试：分别覆盖缺失/已有目标、未知选项和帮助；对目标及 Orca/Bark 文件保存 SHA-256/权限快照，执行 dry-run 后逐项断言完全不变，并断言未创建目录、备份或临时文件。
- Status: open

## 验证记录

- 已阅读 `/data/CrewRouter/.hermes/worker-summary-helper.md`：`npm test` 15/15、隔离 HOME 下 CLI dry-run 通过且未写文件；Windows 原生、真实 OAuth、远程链路未验证。
- 相对父提交的变更仅涉及上述 CLI 参数、Hook 计划/安装函数和一条测试；未发现本提交直接修改 Orca/Bark 路径或数据库。

## 第二轮复审（目标提交 `6644a44`）

### 原问题复核

- Issue 1（冲突覆盖）：**fixed（但修复不充分，见新 Issue 4）**。对任意无法解析为严格结构的目标会拒绝覆盖，真实冲突安装也不会创建备份或改写目标；隔离测试验证了目标及 Orca/Bark 文件字节和权限不变。
- Issue 2（帮助）：**fixed**。顶层帮助已公开 `hooks install [--dry-run]`、只读计划语义和成功退出码。
- Issue 3（测试覆盖）：**fixed（覆盖已显著补齐，但未覆盖识别边界，见新 Issue 4）**。新增进程级测试确实验证了缺失目标、已有 Helper 配置、冲突目标、dry-run JSON/退出码、未知参数、帮助、备份目录以及 Orca/Bark 快照。

### 新 Issues

### Issue 4
- Severity: bug
- File: `/data/CrewRouter/CrewRouterHelper/src/hooks.js:9`
- Description: `isHelperConfig()` 的“Helper 配置”识别仍不可靠：它只要求命令字符串以 `hook --harness grok` 结尾，并且 `commandPath(command)` 能解析出一个路径；没有检查该路径是否为文件、是否可执行，也没有与当前 Helper CLI（或至少已知 Helper CLI 入口）进行比对。因此，任何拥有完整 13 事件结构、但命令形如 `'/tmp/任意脚本' hook --harness grok` 的用户/恶意配置都会被标记为 `helper: true`、`conflict: false`，随后 `hooks install` 会备份并覆盖它。这绕过了本轮要防止覆盖“其他 Hook”的核心保护；而 `backup.js` 的恢复校验反而会检查命令路径可执行，形成识别与恢复标准不一致。
- Suggestion: 让识别复用与恢复相同的完整校验（至少确认解析出的入口是普通文件且在当前平台可执行），并核对入口确实是 Helper CLI；可将当前 `installCommand(command)` 作为期望命令传入，对现有配置按规范化后的命令/入口进行比对，或采用受控 Helper 安装标识。补充完整结构 + 任意命令、不可执行命令、目录/符号链接命令的负例，断言 dry-run 报冲突且真实安装保持目标、权限和备份目录不变。
- Status: open

### 复审结论

本轮独立执行 `cd CrewRouterHelper && npm test`：16/16 通过。原 Issue 2 已充分修复；Issue 1 的一般非 Helper JSON 冲突路径和 Issue 3 的主要 CLI/文件快照覆盖已修复。但由于 Issue 4，不能确认“所有原问题 fixed”，本提交仍有一个可绕过冲突保护的开放 bug。未修改代码；Windows 原生、真实 OAuth、远程链路仍未在本环境验证。
