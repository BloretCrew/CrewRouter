# CrewRouterHelper 最终只读复审（ef30ed3）

## 审查对象

当前工作树最新 HEAD：`ef30ed39a8832b7a90407d9fa0b89041f214086c`（`fix: close final Helper review issues`）。
复审范围：对照 `.hermes/review-final.md` 中的 4 个开放问题，检查 `ef30ed3` 的实现差异、新增测试覆盖、安全/回归风险，并执行验收命令。未修改源代码。

## 结论

**Issues: none**

未发现仍然成立的安全或功能性开放问题。此前 4 个问题均已在实现和测试层闭环：

### Issue 1：备份恢复可追加任意 Hook —— 已解决

- `CrewRouterHelper/src/backup.js` 现在使用 `validateHookConfig()` 严格校验根对象、事件键集合、每个事件数组长度、wrapper 键集合、Hook 数组长度及 Hook 元素键集合。
- 所有事件均要求唯一、完全一致的 `command`，命令必须包含 `hook --harness grok`，并且解析出的可执行文件必须真实存在且可执行。
- `controlled()` 限制备份文件名、目录 realpath 和符号链接；恢复仍通过临时文件原子替换，并保持 0600 权限。
- 新测试向合法备份的单个事件追加第二个 Hook，以及追加第二个事件 wrapper；两种情况均断言 `restore()` 拒绝，真实覆盖了此前漏洞，而非仅检查首元素。

### Issue 2：`logs --follow` 无初始日志时无法跟随创建/轮转 —— 已解决

- `CrewRouterHelper/src/logs.js` 的 `followLogs()` 监听日志父目录并按目标 basename 过滤 `change`/`rename`，因此目标文件不存在、首次创建和替换/轮转后仍可收到事件。
- CLI 在非 TTY 下明确输出提示并退出，不会进入不可控常驻监听；TTY 下注册退出信号清理 watcher。
- 新测试从不存在的日志开始监听，随后创建日志、执行轮转并创建新日志，断言至少收到两次事件，同时检查轮转文件权限为 0600，真实覆盖创建和轮转路径。

### Issue 3：`profile test NAME` 不刷新指定 profile 的 OAuth —— 已解决

- `CrewRouterHelper/bin/cr-report.js` 的 `profile` 测试路径改为调用 `api.getAccessToken(name)`，不再直接使用 `p.access_token || p.key`。
- `getAccessToken(profileName)` 在指定 profile 范围内重新读取配置、使用文件锁合并并发刷新、保存轮换后的 token 对，然后使用该 profile 的 URL 发起探测。
- 新测试配置了 default 与 other 两个不同 URL/profile，使 other 的 access token 过期，由本地 HTTP 服务断言收到 `old-other` refresh token、返回新 token，并断言后续探测使用 `Bearer new-other`。同时验证了 profile URL/凭证隔离。

### Issue 4：测试覆盖不足及根目录 `npm test` —— 已解决/环境事实记录

- `CrewRouterHelper/test/helper.test.js` 已覆盖事件安全归一化、凭证/URL/JWT 脱敏、profile 隔离、指定 profile OAuth 刷新、备份严格 schema、日志创建/轮转跟随、命令路径解析、TUI 非 TTY 生命周期；`CrewRouterHelper/package.json` 的测试脚本实际运行 8 项并全部通过。
- 新增测试不是空断言：OAuth 测试使用本地 HTTP server 验证 refresh 请求和 Authorization；备份测试注入额外 Hook 验证拒绝；日志测试验证文件创建与轮转通知；TUI 测试实际 await 非 TTY 返回。
- 根项目 `npm test` 仍失败，原因是根 `package.json` 没有 `test` script（`npm error Missing script: "test"`）。这不是 `ef30ed3` 引入的回归；Helper 包目录内的规范命令 `cd CrewRouterHelper && npm test` 成功。由于用户要求执行根命令，已将该环境/项目脚本事实如实记录，不将其误报为测试通过。

## 执行记录

| 命令 | 结果 |
|---|---|
| `npm test`（仓库根目录） | 失败：根 `package.json` 未定义 `test` script |
| `(cd CrewRouterHelper && npm test)` | 通过：8/8 |
| `(cd CrewRouterHelper && npm pack --dry-run)` | 通过：`crewrouter-helper@1.0.0`，17 个文件，包含 LICENSE、README、bin、src、test；未见凭证、缓存或 node_modules |
| `npm pack --dry-run`（仓库根目录） | 通过：生成 dry-run 清单；该根包包含大量项目文件，但未执行实际写包 |
| `find server CrewRouterHelper -type f -name '*.js' ... node --check` | 通过：所有服务端及 Helper JavaScript 语法检查通过 |
| `python3 CrewRouterHelper/test-grok-hooks.py` | 通过：`All Grok hook assertions passed.` |
| `python3 -m py_compile CrewRouterHelper/cr-report.py CrewRouterHelper/install-grok-hooks.py` | 通过 |
| `node server/scripts/test-financial-usage-static.js` | 通过：8 个计费调用点、参数数量和失败传播静态断言 |
| `node server/scripts/test-request-source.js` | 通过 |
| `node server/scripts/test-reliability-closure-static.js` | 通过 |
| `node server/scripts/test-request-policy.js` | 通过 |
| `node CrewRouterHelper/bin/cr-report.js --help` | 通过，帮助可输出 |
| `node CrewRouterHelper/bin/cr-report.js test` | 通过，本地 Hook dry-run 6 个事件 |
| `node CrewRouterHelper/bin/cr-report.js profile list` | 通过，未泄露凭证，仅显示 profile 与 URL |
| `node CrewRouterHelper/bin/cr-report.js hooks list` | 通过，正确报告当前 Hook 缺失状态 |
| `node CrewRouterHelper/bin/cr-report.js logs --json` | 通过 |
| `node CrewRouterHelper/bin/cr-report.js status --json` | 通过；本机服务返回 401，正确显示 WARN，未伪装为 OK |
| `node CrewRouterHelper/bin/cr-report.js doctor --json` | 通过；正确报告 Hook 缺失及服务 401 为 WARN/MISSING |
| CLI 负例：`emit --harness grok`、`profile use`、`status --since 1`、`hooks restore` | 均以退出码 1 返回明确错误 |

## 安全与回归检查

- 未发现 `ef30ed3` 修改 Orca/Bark 原生 Hook 路径；变更仍限定在 CrewRouter Helper Hook、其备份、配置、日志和 CLI。
- Hook 安装继续使用 shell quoting；备份恢复增加精确 schema、路径边界、符号链接和可执行文件检查。
- OAuth refresh 继续原子写回并使用锁；静态 Key 兼容回退保留；profile test 不会跨 profile 使用 URL 或 token。
- 日志继续白名单字段、敏感值脱敏及 0600 权限；follow watcher 的新增目录监听没有把日志内容或凭证输出到命令行之外。
- 非 TTY TUI 和 `logs --follow` 均会返回，不会在 CI/管道环境无提示阻塞。
- 真实 PostgreSQL、浏览器 OAuth、Windows 原生分支和交互式 TTY 未在当前环境端到端执行；本轮未发现因这些环境限制而可确认的 open issue。

## 工作树说明

本轮复审未编辑源代码。测试执行产生/更新了 Python `__pycache__` 文件；工作树在复审前已存在多份 `.hermes` 删除状态，均未纳入本报告之外的实现修改。
