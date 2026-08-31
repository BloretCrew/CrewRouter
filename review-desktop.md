# CrewRouter-Desktop 实现审查报告

> 审查范围：主仓库当前工作树中的 `/data/CrewRouter/CrewRouter-Desktop`，重点核验任务书中 LocalServerManager、ConnectionManager、redirect-flow 的实际接线，以及导航安全、DNS/内网防护、IPC、退出清理、配置隔离和 Local/Remote/Team 状态。
>
> 结论基于源码、任务书、README、全部 Desktop 测试文件及实际执行的 `npm test`、`npm run syntax`。本次未修改实现代码；只新增本报告。

## 严重程度汇总

| 严重程度 | 数量 | 说明 |
|---|---:|---|
| **Critical** | 1 | Local 启动路径可能继承生产配置/数据库，任务书要求的隔离没有落到实际主流程 |
| **High** | 5 | 核心管理模块未接线、远程连接配置不保存、redirect flow 未接线、内网/DNS 防护旁路、退出清理不满足要求 |
| **Medium** | 4 | 导航和 IPC 边界不足、模式状态不完整、Local 健康检查不完整、测试覆盖与真实集成验证不足 |
| **Low** | 1 | 已实现的独立 URL policy 对凭据 URL 的拒绝不完整 |

---

## Findings

### CRITICAL-1：主流程未使用隔离配置，Local 可能读取父项目生产配置/数据库

**证据**

- `src/main.js:45-58` 的 `startLocal()` 直接调用 `spawn()`，没有实例化或调用 `LocalServerManager`。
- 子进程环境是 `{ ...process.env, NODE_ENV: 'production', CR_RUNTIME: 'desktop-local', CR_EDITION: 'personal', CR_APP_HOST: ..., CR_APP_PORT: ... }`，没有清除 `CR_CONFIG`、`CR_CONFIG_PATH`、`CR_DATA_DIR`、`CR_LOG_DIR`、`CR_DB_*` 等父环境变量，也没有生成 `userData/runtime/config.json`、独立 data/log 路径。
- 子进程 cwd 是 `serverRoot`，父项目的 `server/config-loader.js` 会从源码/当前工作目录候选路径寻找 `config.json`。在 `CREWROUTER_SERVER_ROOT=/data/CrewRouter` 的常见开发启动下，存在直接命中父项目 `config.json` 的路径。
- 任务书明确要求 Local 覆盖独立配置、数据/日志路径，且不得触碰父项目配置和生产数据库；当前实际 main 流程没有做到。

**影响**

点击“启动本地服务”可能启动真正的 CrewRouter，但使用父项目的配置、数据库或密钥，而不是 Desktop 私有实例；这不仅是不满足隔离要求，也存在改写/迁移生产数据的风险。`server-manager.js` 中虽然实现了环境变量清理和 `createRuntimeConfig()`，但因未被 main 使用，不能降低实际风险。

**建议**

让 main 只通过 `LocalServerManager` 启动，并传入 `app.getPath('userData')`、动态端口、独立 runtime/data/log 路径；显式清理所有配置、数据库、监听器相关父环境变量，并在真实集成测试中证明父项目 `config.json`/生产数据库未被访问。

---

### HIGH-1：LocalServerManager、ConnectionManager、RedirectFlow、ProfileStore 均未接入 Electron 主流程

**证据**

- `src/main.js` 未 `require()` `server-manager.js`、`connection-manager.js`、`redirect-flow.js` 或 `profile-store.js`。
- `src/main.js` 自己实现了 `startLocal()`、`validateRemote()`、`connect()` 和 `handleProtocol()`。
- `src/connection-manager.js`、`src/redirect-flow.js`、`src/profile-store.js` 只在测试中被直接调用；源码搜索未发现 main 或 renderer 对它们进行实例化。

**影响**

任务书要求的可测试模块只是“存在”，而不是实际产品行为。生产流程没有获得 server manager 的隔离/停止逻辑、connection manager 的 edition/capabilities/profile 逻辑，也没有 redirect flow 的 state 校验。

