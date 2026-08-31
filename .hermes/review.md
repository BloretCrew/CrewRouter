# CrewRouterHelper 审查结果

审查基线：`origin/main..HEAD`（`ed7ca44`）
审查范围：CrewRouterHelper CLI、凭证/profile、Hook、日志、TUI、兼容性与测试。

## Issues

### Issue 1
- severity: bug
- 文件:行号: `CrewRouterHelper/src/status.js:2`、`CrewRouterHelper/src/doctor.js:9`
- 描述: `status` 和 `doctor` 对服务端探测直接使用 `cfg.access_token || cfg.key`，没有调用 `getAccessToken()`。已过期但带有 `refresh_token` 的 OAuth profile 会被判定为服务端不可达/HTTP 401，而不会刷新 token；这使诊断结果错误，也可能导致用户误以为 Hook 或服务配置损坏。
- 建议: 服务端探测统一通过当前 profile 的 token 获取流程（含刷新和锁），或明确把“凭证可刷新”和“当前探测未认证”分开显示；补充过期 OAuth 的诊断测试。
- Status: open

### Issue 2
- severity: bug
- 文件:行号: `CrewRouterHelper/src/profiles.js:7-8`、`CrewRouterHelper/bin/cr-report.js:20`
- 描述: profile 数据已经引入，但 `login` 始终把新 OAuth 凭证写到顶层配置，未写入 `current_profile` 对应的 profile。已有多个 profile 时，登录会覆盖顶层 active 凭证而保留旧 profile 凭证，造成当前 profile 与登录目标 URL/凭证不一致；后续 `profile use` 又可能把旧凭证恢复到顶层。
- 建议: 登录前解析/选择目标 profile，并把 URL、token、过期时间等完整写入该 profile，再用统一的 profile 切换保存逻辑同步 active 字段；增加“已有多个 profile 后 login”的隔离回归测试。
- Status: open

### Issue 3
- severity: bug
- 文件:行号: `CrewRouterHelper/bin/cr-report.js:15-16`
- 描述: 新解析器允许重复选项和任意多余位置参数，且未校验必需参数。比如 `emit --harness grok` 会进入 `api.report` 并返回成功退出路径，`profile use` 缺少名称会在后续产生不清晰错误；`--json` 等选项在不支持的命令上虽部分受限，但 `status --since/--remote` 被接受后完全忽略。相比基线解析器的重复选项/必需参数校验，这是 CLI 回归，容易导致错误命令静默执行。
- 建议: 保留重复选项检测；为每个子命令声明必需参数和位置参数数量；拒绝未知/多余位置参数；删除未实现的选项或实现其语义，并为错误输入断言非零退出码。
- Status: open

### Issue 4
- severity: bug
- 文件:行号: `CrewRouterHelper/src/backup.js:8`
- 描述: `hooks restore` 只检查 JSON 是对象且存在 `hooks` 字段，不复用 `scanHooks` 的事件、hook 类型、timeout、命令路径等校验。用户可通过 `restore /任意路径` 恢复任意带 `hooks` 字段的恶意配置，之后原生 Hook 会执行其中的任意 command；恢复过程还没有确认目标文件属于受控 backups 目录（命令行虽要求 `--yes`，但这不是内容安全边界）。
- 建议: 默认仅允许受控 backups 目录内、符合命名规则的备份；恢复前严格校验完整 Hook schema 和命令路径，拒绝不一致/不可执行命令；对受控目录使用 realpath 校验，防止符号链接绕过。
- Status: open

### Issue 5
- severity: bug
- 文件:行号: `CrewRouterHelper/src/hooks.js:5`、`CrewRouterHelper/src/hooks.js:7`
- 描述: Windows 分支把 JS CLI 路径直接生成为 `"...\\cr-report.js" hook ...`。Windows 原生通常不能把 `.js` 文件作为可执行命令直接启动（依赖文件关联或 shell 行为），而 Hook 执行器未必经过可用的 `cmd` 文件关联；因此 `hooks install` 在 Windows 上可能安装成功但事件全部执行失败。与此同时 `watchState` 仍固定使用 `~/.cache/cr-report-grok-state.json`，与 README 声称的 `%LOCALAPPDATA%` 路径不一致。
- 建议: Windows Hook 命令显式使用 `process.execPath` 加 CLI 脚本路径并正确转义参数；缓存状态路径统一走平台缓存目录函数；增加 Windows 路径/命令生成测试（至少静态测试）。
- Status: open

