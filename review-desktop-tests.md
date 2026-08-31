# CrewRouter Desktop 测试与交付质量审查

- 审查范围：`/data/CrewRouter/CrewRouter-Desktop`
- 审查方式：阅读 package/build、源码、测试、README、实施任务书，并实际运行测试/语法检查/真实 Local integration/build。
- 审查结论：**不建议按“本轮完成定义”交付（需要修复后再交付）**。

## 一、实际执行结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm test` | 通过 | 11 个测试全部通过，0 失败 |
| `npm run syntax` | 通过 | 当前列出的 JS 文件均通过 `node --check` |
| `CREWROUTER_SERVER_ROOT=/data/CrewRouter node scripts/test-local-server.js` | 通过 | 真实启动父项目服务端，动态端口 `37727`，返回 `ready=true`、`version=1.0.0`、`edition=team`，随后停止并清理临时目录 |
| `npm run build` | **失败** | `electron-builder: 未找到命令`；当前 Desktop 没有 `node_modules`，也没有 `package-lock.json` |
| Electron GUI/E2E | 未验证 | 本环境未安装 Desktop 依赖，未启动 Electron GUI |

真实 integration 脚本确实启动了 `/data/CrewRouter/server/index.js`，但它只检查 `/api/version` 和 `/api/instance`；没有按任务书要求访问 `/api/setup/status`，也没有自动创建/验证独立 PostgreSQL 数据库或隔离初始化流程。

## 二、Findings

### F-01 [高] `npm run build` 不能在当前交付树中真实执行

**证据**

- `package.json` 的 `build` 委托给 `npm run pack`，再调用 `electron-builder --linux AppImage`。
- `devDependencies` 虽声明了 `electron` 和 `electron-builder`，但交付目录没有 `node_modules`，也没有 `package-lock.json`。
- 实际运行 `npm run build` 失败：`sh: 行 1: electron-builder: 未找到命令`。

**影响**

任务书要求 `npm run build` 真实执行，且第一版至少完成当前 Linux 打包配置。当前只能证明配置文本存在，不能证明构建可交付，也不能确认依赖版本可复现。

**建议**

提交依赖锁文件，并在干净目录执行 `npm ci` 后再次执行 `npm run build`；若环境限制导致无法打包，应明确标记为阻塞项，而不是将 `build` 视为已验证。

### F-02 [高] Local integration test 没有覆盖任务书规定的完整健康/隔离边界

**证据**

`scripts/test-local-server.js` 仅调用 `manager.start()`，再依据 `status.ready/version/edition` 判断成功。`LocalServerManager.waitUntilReady()` 只请求：

- `/api/version`
- `/api/instance`

缺少：

- `/api/setup/status` 有效 JSON 验证；
- 未初始化 edition 的预期状态，或隔离初始化后 `personal` 的验证；
- 自动创建独立 PostgreSQL 数据库/数据库生命周期管理；
- 对父生产端口 `20003`、Show 端口 `20004` 的端口/进程前后快照证明。

**影响**

本次真实测试证明了“能启动一个父服务并读到两个健康接口”，但不能证明任务书要求的完整 Local 交付链路，也不能从测试结果推出生产进程和端口未被访问或修改。

**建议**

将 integration test 改为独立临时配置、独立数据库、动态端口，并显式请求 `/api/setup/status`；记录并断言 manager 只停止自己启动的 PID；对 20003/20004 做只读端口/进程快照并断言未变化。

### F-03 [高] 主进程实际使用的 URL 安全策略弱于已测试的 `url-policy.js`

**证据**

`src/main.js` 自己实现了 `validateRemote()` 和 `isPrivateHost()`，没有复用 `src/url-policy.js`。主进程版本：

- 只检查少数 IPv4 前缀、`localhost`、`127.0.0.1`、`::1`；
- 不做 DNS 解析后内网地址检查；
- 不覆盖完整的保留地址、链路本地/IPv6 私有范围等；
- 仅拒绝 query 中精确的 `token`/`key`，与 `url-policy.js` 覆盖的 secret/code/auth/ticket/session/state 等集合不一致。

