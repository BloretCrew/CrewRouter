# CrewRouterHelper 最终独立复审

- 复审目标：提交 `a2bf688734964fcf1362e94548ad66ddca8fc3b4` 相对 `main`
- 复审方式：只读检查目标提交；未修改源代码

## 结论

**Issues 非空。** 上一轮提出的 5 个问题在目标提交中均已针对性接入修复，但本轮发现新的 CLI 聚合导出回归，以及录制去重逻辑未覆盖真实 `record` 产物。因此不能判定该提交无问题。

## 上一轮 5 个问题复核

1. **Repair CLI 分派：已修复。** `main()` 现在将 `repair` 与 `doctor --fix` 分派到 `fixDoctor()`；默认和 `--dry-run` 只读，只有 `--yes` 且没有 `--dry-run` 才执行修复。隔离临时 HOME 实测 `repair`、`doctor --fix` 不创建 Hook，`repair --yes` 才创建 Hook。
2. **Bearer/session 鉴权及用户隔离：已修复（静态/契约层确认）。** `clientEventsAuth` 支持 session 和 Bearer；Bearer 继续进入 OAuth/API-key 双路径；`recent-events` 与 `live` 均按 `req.apiUser.userId` 查询。服务端契约测试通过。真实 OAuth、跨用户数据库 E2E 未在本环境执行。
3. **repair/doctor 默认安全语义：已修复。** 默认不写入，修复路径要求显式 `--yes`，写入前备份；新增测试通过。
4. **record/replay 过滤坏数据、重复和过期记录：部分修复，仍有新问题见 Issue 2。** `read()` 会过滤坏 schema、解析错误、过期和完全相同的 JSON 行，并返回诊断；remote replay 只发送 `rows`。但 `record()` 为每一行重新写入不同的 `recorded_at`，使重复输入不再是完全相同 JSON，真实录制文件中的重复事件可绕过去重。
5. **响应脱敏和大小限制：已修复（静态/测试确认）。** `requestJson()` 默认限制 256 KiB，超限只返回通用错误；remote 命令只输出白名单字段，不输出远端响应正文或凭证。超大响应测试通过。

## Issues

### Issue 1 — CLI 声明的 `queue inspect` 实际调用错误 API

- **Severity:** high / bug
- **File:** `/data/CrewRouter/CrewRouterHelper/bin/cr-report.js:38`、`/data/CrewRouter/CrewRouterHelper/src/index.js:2`
- **Description:** `src/index.js` 使用对象展开聚合模块导出。`queue.js` 先导出 `inspect`，随后 `clients.js` 又导出同名 `inspect`，后者覆盖前者。CLI 的 `queue inspect` 调用 `api.inspect()`，实际执行的是 `clients.inspect(undefined)`，因此在目标提交的隔离工作树中真实运行：
  
  ```text
  [cr-report] 未知客户端: undefined
  ```
  
  命令退出码为 1，无法提供帮助文本声明的队列详情。这同时破坏了任务要求的 queue smoke test 和已有队列运维功能。相同的聚合导出设计也造成 `profile list` 使用 `api.list()` 时被 `recordings.list()` 覆盖，无法列出 profile；`profile list` 在带 profile 的隔离配置下仍输出 `[]`。
- **Evidence:** `clients.js` 导出 `inspect`/`list`，`queue.js` 导出 `inspect`，`recordings.js` 导出 `list`；`index.js` 最后展开 clients、recordings。目标提交实测 `queue inspect --json` 失败，`profile list` 返回空数组。
- **Impact:** CLI 参数和帮助看似一致但核心声明命令不可用；队列检查、profile 管理均发生功能回归。
- **Recommendation:** 避免通过无命名空间对象展开聚合同名导出；为 CLI 使用显式模块引用或重命名导出（例如 `queueInspect`、`listProfiles`、`listRecordings`），并增加 `queue inspect --json`、`profile list` 的进程级回归测试。
- **Status:** fixed
- **Response:** 已将队列、profile、客户端和录制列表/检查导出改为显式命名；CLI 的 `queue inspect` 使用 `queueInspect()`，`profile list` 使用 `profileList()`，录制列表使用 `recordingsList()`，并保留原有兼容导出。新增进程级 smoke 与单元测试。

### Issue 2 — `record()` 生成的重复事件绕过去重