**建议**

在 app 生命周期内创建并持有这些管理器的单例；IPC handler 只调用管理器 API，删除或统一主流程中的重复安全实现，避免测试通过的模块与实际运行代码分叉。

---

### HIGH-2：Remote 连接不保存 profile，ConnectionManager 的配置隔离/失败保留能力未实现

**证据**

- `src/main.js:40-44` 的 `connect()` 只调用 `/api/instance`、设置 `currentTarget`/`mode` 并 `loadURL()`，没有 `ProfileStore` 路径，也没有 `ConnectionManager.connect()`。
- `src/preload.js` 没有 profile 列表、切换或删除 API；renderer 也只有输入 URL、Local、Remote、退出三个操作。
- 因此 URL、edition、capabilities、protocolVersion、最后连接时间不会保存到 `userData`，也不存在多个 profile 或 active profile 的用户可见行为。

**影响**

任务书“连接配置能力”和 Personal/Team/测试服务器 profile 要求未满足；重启应用后没有连接配置状态，远程失败时也无法验证保留既有有效 profile。

**建议**

Remote 成功连接必须经过 ConnectionManager，并将仅含非敏感元数据的 profile 写入 Electron userData；增加最小的 profile 列表/切换 IPC 或明确的 UI 入口。保留已有 profile 的行为应有测试。

---

### HIGH-3：官方 Demo/custom protocol 的实际转向没有使用 state，也没有调用 redirect-flow

**证据**

- `src/main.js:16` 的 `pendingState` 从未被赋值或消费；`DEMO_URL` 常量也从未使用。
- `handleProtocol()` 仅读取 `serverUrl` 或 `redirect`，没有要求 state、没有 `consumeState()`，也不检查当前进程创建的 state、有效期或一次性消费。
- `src/redirect-flow.js` 虽实现了 state，但没有被 main 调用。`handleProtocol()` 调用 `connect(validateRemote(candidate, false))`，而 `connect()` 是 async；同步 `try/catch` 无法捕获其异步拒绝，协议回调失败可能形成未处理 Promise rejection。
- README 说可由外部入口发起 `crewrouter://connect?...`，但当前主流程没有真正的 Demo URL/state 流程。

**影响**

串线防护、过期 state、重放拒绝和有限 callback 格式校验只存在于未接线的模块中；任何能触发协议参数的调用都可直接尝试连接目标 URL。任务书要求的官方 Demo“只转向、显式流程”没有真实落实。

**建议**

用 RedirectFlow 创建和消费 state；协议入口只接受已登记且未过期的 state，并在异步调用链中显式 await/catch。若第一版坚持“目标服务器自身登录”，应删除未使用的假入口，或完整实现并测试 documented 的转向流程。

---

### HIGH-4：实际 main 的远程 URL 校验没有 DNS 内网解析检查，存在 SSRF/内网旁路

**证据**

- `src/main.js:20-29` 的 `validateRemote()` 只检查少量字符串形式的 `localhost`、127/10/172.16-31/192.168；不解析域名，不检查 DNS 返回的 IPv4/IPv6、链路本地、保留地址、CGNAT 等范围。
- `src/url-policy.js` 才实现 `dns.lookup(..., { all: true })` 和较完整的 IPv4/IPv6 地址范围，但该模块没有被 main 使用。
- main 的 `openExternal` IPC 还显式调用 `validateRemote(url, true)`；当 `allowLocal=true` 时不仅允许 localhost，也完全跳过本地/内网限制。

**影响**

恶意公网域名解析到内网、IPv6 loopback/ULA、特殊保留地址等目标时，实际连接流程可能通过；loaded page 还可以通过暴露的 openExternal 入口请求本机/内网 URL。该问题直接违反“远程禁止内网、DNS 解析校验”的安全要求。

**建议**