而现有 `core.test.js` 测试的是 `url-policy.js`，没有测试 Electron 主进程真正调用的校验路径。

**影响**

单元测试通过不能代表 Desktop 实际连接路径对恶意 URL 安全。Remote 连接、协议转向和外链 IPC 都可能绕过更完整的策略，形成 SSRF/敏感 URL 处理边界不一致。

**建议**

删除主进程重复策略，统一调用 `validateRemoteUrl()`；为主进程连接、协议参数、`open-external` IPC 增加恶意 URL、DNS 解析到内网、IPv6/保留地址、凭据和敏感 query 测试。

### F-04 [高] 协议转向未真正校验 state，且实现与 RedirectFlow 脱节

**证据**

`src/main.js` 的 `handleProtocol()` 读取 `serverUrl` 或 `redirect` 后直接调用 `connect()`，并将 `pendingState` 设为 `null`；没有解析/消费 `state`，也没有调用 `RedirectFlow.parseCallback()`。`pendingState` 既没有创建来源，也没有有效消费逻辑。

现有测试只验证 `RedirectFlow` 内存对象的 state 一次性和过期行为，没有覆盖 `handleProtocol()` 的真实入口。

**影响**

任务书要求“回调只接受当前进程创建且未过期的 state”、恶意 URL/重复 state/跨 origin 测试。当前真实自定义协议入口可以在没有有效 state 的情况下尝试连接任意候选地址（之后仍受较弱的主进程 URL 校验影响），不能证明转向防串线要求已实现。

**建议**

让协议入口统一经过 `RedirectFlow.parseCallback()`，明确区分 `connect` 与 OAuth callback 的允许格式；拒绝缺失、未知、过期、重复、跨流程 state，并对这些路径增加入口级测试。

### F-05 [中] 任务书声明的导航白名单、IPC 最小权限和模式转换没有测试

**证据**

`test/core.test.js` 与 `test/server-manager.test.js` 共 11 个测试，没有覆盖：

- `BrowserWindow` 的 `contextIsolation/nodeIntegration/sandbox` 配置；
- preload 暴露方法是否仅为规定的最小集合；
- Local 仅允许自己的动态 `127.0.0.1:<port>`；
- Remote 仅允许当前 origin；
- 任意外部链接是否只能交给系统浏览器；
- `requestSingleInstanceLock` 和第二实例协议参数转交；
- Local/Remote/Team 状态转换；
- 重启、退出时只停止自己进程。

**影响**

这些是任务书列为“必须通过的单元/静态测试”的边界，但目前主要靠人工阅读代码，回归时容易失效。尤其是主进程代码存在重复 URL 策略，更说明只测纯模块不足。

**建议**

抽出可测试的导航/协议/模式函数，或使用 Electron mock 做入口测试；至少覆盖允许、拒绝、外部打开、第二实例和本进程 PID 生命周期。

### F-06 [中] `LocalServerManager` 的“只杀自己的 PID/进程树”保证不完整

**证据**

`stop()` 只对保存的 child 调用 `SIGTERM`，超时后对同一 child 调用 `SIGKILL`；没有进程树终止、PID + command/cwd 校验或残留 PID 处理。主进程 `before-quit` 也只对 `localProcess` 调用 `SIGTERM`。现有测试只验证 manager 启动的 mock child 可 ready/stop，没有验证同端口生产进程保护、错误 PID、子进程树或残留 PID。

**影响**

尚未满足任务书关于“进程树”“崩溃重启和残留 PID 经过 PID + command/cwd 校验”的安全交付要求。当前测试不能排除服务端派生子进程残留，也不能证明重启/退出不会误操作外部进程。

**建议**

