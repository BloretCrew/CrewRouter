# Helper 最终复审（目标提交 `ad01bd3`）

## 原问题复核

- Issue 1（冲突覆盖）：**fixed**。无法识别为受控 Helper 配置的目标会被视为冲突，dry-run 不写入，真实安装返回非零且不创建备份、不修改目标。
- Issue 2（帮助）：**fixed**。帮助已列出 `hooks install [--dry-run]`，并说明 dry-run 只读检查和成功退出码。
- Issue 3（测试覆盖）：**fixed（存在新边界遗漏，见 Issue 6）**。已覆盖 CLI 进程、dry-run JSON/退出码、冲突文件、备份目录和 Orca/Bark 文件快照。
- Issue 4（入口身份校验）：**fixed（存在新回归，见 Issue 6）**。同一入口追加前后参数、不可执行文件、目录和符号链接等冲突负例已加入测试；完整命令参数匹配已实现。
- Issue 5（完整命令严格匹配）：**fixed（存在新回归，见 Issue 6）**。额外参数和参数变体会被拒绝；合法的普通绝对路径、带空格路径可继续使用。

## Issues

### Issue 6
- Severity: bug
- File: `/data/CrewRouter/CrewRouterHelper/src/hooks.js:8-9`
- Description: 入口身份校验禁止符号链接，但 `installCommand()` 对符号链接入口没有拒绝，导致合法安装路径产生不可重复识别的配置：使用指向真实 `bin/cr-report.js` 的符号链接路径首次 `install()` 成功；随后对同一入口调用 `installPlan()` 返回 `helper: false, conflict: true`，再次安装会拒绝覆盖自己的 Helper 配置。该回归破坏幂等安装，并且校验标准与入口生成标准不一致。Linux 已实测复现。Windows 原生环境未具备，无法独立运行 Windows 分支，但同样的生成/识别不一致需要在 Windows 语义下统一处理。
- Suggestion: 二选一并保持一致：在 `installCommand()`/安装入口处先用 `lstat` 拒绝符号链接并返回明确错误；或允许符号链接入口，并在身份校验时比较其 realpath，同时不要以“非符号链接”作为受控配置条件。无论选择哪种策略，都应增加“合法带空格/引号路径可重复识别”和“符号链接策略一致”的回归测试，并在 Windows 上验证引号、反斜杠和 `.exe`/脚本入口组合。
- Status: open

## 最终结论

已运行 `cd CrewRouterHelper && npm test`：16/16 通过，未发现测试套件中的其它失败。已独立验证 Issue 5 的额外参数：同一入口前置或后置额外参数均被识别为冲突并拒绝覆盖；普通绝对路径及带空格路径的命令格式保持可用。但独立复测发现符号链接入口首次安装成功、重复安装却被误判为冲突，存在 Issue 6，因此当前不是“无开放问题”。源代码未修改。