所有远程目标统一调用 url-policy；allowLocal 只能在明确的 Local/开发入口下允许 loopback，不能作为“允许任意私网”的开关。应覆盖 DNS rebinding/多地址解析、IPv6、凭据 URL 和所有保留地址的测试。

---

### HIGH-5：退出和重启只 kill 直接子进程，不满足进程树/归属校验清理要求

**证据**

- `src/main.js:57` 重启时直接 `localProcess.kill()` 后立即置空并重新启动，没有等待退出、超时升级、PID+command/cwd 校验或子进程树处理。
- `src/main.js:65` 的 `before-quit` 只对直接子进程发送 `SIGTERM`，不等待完成，也不处理服务端进一步派生的进程。
- `LocalServerManager.stop()` 有等待和 SIGKILL fallback，但没有被 main 使用；任务书还要求残留 PID 必须做 PID + command/cwd 校验防止误杀，实际 main 没有实现残留 PID 机制。

**影响**

服务端未及时退出时可能遗留进程、端口或数据库连接；重启可能与旧服务竞争动态端口。虽然没有按名称全局 kill，但“只清理自己记录的进程树”这一完成条件仍未满足。

**建议**

统一使用 LocalServerManager.stop()；记录 child PID、entry、cwd，退出时等待并对确认属于该实例的进程树做受控清理，严禁全局按名称终止。增加退出期间的测试。

---

### MEDIUM-1：导航白名单允许任意 `file://` 导航

**证据**

- `src/main.js:61-62` 的 `will-navigate` 条件为 `if (!allowedNavigation(url) && !url.startsWith('file://')) ...`，意味着所有 `file://` URL 都放行。
- 允许 file 导航的实际需求仅是初始加载 `src/renderer/index.html`，但代码没有限定到该已知文件。

**影响**

远程页面或其他导航触发器可能把窗口导航到任意本地文件，读取/展示本地内容；虽然 `nodeIntegration` 关闭降低了进一步 Node 利用风险，但这不符合“只允许当前目标 origin/初始资源”的白名单要求。

**建议**

只允许启动阶段的精确 renderer index 文件，或在 `loadFile` 完成后拒绝全部 file 导航；所有其他协议交给系统浏览器前也应按明确策略处理。

---

### MEDIUM-2：IPC 缺少 sender/状态约束，远程页面可调用连接、退出和外部打开能力

**证据**

- preload 向任何当前页面暴露 `chooseMode`、`connectRemote`、`openExternal`、`restartLocal`、`quit`。
- `ipcMain.handle()` 没有校验 `event.sender` 是否为当前窗口、当前 frame 是否可信，也没有限制调用必须来自初始连接页。
- 连接后加载的远程 CrewRouter 页面同样获得该 bridge；因此该页面可以调用 `desktop:quit`、`desktop:restart-local` 或 `desktop:connect-remote`。

**影响**

远程服务器内容成为受信任的桌面控制面，至少可造成退出/重启和导航劫持；结合 `openExternal(..., allowLocal=true)`，不可信页面还可诱导系统打开本地/内网地址。任务书的“IPC 最小权限”不应只依赖 API 名称少，而应限制调用上下文和参数。

**建议**

对每个 handler 校验 sender、frame URL 和当前状态；连接成功后移除启动页专用 IPC，或将远程内容放在不暴露控制桥的独立窗口/受限导航上下文。openExternal 仅接受明确的 http/https 外链策略，并拒绝内网目标。

---

### MEDIUM-3：Local 健康检查没有验证 `/api/setup/status`，且没有真实 CrewRouter 隔离集成验证

**证据**

- `src/main.js:56-58` 只轮询 `/api/version`，随后 `connect()` 检查 `/api/instance`；没有 `/api/setup/status`。
- `scripts/test-local-server.js` 使用的是已实现的 `LocalServerManager`，只检查 `version` 和 `edition`，同样没有 `/api/setup/status`。
- 本次执行的 `npm test` 通过 11 项，`npm run syntax` 通过；测试中的“Local server”是临时 child HTTP fixture，不是真实 CrewRouter Server。
- 未执行 `npm run test:local-server`：该脚本需要独立 PostgreSQL/临时服务配置，当前证据不足以证明真实 Local Server、数据库隔离及停止行为。

