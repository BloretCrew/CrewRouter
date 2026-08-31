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