记录并校验启动 child 的 PID、命令和 cwd；按平台实现受控进程树退出；增加冲突/伪造 PID/子进程和生产端口保护测试。不能按进程名全局 kill。

### F-07 [中] README 基本完整，但没有如实覆盖测试缺口和完整交付操作

**已有内容**

README 已说明：开发启动、`CREWROUTER_SERVER_ROOT`、动态回环端口、独立 userData 日志、PostgreSQL 依赖、stage/pack 命令、Linux AppImage、Windows/macOS 未交叉验证、Demo 不负责认证/Token/代理、基础 Electron 安全设置。

**缺口**

- 没有明确列出 `npm install` 后必须运行的完整验证顺序和预期输出；
- 没有记录 `npm test` 当前 11 项覆盖范围；
- 没有说明真实 integration test 不验证 `/api/setup/status`、独立 PostgreSQL 和 20003/20004 快照；
- 没有明确说明当前 `npm run build` 在未安装依赖时会失败，以及没有锁文件导致的复现风险；
- 没有把“GUI 未验证”作为本次交付状态单独列出；
- README 的安全说明没有揭示 `main.js` 与 `url-policy.js` 存在两套不一致校验实现。

**影响**

文档能帮助开发者启动，但不足以作为可审计的交付说明；读者容易把单元测试通过误解为 Electron 端到端安全边界已验证。

**建议**

补充“已验证/未验证”矩阵、依赖安装/锁文件要求、真实 integration 的前置条件和检查项，并明确 GUI、跨平台打包、数据库 bundle 的发布前状态。

## 三、按任务书边界的覆盖矩阵

| 边界 | 当前状态 | 评定 |
|---|---|---|
| 恶意 URL：协议、localhost、内网 IP、DNS 内网、凭据/query 脱敏 | `url-policy.js` 有部分单测；真实主进程未复用且未测 DNS/IPv6/保留地址 | **不完整** |
| state：随机、过期、一次性、重放 | `RedirectFlow` 单元测试通过 | **模块级通过，真实协议入口未覆盖** |
| profile：schema、损坏恢复、多 profile 切换、非敏感元数据 | 有单测，基本覆盖 | **部分通过**；未测权限/并发写入/失败保留的完整路径 |
| 端口：动态端口、避免 20003/20004、冲突 | 动态端口单测和真实动态端口通过 | **不完整**；无 20003/20004 前后快照，无并发冲突证明 |
| 实例：personal/team/invalid/missing | parser 单测；真实服务返回 `team` | **部分通过**；未验证 setup 状态和冲突/异常字段的真实连接路径 |
| 进程安全：只停止自己 PID、进程树、残留 PID 校验 | 有 child stop 实现 | **未满足测试边界** |
| navigation/IPC/单实例 | 代码存在基础配置和实现 | **未测试** |
| Local integration：真实 server、version、setup/status、instance、stop、隔离 DB | 真实 server/version/instance/stop 通过；其余缺失 | **不完整** |
| build/交付包 | 配置声明 Linux AppImage | **未通过**，命令因依赖缺失失败 |

## 四、交付结论

当前 Desktop 具备可运行的 Node 层核心雏形：11 个模块测试通过，语法检查通过，真实父项目服务端可在动态回环端口启动并被 manager 检测/停止。README 也覆盖了主要开发和安全意图。

但按任务书的完成定义，仍有明确阻塞项：

1. `npm run build` 实际失败，依赖不可复现；
2. Local integration 未验证 `/api/setup/status`、隔离 PostgreSQL 及生产端口/进程不变；
3. 主进程真实 URL 校验绕过了更完整的 `url-policy.js`；
4. 自定义协议入口没有实际消费 state；
5. 导航、IPC、单实例、模式转换和进程树安全没有测试证明。

因此结论为：**测试基础通过，但 Desktop 测试与交付质量未达到可签收标准；建议标记为“开发阶段可运行、交付前需修复/补测”，而不是完成交付。**
