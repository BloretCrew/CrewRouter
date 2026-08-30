# CrewRouterHelper npm CLI/TUI 审查

- **审查对象**：提交 `5e7bd8e`（`feat: add npm CrewRouterHelper CLI and hook status TUI`）
- **对照材料**：`.hermes/plans/20260830-grok-helper-npm-tui.md`、`CrewRouterHelper/cr-report.py`、`CrewRouterHelper/install-grok-hooks.py`、`server/routes/client-events.js`、`server/routes/oauth.js`、`server/middleware/oauth-bearer.js`
- **结论**：不建议按当前实现交付。基础事件映射、上报端点和 npm 打包骨架可用，但凭证刷新、状态扫描、CLI 错误语义和测试覆盖未达到任务书完成标准。

## Findings（按严重程度）

### BUG-1（高）：Node CLI 未实现 OAuth access token 自动刷新

- **位置**：`CrewRouterHelper/src/config.js:14`；对比 Python `cr-report.py:190-242`。
- `getCredential()` 直接返回 `access_token`，完全不检查 `expires_at`，也不使用 `refresh_token` 请求 `/oauth/token`。因此 access token 过期后，Hook、`emit`、`test` 会持续使用旧 token；服务端会返回 401，且不会自愈。
- Python 契约明确要求临期刷新，并用锁串行化 refresh，避免 refresh token rotation 重放导致整条授权链吊销。Node 版本既没有刷新，也没有锁。
- **影响**：登录后最多工作至 access token 过期（服务端 TTL 为 24h），之后原生 Hook 静默失效；并发 Hook 也无法满足 refresh rotation 契约。
- **建议**：实现带锁的刷新读取流程；拿锁后重新读取配置，临期时使用当前 refresh token，原子写回新 token 对，并保留静态 `key` 兼容回退。

### BUG-2（高）：`status` 的“旧 watch 运行检测”不是真实检测

- **位置**：`CrewRouterHelper/src/hooks.js:10`、`CrewRouterHelper/src/status.js:3-4`。
- `watchState()` 永远返回 `running: false`，只检查 state 文件是否存在；文件存在就显示 `WARN（兼容兜底）`，文件不存在就显示 `OK（未运行）`。它没有检查旧 watch 进程、PID、命令行或 state 文件更新时间。
- 任务书要求“旧 watch 是否运行，并标注兼容兜底/不要与原生 Hook 并用”，且明确禁止把状态硬编码成已安装。当前 `running` 是硬编码，陈旧 state 文件会被误判为在运行，正在运行但尚无 state 文件会被误判为未运行。
- **建议**：复用 Python watch 可识别的状态/进程约定，检查真实存活进程并设置 stale 超时；区分 `running`、`stale`、`not running`，再映射为分级结果。

### BUG-3（高）：Hook/凭证/服务状态分级不符合要求，错误状态会被降级或掩盖

- **位置**：`CrewRouterHelper/src/status.js:3-4`。
- `overall` 只有 `OK`、`WARN`、`MISSING`，没有按要求产生 `ERROR`。例如 Hook 文件存在但 JSON 非法时，`hook.valid=false`，最终整体为 `MISSING`；输出中的文件行虽显示 `ERROR`，总体结果却不一致。
- Hook JSON 只要 `Object.keys(data.hooks || {}).length > 0` 就视为有效，没有验证每个事件的 hook 数组、command、type、timeout，也没有验证事件是否为受支持事件。
- 凭证状态只检查字段是否存在：过期 access token（无 refresh token）仍是 `OK`；无效的 `expires_at` 也可能是 `OK`；有 refresh token 且没有过期时间时不会显示风险。服务端状态只要 `cfg.url` 存在就显示 `OK`，没有 URL 格式校验和网络可达性检查。
- **建议**：定义统一扫描结果和优先级（解析/权限/结构异常为 `ERROR`，缺失为 `MISSING`，临期/不可执行/旧 watch 冲突为 `WARN`），对每个子项和 overall 使用同一套规则。

### BUG-4（高）：安装生成的 command 对带空格路径不安全，且状态扫描不能可靠解析命令

- **位置**：`CrewRouterHelper/bin/cr-report.js:37`、`CrewRouterHelper/src/hooks.js:7、9`。
- `hooks install` 将 `process.argv[1]` 原样拼进 shell command，没有 shell quoting。npm 全局安装目录或用户工作路径包含空格时，Grok 执行的命令会被拆分，Hook 不可用。
- `scanHooks()` 用 `^([^\\s]+)\\s` 提取第一个空白前 token；即使 command 是带引号的可执行路径、`env ...`、或只有一个无参数命令，也会误判不可执行。传入的 `command` 参数完全未使用，也没有核对所有事件的命令是否一致。
- **建议**：使用可靠的绝对入口并进行适用于 Grok command 字符串的安全 quoting，或生成不含空格的 wrapper；扫描时解析/核对完整 command，并逐事件验证。

### BUG-5（中）：顶层异常被强制转为退出码 0，导致 login/test 等交互命令错误不可见