**影响**

“服务 ready”判定比任务书规定的真实验证集不完整；单测通过不能证明 Desktop 主流程启动的是正确的真实服务，也不能证明生产端口 20003/20004 和生产数据库未被触碰。

**建议**

接线后的 manager 集成测试至少访问 `/api/version`、`/api/setup/status`、`/api/instance`，使用仓库外临时 config、独立 PostgreSQL 和动态端口；记录并断言生产端口/数据库未被访问。若 GUI 环境不可用，应在报告中明确 GUI 未验证。

---

### MEDIUM-4：Local/Remote/Team 状态没有形成实际可用状态模型

**证据**

- `main.js` 仅维护 `mode = 'connect'|'local'|'remote'` 和 `currentTarget`；`desktop:get-status` 只返回这两个字段。
- Remote 的 `instance.edition` 只用于一条状态文案，`capabilities`、`protocolVersion` 未保存或返回。
- Team 并没有独立的 profile/能力状态；renderer 也没有读取 edition/capabilities 或显示 active profile。

**影响**

虽然代码能在一次连接中接受 `personal`/`team`，但任务书要求的 Local/Remote/Team 状态转换、服务端能力权威展示和配置状态没有真实实现，用户无法可靠知道当前连接类型及能力。

**建议**

由 ConnectionManager 统一返回并持久化 `mode/edition/capabilities/protocolVersion`，status IPC 返回非敏感状态，renderer 显示 active profile 和实际 edition；Team 不要硬编码额外权限判断。

---

### LOW-1：独立 url-policy 未拒绝 URL 用户名/密码，且测试未覆盖

**证据**

- `src/url-policy.js:33-50` 检查协议和内网，但没有拒绝 `url.username`/`url.password`；`redactUrl()` 只负责脱敏，不能替代拒绝。
- `ConnectionManager.inspect()` 使用该 policy，因此即使 ConnectionManager 接线后，凭据仍可能被接受进 profile URL（尽管没有 token 保存）。
- `test/core.test.js` 只测试 query 脱敏，没有测试 URL basic-auth、token/key 等输入被拒绝。

**影响**

凭据可能进入 profile 元数据或错误/调试链路，违反任务书“不要接受凭据 URL”的边界。当前 main 的重复 validator 拒绝了 username/password 和 token/key，但这不能弥补独立模块及未来接线风险。

**建议**

policy 在验证阶段直接拒绝 username/password 和所有凭据 query；补充 access_token、refresh_token、token、secret、key、code、auth、session、state 等测试，并统一使用该 policy。

---

## 已满足或部分满足的项目

- `BrowserWindow` 配置了 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 具备单实例锁和 `crewrouter` 协议注册调用。
- `server-manager.js` 独立实现了动态端口、runtime 配置、环境变量清理、健康轮询、日志脱敏和停止超时；`connection-manager.js`、`redirect-flow.js`、`profile-store.js` 也有一定单测基础，但均未进入 main 实际路径。
- `stage-server.js` 排除了 `node_modules`、`.git`、`.env` 等目录/文件，README 明确说明 PostgreSQL 和跨平台验证限制。
- 本次 `npm test`：11/11 通过；`npm run syntax`：通过。该结果不能抵消上述主流程未接线和真实 Local 集成未验证问题。

## 审查结论

当前提交是“模块级原型 + 一个绕过这些模块的 Electron 壳”，不是任务书定义的已整合完成实现。最先必须修复的是 **CRITICAL-1**：阻止 Local 主流程继承/命中父项目生产配置和数据库；随后应将 LocalServerManager、ConnectionManager、RedirectFlow 接入 main，并补足 DNS/导航/IPC/进程清理和真实隔离集成测试。在这些问题修复前，不应宣称 Local、Remote/Team profile、Demo redirect 和安全边界已真实满足。
