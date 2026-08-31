# CrewRouterHelper 最终复审

审查基线：当前工作树 `HEAD` `5722376515ced5917ff08fa987a958916d4ade11`（`fix: close Helper review findings`）。
审查范围：读取 `.hermes/review.md` 中上一轮 10 个问题，复核当前 HEAD 全部 CrewRouterHelper 修改，并检查整体任务书完成度及回归风险。

## 结论

整体任务书**未完成**。上一轮 10 个问题中，Issue 1、2、5、7、8、9 的主要修复已落地；Issue 3 的 CLI 校验已明显改善；但 Issue 4、6、10 仍未正确解决，并发现 profile test 的 OAuth/隔离回归风险。因此仍有开放问题，不能判定为通过。

## 已确认解决

- **Issue 1：已解决（主要路径）**。`status`/`doctor` 的服务探测经 `probe()` 调用 `getAccessToken()`，过期 OAuth 会走刷新与锁；现有测试验证了过期 profile 刷新后服务探测使用新 token。
- **Issue 2：已解决（登录写入当前 profile）**。`login` 读取 `profilesData()`，把 URL、OAuth token、过期时间和 scope 写入当前 profile，并同步 active 顶层字段。
- **Issue 3：部分解决**。已增加重复选项、未知选项、必需参数、子命令和多余位置参数校验；手工验证 `emit --harness grok`、`profile use`、`status --since 1` 均返回退出码 1。仍缺少系统化 CLI E2E 测试，见 Issue 10。
- **Issue 5：已解决（静态实现检查）**。Windows 安装命令使用 `process.execPath` 加脚本路径，缓存路径统一经平台函数；当前 Linux 测试无法运行 Windows 分支。
- **Issue 7：已解决（主要生命周期路径）**。TUI 保存并移除 keypress listener，动作有 busy 锁和 try/catch/finally，退出时恢复 raw mode；Windows/TTY 场景仍缺测试，见 Issue 10。
- **Issue 8：已解决**。顶层 `logout` 仅清除当前 profile 的凭证并保留 profile 元数据及其他 profile。
- **Issue 9：主要风险已缓解**。日志采用白名单字段，清理 Authorization/Bearer、凭证赋值、URL 查询/片段和 JWT，轮转文件及当前日志均强制 0600；覆盖仍不完整，见 Issue 10。

## Issues

### Issue 1（原 Issue 4）
- severity: **bug / high**
- 文件:行号: `CrewRouterHelper/src/backup.js:7`
- 描述: `restore()` 只校验每个事件的 `entries[event]?.[0]?.hooks?.[0]`，没有校验事件数组和 `hooks` 数组必须恰好只有一个元素，也没有校验数组中其余 Hook。攻击者可在受控、命名合法的备份中保留首个合法命令并追加第二个任意 `command`，恢复后原生 Hook 可能执行追加命令。当前 schema 检查因此仍不是完整 Hook schema 校验。
- 建议: 对根对象、事件集合、每个事件数组、每个 hooks 数组以及元素字段做严格 allow-list/精确长度校验；校验所有 command 均相同、均为预期 CLI 命令且路径属于可执行的受控 CLI；使用 realpath 对目标文件和备份目录做完整边界校验。
- Status: open

### Issue 2（原 Issue 6）
- severity: **bug / medium**
- 文件:行号: `CrewRouterHelper/bin/cr-report.js:25`
- 描述: `logs --follow` 仍只对启动时存在的日志文件调用 `fs.watch(api.logPath())`。日志不存在时 watcher 创建失败且异常被静默吞掉；随后首次上报创建日志、日志轮转或文件替换都不会重新绑定，因此正常的“尚无日志”初始状态无法跟随事件。
- 建议: 监听日志目录并按 basename 过滤目标文件，在创建/rename/轮转时重新绑定；在非 TTY 或不可监听时明确返回可诊断错误/降级提示；补充空日志、首次创建和轮转测试。
- Status: open

### Issue 3（新增）
- severity: **bug / medium**
- 文件:行号: `CrewRouterHelper/bin/cr-report.js:23`
- 描述: `profile test NAME` 直接使用 `p.access_token || p.key` 请求服务，没有调用 `getAccessToken(NAME)`。指定 profile 的过期 OAuth 不会刷新，可能使用过期 token 得到 401；同时与通用 profile token 获取流程不一致，profile test 不能可靠验证该 profile 当前可用性。
- 建议: 使用指定 profile 的统一 token 获取/刷新流程（`getAccessToken(name)`），并基于该 profile 的 URL 发起探测；补充过期 OAuth profile test 及多 profile 隔离测试。
- Status: open

### Issue 4（原 Issue 10）
- severity: **suggestion / medium**
- 文件:行号: `CrewRouterHelper/test/helper.test.js:4-10`、`CrewRouterHelper/package.json:8`
- 描述: 测试文件仍只有 7 项，且本轮通过压缩/替换删除了原有多个独立回归断言。没有覆盖 CLI 解析成功/失败退出码、登录写入 profile、profile test 的 OAuth 刷新、备份多 Hook 注入、日志 follow 创建/轮转、TUI 异常与按键并发、Windows 命令生成等关键场景。根目录执行 `npm test` 仍因根 package 没有该 script 失败；只有 `cd CrewRouterHelper && npm test` 可运行。
- 建议: 增加隔离 HOME/config/log 的 CLI E2E 测试和安全负例，恢复并扩展基础单元测试；至少加入备份多余 Hook、follow 文件创建/轮转、指定 profile 刷新、TUI/Windows 静态覆盖；在 CI 或根级入口实际执行 Helper 测试，避免根目录检查误判。
- Status: open

## 验证记录

- `node --test CrewRouterHelper/test/*.test.js`：7 项通过。
- `cd CrewRouterHelper && npm test`：7 项通过。
- `python3 CrewRouterHelper/test-grok-hooks.py`：通过，`All Grok hook assertions passed.`
- `cd CrewRouterHelper && npm pack --dry-run`：通过，包内容 17 个文件，包含 bin/src/test/README/package.json。
- CLI 负例手工验证：
  - `emit --harness grok`：退出码 1，报告缺少 `--event`。
  - `profile use`：退出码 1，报告缺少 NAME。
  - `status --since 1`：退出码 1，报告不支持该选项。
- `npm test`（仓库根目录）：失败，`Missing script: "test"`；这是当前仓库事实，README 已说明测试应在 `CrewRouterHelper` 目录执行。

## 审查边界

本次未修改任何源代码；仅生成本审查报告。Linux 环境未实际执行 Windows 分支、交互式 TTY 和真实 OAuth 浏览器登录流程，相关结论来自静态审查与现有测试覆盖。