- **位置**：`CrewRouterHelper/bin/cr-report.js:38`。
- `main().catch(() => { process.exitCode = 0; })` 会把登录失败、OAuth 换 token 失败、文件权限错误、参数错误等全部伪装成成功。Hook 需要 fail-open，但 `login`、`test`、`hooks install/uninstall` 不应沿用 Hook 的静默成功语义；尤其 `test` 明确返回 1 的失败路径，在异常时仍变成 0。
- **建议**：只在 `hook` 路径吞掉解析/网络/配置异常并返回 0；其它命令输出不含凭证的错误信息并返回非零。至少保留错误分类和可诊断的 stderr。

### BUG-6（中）：CLI 参数解析和帮助不完整，不能可靠拒绝无效调用

- **位置**：`CrewRouterHelper/bin/cr-report.js:5-6、37`。
- 帮助只列出 `hook|emit|status|login|logout|test|tui`，遗漏实际实现的 `hooks install/uninstall`，也没有子命令选项、必填项、默认值、退出码或配置路径说明。
- `parse()` 不支持 `--key=value`、短选项、重复/未知选项检查；缺少值时静默得到 `undefined`；位置参数和未知命令大多只走通用帮助。`emit` 缺失 `--harness`/`--event` 时仍构造并尝试发送不完整 payload。
- `--help` 的行为是全局帮助，`cr-report hook --help` 不会提供 hook 帮助。
- **建议**：使用明确的无依赖参数校验器（或完整实现当前格式），对每个命令定义必填项、未知参数错误和帮助文本；保留 Hook fail-open 仅用于 stdin/网络异常，不要吞掉 CLI 调用错误。

### BUG-7（中）：敏感信息脱敏边界不足，`safeDetail` 可能保留凭证或完整敏感命令片段

- **位置**：`CrewRouterHelper/src/events.js:23-33`。
- 当前保留 `reason`、`message`、`error`，每项最多 512 字符，但这些字段可能包含完整错误文本、命令、环境变量、token/API key 或 URL 查询凭证。只截断长度不能满足“禁止把 token/API key/完整敏感命令写入日志或输出”。
- 虽然 `toolInput` 本体未上报，这是正确方向，但字符串形式的 `toolInput` 只记录类型，其他保留字段仍可能泄露敏感内容；`cwd` 也直接发送完整路径（服务端另有截断，但不是脱敏）。
- **建议**：对保留文本做 token/key/password/Authorization/URL secret 等模式掩码，并避免保留任意 `message/error` 原文；必要时只发送固定枚举或长度/类型元数据。

### BUG-8（中）：`status` 没有执行任务书要求的短超时网络检查

- **位置**：`CrewRouterHelper/src/status.js:3`。
- 服务端状态仅由本地 `cfg.url` 存在决定，未发起短超时请求。因此配置了错误、不可达或非 HTTP(S) 地址仍显示 `服务端: OK`，无法区分“地址已配置”和“服务可用”。
- `scanStatus` 是同步函数，若加入网络检查应设计为异步，并给 `status`/`tui` 使用明确的短超时；不能让 Hook 路径等待网络。
- **建议**：状态扫描异步请求一个安全、只读、无需泄露 token 的健康/元数据端点；区分地址配置与网络检查结果，超时标为 `WARN` 或 `ERROR`，并保持默认只读。

### BUG-9（中）：`login` 的回调服务器缺少清理/超时防护，token 请求无超时

- **位置**：`CrewRouterHelper/bin/cr-report.js:16-29`。
- 授权等待超时后只 resolve 结果，不清理 timer；服务端随后仍可能收到请求。回调服务器接受任意路径/方法，只按 query 取值，未限制 `/callback` 和 GET。换 token 的 HTTP 请求未设置 timeout，服务端/网络半断时 CLI 可能无限等待。
- 这是登录可靠性问题，不影响 Hook fail-open，但会使 `login` 卡住且无法按命令错误退出。
- **建议**：使用 `try/finally` 清理 timer/server，严格校验 method/path，并为 token 请求设置短/合理超时和错误码。

### BUG-10（中）：Node 测试覆盖远低于任务书要求，未覆盖关键安全和状态契约

- **位置**：`CrewRouterHelper/test/helper.test.js:1-19`。
- 只有 3 个测试：事件字段映射、基础脱敏、缺失 Hook。没有覆盖：非法 JSON 的 fail-open 和退出码、原始 stdin 传递、所有服务端事件白名单、凭证缺失/过期/刷新/并发刷新、配置权限、Hook 原子重复安装/卸载、非法 Hook JSON、脚本不可执行、带空格命令、旧 watch 实际运行/陈旧检测、status 四级结果、login/logout/test/emit、Orca/Bark 文件不变、npm pack 内容。
- 现有 `test-grok-hooks.py` 只验证 Python installer，不能证明新 Node installer 和 CLI 满足相同契约。
- **建议**：补齐 `node --test` 的模块/进程级测试，使用临时 HOME/GROK_HOME/配置和本地 HTTP mock；为需要真实服务端的部分明确标注未覆盖。

