
## 最终复审（目标提交 `d4ace2b`）

### 原问题复核

- Issue 1（冲突覆盖）：**fixed（但仍受新 Issue 5 影响）**。目标不存在或无法通过识别时不会写入；普通冲突文件的 dry-run/真实安装边界已有保护，且测试检查了目标、备份目录和 Orca/Bark 文件快照。
- Issue 2（帮助）：**fixed**。帮助已公开 `hooks install [--dry-run]`，并说明只读计划及成功退出码。
- Issue 3（测试覆盖）：**fixed（但关键识别边界仍有遗漏，见新 Issue 5）**。新增进程级测试覆盖了未知选项、冲突退出码、已有 Helper 配置和 Linux 下不可执行文件、目录、符号链接等情况。
- Issue 4（入口身份校验）：**修复不充分，见新 Issue 5**。本提交增加了普通文件、非符号链接、Linux 可执行权限及 realpath 检查，但没有把完整命令行与当前 `installCommand()` 生成的命令严格相等比较。

### 新 Issues

### Issue 5
- Severity: bug
- File: `/data/CrewRouter/CrewRouterHelper/src/hooks.js:9`
- Description: `isControlledCommand()` 只比较 `commandPath()` 解析出的入口 realpath，并分别检查命令以 `hook --harness grok` 结尾；它没有校验入口前后的完整参数串。因此，同一真实入口的伪造命令仍会被标记为 Helper 配置。例如，在当前 Linux 工作树中构造完整 13 事件配置，把命令改为 `'<当前 cr-report.js>' --unexpected-arg hook --harness grok`，`installPlan()` 返回 `helper: true, conflict: false, will_write: true`，尽管该配置并非 `installCommand()` 生成的受控命令，安装会备份并覆盖它。该问题同样适用于 Windows 语义：realpath/lstat 只能确认入口文件身份，不能确认 `.exe`/脚本入口后的参数没有被篡改；当前测试也只覆盖了不同入口路径，未覆盖同入口加额外参数。
- Suggestion: 对现有每个 Hook 的命令与 `expectedCommand` 做完整、平台正确的规范化后精确比较，或至少严格解析并拒绝除预期入口和 `hook --harness grok` 外的任何参数；不要仅依赖首 token realpath 和后缀匹配。增加 Linux/Windows 语义的同入口额外参数负例，并断言 dry-run 报冲突、真实安装不创建备份且目标字节/权限不变。
- Status: open

### 复审结论

已运行 `cd CrewRouterHelper && npm test`：16/16 通过；所有现有测试并未发现其它回归。但独立边界复测确认 `isControlledCommand()` 可被“同一 CLI 入口 + 额外参数”绕过，因此不能确认 Issue 1-4 均已修复，当前仍有 Issue 5 开放。未修改源代码；本轮审查文件已追加更新。Windows 原生、真实 OAuth 和远程链路仍未在本环境验证。
