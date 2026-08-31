
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