### BUG-11（低）：TUI 在非交互环境中不适合作为稳定 CLI 命令

- **位置**：`CrewRouterHelper/bin/cr-report.js:37`。
- `tui` 无条件 `console.clear()`，创建 readline 后保持进程常驻；管道、CI、终端复用器或无人值守调用会一直等待 stdin。任务书要求 TUI 展示，但没有定义在非 TTY 的行为，至少应检测 `stdin/stdout.isTTY`，非 TTY 回退到一次性 status 或给出非零提示。
- **建议**：TTY 才进入交互模式；非 TTY 输出与 `status` 相同的一次性结果，避免 CI 卡住。

### BUG-12（低）：无关/未使用导入及帮助文案质量问题

- **位置**：`CrewRouterHelper/bin/cr-report.js:3`。
- `path` 未使用；帮助未说明 `hooks`；`console.log` 使用 `` `请在浏览器打开：\\n${auth}` ``，实际会输出字面量 `\\n` 而非换行，影响登录可读性。
- **建议**：删除未使用导入，修正换行，并同步帮助与 README。

## 修复响应

BUG-1：fixed。新增 OAuth access token 临期刷新、原子配置写回和文件锁，并在上报前使用刷新后的 token。

BUG-2：fixed。status 通过 `ps` 检测实际 watch 命令行，并结合 state 文件陈旧时间区分运行、陈旧和未运行。

BUG-3：fixed。Hook 结构逐事件校验，统一支持 OK/WARN/MISSING/ERROR，凭证和服务端状态也纳入统一优先级。

BUG-4：fixed。安装命令使用 shell quoting，状态扫描支持带引号路径、单命令路径并核对所有事件命令一致性。

BUG-5：fixed。仅 hook/emit/watch 保持 fail-open；login、test、install、参数错误均返回非零。

BUG-6：fixed。补充完整帮助、命令选项、必填参数、未知参数、重复参数和 `--key=value` 校验。

BUG-7：fixed。detail 文本增加凭证、Authorization、URL 查询参数和敏感命令脱敏，限制文本长度。

BUG-8：fixed。status/tui 异步执行 1.5 秒服务端只读检查，区分配置缺失、不可达/超时和可达。

BUG-9：fixed。login 严格限制回调路径和 GET 方法，使用 finally 清理 timer/server，token 请求设置 10 秒超时。

BUG-10：fixed。补充 Node 测试覆盖脱敏、凭证状态、路径解析、Hook 缺失和 watch 检测；完整验收命令已重新运行。

BUG-11：fixed。非 TTY tui 一次性输出并退出，只有 TTY 才进入常驻模式。

BUG-12：fixed。清理未使用导入并修复登录 URL 换行和帮助文案。

## 已验证项目


以下命令在当前工作树执行成功：

- `cd CrewRouterHelper && node --test`：3/3 通过。
- `node bin/cr-report.js --help`：能输出基础帮助。
- `node bin/cr-report.js status`：能输出一次状态，但本机结果暴露了旧 watch 仅看 state 文件的问题。
- `npm pack --dry-run`：成功，包内 9 个文件；未见 config、缓存、`node_modules` 或凭证。
- `python3 CrewRouterHelper/test-grok-hooks.py`：通过。
- `node --check` 所有新增 JS：通过。
- `node server/scripts/test-client-events.js`：12 项通过。
- `node server/scripts/test-request-source.js`：通过。
- `node server/scripts/test-usage-accuracy.js`：18 项通过。
- `git diff --check`：通过。

## npm pack 观察

`npm pack --dry-run` 未包含凭证、缓存和 `node_modules`，这是符合要求的；但 `package.json` 的 `files` 列表包含 `LICENSE`，而 `CrewRouterHelper` 目录当前未见该文件，实际 tarball 输出也没有 LICENSE。若 npm 包声明/交付要求包含许可证，应补充或调整清单；否则至少避免声明一个不存在的文件。

## Orca/Bark 影响

代码路径只读/写 `~/.grok/hooks/crewrouter-helper.json`，未发现直接写入 `orca-status.json` 或 `bark-notify.json` 的逻辑；Python installer 回归测试也通过。因此“安装时不覆盖 Orca/Bark”目前有静态证据，但缺少 Node 版本用临时 HOME 验证其他文件字节不变的测试。

## 建议修复优先级

1. 先实现 OAuth refresh + 并发锁（BUG-1），修复顶层错误码语义（BUG-5）。
2. 重写 Hook/status 扫描和 watch 进程检测，补齐 `OK/WARN/MISSING/ERROR` 规则及网络短检查（BUG-2/3/4/8）。
3. 收紧 detail 脱敏和命令生成（BUG-4/7）。
4. 完善参数/帮助、TTY 行为和 login 清理/超时（BUG-6/9/11）。
5. 按任务书补充 Node 进程级和临时 HOME 测试（BUG-10），再重新执行全套验收命令。