### Issue 6
- severity: bug
- 文件:行号: `CrewRouterHelper/bin/cr-report.js:25`
- 描述: `logs --follow` 只在启动时对日志文件调用 `fs.watch`。日志不存在时监听立即失败且被静默吞掉，后续第一次上报创建日志文件也不会被监听，因此该功能在“尚无日志”的正常初始状态下不会跟随任何事件；日志轮转后也不会重新绑定新文件。
- 建议: 监听日志目录并过滤目标文件，或在文件创建/轮转时重建 watcher；非 TTY 下明确拒绝/降级 `--follow` 并返回可诊断提示；补充空日志文件和轮转测试。
- Status: open

### Issue 7
- severity: suggestion
- 文件:行号: `CrewRouterHelper/src/tui.js:4`
- 描述: TUI 为每次按键注册异步 `keypress` 回调，但退出时没有移除监听器；刷新、测试或安装操作也没有防并发锁，快速按键会并发执行多个扫描/写入操作。异常发生在 handler 或 `render` 内时，`runTui` 的 finally 只能恢复 raw mode，不能保证用户得到可控的错误处理。
- 建议: 保存并移除 keypress listener，增加 busy 状态/队列，使用 `try/finally` 处理每个动作并在 TTY 恢复失败时兜底；覆盖 Ctrl-C、handler 抛错、快速连按和 Windows TTY 场景。
- Status: open

### Issue 8
- severity: suggestion
- 文件:行号: `CrewRouterHelper/bin/cr-report.js:21`、`CrewRouterHelper/src/config.js:3`
- 描述: 顶层 `logout` 直接删除整个配置文件，会同时删除所有 profile 的凭证，而不是只注销当前 profile；在多 profile 场景下这是破坏性且缺少确认的行为，也使“凭证隔离”难以符合用户预期。该行为还删除了 profile 元数据和服务地址。
- 建议: 将 logout 设计为清除当前 profile 的凭证并保留其他 profile；若确需删除整个配置，改名为 purge 并要求 `--yes`，同时在帮助和测试中明确。
- Status: open

### Issue 9
- severity: suggestion
- 文件:行号: `CrewRouterHelper/src/logs.js:5`、`CrewRouterHelper/src/reporter.js:5`
- 描述: 日志脱敏只覆盖有限的 `key/token/secret/password` 赋值格式以及 URL。网络库错误文本和未来新增字段可能包含查询参数、Authorization 值或其他敏感信息；当前 `writeLog` 只清理 `entry.error`，且日志轮转文件没有显式再次设置权限。现有测试仅验证两种字符串，不能证明 CLI 日志和轮转备份不泄露。
- 建议: 日志采用白名单字段而非记录原始错误文本；对 header、URL 查询/片段、常见 JWT/API-key 形态做统一脱敏；轮转文件创建后强制 0600，并增加写入、轮转、CLI 输出和错误路径测试。
- Status: open

### Issue 10
- severity: suggestion
- 文件:行号: `CrewRouterHelper/test/helper.test.js:1-38`、`CrewRouterHelper/package.json:8`
- 描述: 测试仅覆盖 7 个纯函数/扫描场景，没有覆盖本次新增的 CLI 子命令解析、profile 迁移/切换/删除、OAuth 刷新隔离、备份恢复安全校验、日志 follow/clear、TUI raw mode/非TTY、Windows 分支或旧命令回归。并且从仓库根目录执行 `npm test` 失败（根 package 没有该 script），只有手动进入 CrewRouterHelper 才能运行测试，交付检查容易误判。
- 建议: 为 CLI 建立隔离临时 HOME/配置的端到端测试，覆盖成功和错误退出码；补齐上述平台/安全场景；在根级测试入口或文档中明确可执行的测试命令，并让 CI 实际执行 Helper 测试。
- Status: open

## 验证记录

- `node --test CrewRouterHelper/test/*.test.js`：7 项通过。
- `npm test`（仓库根目录）：失败，提示 `Missing script: "test"`。
