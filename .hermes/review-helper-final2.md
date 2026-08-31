# Helper 最终审查（目标提交 `90690d0`）

## 审查范围

核对 Issue 1-6 的修复、符号链接入口策略、完整命令匹配、dry-run/冲突退出码，以及普通入口的首次和重复安装行为。

## 验证结果

- `cd CrewRouterHelper && npm test`：16/16 通过。
- `/data/CrewRouter/.hermes/review-helper-final.md`：未发现 `Status: open`。
- 符号链接入口：`installCommand()` 在 `lstat` 阶段拒绝符号链接；通过 `install()` 调用时，拒绝发生在创建目标目录、备份目录、备份文件或临时文件之前。独立验证确认已有安装文件目录内容保持不变。
- 普通入口：可成功首次安装；重复 `installPlan()` 识别为 Helper 配置，重复安装成功，生成内容一致，并按既有设计创建备份。
- 合法带空格路径：现有测试继续通过；命令生成保留正确引用格式。
- 完整命令匹配：同一入口前置或后置额外参数均被识别为冲突；不可执行文件、目录、符号链接和任意脚本入口均不会被误认为 Helper 配置。
- `hooks install --dry-run`：目标不存在时返回 0 且不创建目录；冲突时返回 0、输出 `will_write: false`，真实安装返回非零且不修改目标。

## Issue 复核

- Issue 1：fixed。非受控 Hook 配置不会被覆盖，冲突路径保留目标及备份目录不变。
- Issue 2：fixed。帮助公开 `hooks install [--dry-run]` 及只读语义。
- Issue 3：fixed。已有进程级 CLI、文件快照和冲突边界测试。
- Issue 4：fixed。入口身份包含结构、文件类型、符号链接、可执行权限和 realpath 校验。
- Issue 5：fixed。完整命令参数严格限定为入口加 `hook --harness grok`，额外参数被拒绝，合法路径格式不受影响。
- Issue 6：fixed。安装入口现在在任何写入前拒绝符号链接，普通入口重复安装保持可用。

## 最终结论

无开放问题。未修改源代码；仅写入本审查文件。Windows 原生环境未提供，因此未执行 Windows 实机测试；代码中的 Windows 分支仍已通过平台条件和命令引用逻辑进行静态核对。