- **Severity:** medium / bug
- **File:** `/data/CrewRouter/CrewRouterHelper/src/recordings.js:3-5`
- **Description:** `record()` 对每个输入事件调用 `safe()`，总是写入当前时间的 `recorded_at`。`read()` 的去重键却是 `JSON.stringify(x)` 的完整行。于是同一个 parsed event 输入两次时，两个输出行的 `recorded_at` 通常不同，完整 JSON 不同，`seen` 无法识别为重复；`events replay --remote` 会把两条都发送。当前新增测试只手工写入了没有 `recorded_at` 的相同对象，因此没有覆盖实际 `record()` 输出路径。
- **Impact:** 用户按任务书使用 `events record` 后再 replay，重复事件仍可能重复上报，与“回放排除重复记录”的安全语义不符；也会造成服务端看板重复计数/通知频控压力。
- **Recommendation:** 使用稳定业务字段构造去重键（至少 `harness,event,session_id,tool_name,ts,detail`，不要包含 `recorded_at`），或在 `record()` 阶段去重；新增“同一输入经 `record()` 写盘后 `read()` 只有一行”的测试。
- **Status:** fixed
- **Response:** 新增稳定业务字段去重键，仅使用 harness、event、session_id、tool_name、ts、detail，不包含动态 `recorded_at`。新增测试验证相同输入经 `record()` 写盘后 `read()` 只保留一条，合法不同事件仍保留。

## 重点审查结果

- **CLI 参数/帮助一致性：有问题。** 帮助列出了 `queue inspect`、profile 等功能，但 `queue inspect` 实测失败，profile list 受同名导出覆盖而返回错误结果。`remote capabilities` 在当前服务端返回 404 时能安全输出状态且退出 0，但真实远端兼容性未确认。
- **repair/doctor 默认安全语义：通过。** 默认路径及显式 dry-run 未写入；显式确认才修复。
- **Bearer/session 鉴权和用户隔离：静态/契约通过。** session 只读端点填充当前用户，Bearer OAuth/API key 走统一中间件，SQL 使用参数化 user_id 过滤；真实数据库跨用户验证未执行。
- **响应脱敏/大小限制：通过现有测试和代码检查。** 远程白名单字段有长度/数量限制，`requestJson` 有响应字节上限，错误不携带正文。
- **record/replay：坏数据和过期数据过滤通过；真实 record 产物的重复过滤失败，见 Issue 2。** 文件名限制、600 权限/700 目录和 5 MiB 上限已实现。
- **服务端兼容：静态服务端契约通过。** `node server/scripts/test-client-events.js` 通过 12 项；新增端点没有数据库迁移。真实 OAuth、远程有效凭证和生产数据库未验证。
- **已有功能回归：发现 Issue 1。** `queue inspect` 和 `profile list` 是可复现回归；其余现有 Node 测试通过。

## 验证结果

| 检查 | 结果 |
|---|---|
| `cd CrewRouterHelper && npm test` | 通过，19/19 |
| `npm pack --dry-run` | 通过，27 个包文件；未见凭证/缓存/日志进入 tarball 清单 |
| 任务书 Helper smoke tests | 大部分通过：`--help`、`doctor --json`、`repair --dry-run`、`setup --dry-run`、`hooks test`、`events list`、`config show`、`clients list`、`filter show`、`compatibility`、`version`、`metrics` 均可运行；`queue inspect --json` 失败（Issue 1） |
| `node server/scripts/test-client-events.js` | 通过，12 项 |
| `node server/scripts/test-request-source.js` | 通过 |
| `node server/scripts/test-usage-accuracy.js` | 通过，18 项 |
| `node server/scripts/test-task5a-static.js` | 通过 |
| 全部相关 `node --check` | 通过：`CrewRouterHelper/src/*.js`、`bin/*.js`、`test/*.js`、`server/routes/client-events.js` |
| `git diff --check` | 通过 |

## 未验证项目

- 未在真实 Windows/cmd/PowerShell 环境验证路径和命令解析。
- 未执行真人浏览器 OAuth PKCE 流程、有效远程 OAuth/API key 事件 E2E、跨用户真实数据库隔离测试。
- 未执行交互式真人 TTY 操作；非 TTY TUI 测试已在 npm 测试中通过。
- 本轮未修改数据库、未修改源代码、未 push/publish。

## 本轮实现总结

已修复两个开放 bug：消除 `src/index.js` 同名导出覆盖并更新 CLI 显式调用；录制事件改用稳定业务字段去重。新增回归测试，未修改无关文件、数据库、watch 或远程发布配置。`npm test` 20/20 通过，queue inspect/profile list smoke 通过，Helper 与服务端相关 JavaScript 语法检查通过，client-events、request-source、task5a 静态脚本通过；usage-accuracy 脚本在当前环境因缺少 `pg` 模块无法运行。
