# Desktop 设置 MVP 审查

依据计划：`/data/CrewRouter/.hermes/plans/2026-09-03_desktop-settings-plan.md`

审查范围：当前 worktree 中 `CrewRouter-Desktop` Desktop 设置 MVP 及其相关 IPC、Profile Store、连接元数据与现有控制台入口。未修改实现代码。

## 验证

- `cd CrewRouter-Desktop && npm test`：28 个测试中 27 个通过，1 个失败。失败原因是当前 worktree 缺少 `CrewRouter-Desktop/node_modules/@bloret-crew/blora-design/package.json`，属于测试依赖未安装，非断言失败。
- `cd CrewRouter-Desktop && npm run syntax`：未执行到该脚本，因为同一命令链上的 `npm test` 先失败退出；已对主要新增脚本执行 `node --check`（`src/main.js`、`src/preload.js`、`src/profile-store.js`、`src/connection-manager.js`、`src/server-manager.js`、`src/renderer/renderer.js`、`src/renderer/settings.js`），未发现语法错误。
- 发现仓库在审查开始前已有与本任务无关的删除/修改/未跟踪文件；本审查未触碰这些文件。

## Issues

### 1

- Severity: bug
- File: `CrewRouter-Desktop/src/connection-manager.js:40-55`, `CrewRouter-Desktop/src/profile-store.js:30-34`
- Description: 远程 URL 只禁止敏感 query 参数和 credentials，没有禁止或清理 URL fragment。形如 `https://remote.example/#access_token=secret` 的地址会通过校验，并以完整 URL 写入 `profiles.json`；设置页也会直接显示该 URL。Fragment 虽不会随 HTTP 请求发送，但常用于 OAuth access token，违反计划中“不得把 Token/API Key 写入普通 JSON、设置值不进入 URL/日志”的数据边界。
- Suggestion: 对 fragment 做与 query 相同的敏感字段检查，至少拒绝包含 `token|secret|key|code|auth|ticket|session|state` 的 fragment；更稳妥的是持久化时只保存 origin/path 等无凭据部分，并在连接和诊断展示前统一使用脱敏 URL。
- Status: open

### 2

- Severity: bug
- File: `CrewRouter-Desktop/src/renderer/settings.js:6-9`
- Description: 设置页的 bridge 容错不完整。`api` 为空时，初始 `getDesktopSettings()` 错误虽被捕获，但脚本随后仍无条件绑定事件；切换语言会调用 `render()`，而 `data` 仍为 undefined，导致页面脚本异常。其他控件操作还会继续调用 `api.saveDesktopSettings`、`api.restartLocal` 等不存在的方法并产生未处理 rejection。计划要求“未安装 Desktop bridge 时页面不崩溃”，当前只能部分显示错误，交互路径仍会崩溃。
- Suggestion: 在入口先检测 bridge 及所有必需白名单方法；缺失时禁用设置控件、显示稳定的不可用状态并直接返回。异步初始化失败时不要绑定依赖 `data` 的事件，所有操作统一使用受保护的 action wrapper。
- Status: open

### 3

- Severity: bug
- File: `CrewRouter-Desktop/src/renderer/settings.js:6`
- Description: i18n 不完整且有可见的语言回归：字典没有 `theme` key，`t('theme')` 会回显 `theme`；PID、Port、Ready、Stopped、Copied 等文本硬编码，切换 English/中文时不会翻译；`settings.html` 中 select option 的 System/Light/Dark 也硬编码。计划明确要求中英文 key 对齐和 i18n 验证。
- Suggestion: 为所有 `data-i18n` 和动态状态文本补齐 zh/en key，并通过同一翻译函数渲染 option、状态和复制反馈；增加设置页字典 key 对齐测试。
- Status: open

### 4

- Severity: bug
- File: `CrewRouter-Desktop/src/renderer/settings.js:6`
- Description: 选择 `theme=system` 时始终设置 `data-blora-color-scheme` 为 `dark`，没有读取 `prefers-color-scheme`，而设置页始终加载 `tokens.dark.css`。因此“跟随系统”实际上固定为深色，浅色/系统主题行为与计划和 UI 选项含义不一致。
- Suggestion: 对 system 使用 `matchMedia('(prefers-color-scheme: dark)')`，监听变化并应用 light/dark；同时确保浅色 token/主题样式可用，或移除尚未实现的选项并明确标记为未支持。
- Status: open

### 5

- Severity: suggestion
- File: `CrewRouter-Desktop/src/main.js:116-135`, `CrewRouter-Desktop/src/renderer/settings.js:1-9`
- Description: 设置窗口虽禁止 `will-navigate`，但没有像主窗口一样设置 `setWindowOpenHandler`、外链策略和更严格的页面来源约束。当前设置页是本地静态文件，尚未发现可控外链注入，但它持有 `getDiagnostics`、Profile 修改、Local Server 停止/重启等高权限 bridge；未来任一设置页 DOM/XSS 回归都会直接扩大 IPC 攻击面。
- Suggestion: 为设置窗口配置 `setWindowOpenHandler` 拒绝所有新窗口，并在每个 settings IPC handler 同时校验 sender 的 settings 文件 URL/主框架状态；为本地 renderer 页面增加 CSP，避免将高权限窗口仅依赖 webContents 对象身份保护。
- Status: open

### 6

- Severity: suggestion
- File: `CrewRouter-Desktop/src/main.js:153-179`, `CrewRouter-Desktop/src/server-manager.js:300-312`
- Description: Local 停止/重启实际操作的是 `state.local` 当前持有的 `LocalServerManager`，其 `stop()` 通过保存的 child 对象发送信号，未在操作前显式核对目标 PID、启动标识或子进程仍属于当前 Desktop 实例。当前代码路径下对象引用使误杀风险较低，但计划要求“必须验证目标实例归 Desktop 所有”；MVP 没有可审计的归属校验，且 `get-settings` 将 PID 直接暴露给设置页但没有归属证明。
- Suggestion: 在 manager 中记录启动 nonce/child PID/parent ownership，并在 stop/restart 前校验 manager token、child 对象和 PID 状态；只允许操作该 manager 本次 spawn 的 child，拒绝外部传入 PID，测试覆盖 PID 替换、进程退出和 PID 重用场景。
- Status: open

### 7

- Severity: suggestion
- File: `CrewRouter-Desktop/src/connection-manager.js:8-28`, `CrewRouter-Desktop/src/main.js:45-59`
- Description: Desktop 当前只接受 `server` 与 `desktop-local` runtime，远程连接永远按 `server` 处理；设置窗口也只在 `local` 连接成功后创建，主窗口按钮仅在 `desktop-local` 时显示。计划允许第一阶段只开放 Local（前提是明确 Remote 暂不开放），但当前实现没有在 UI/代码中明确说明 Remote Desktop 设置未开放，且没有可信 `desktop-remote` 连接上下文或对应回归测试。
- Suggestion: 若 MVP 有意只支持 Local，应在计划验收和界面中明确“Remote Desktop 设置暂未开放”，并增加普通远程页面不可调用设置 IPC 的测试；若要支持 Remote，则先实现不可伪造、短期、不可转移的连接上下文，禁止仅凭 runtime/header 显示入口。
- Status: open

### 8

- Severity: nit
- File: `CrewRouter-Desktop/src/renderer/settings.js:6`, `CrewRouter-Desktop/src/renderer/settings.html:4-8`
- Description: 设置页把 Profile 的 `id` 直接插入 `data-rename`/`data-delete` 属性，虽当前 id 通常由 `randomUUID()` 生成，Profile Store 仍会接受磁盘中的任意字符串；名称和 URL做了 HTML escape，但 id 未 escape。攻击者需要先修改本地 userData 文件，风险较低，但这使本地存储篡改可进一步变成 DOM 属性注入。
- Suggestion: 对属性值统一 HTML escape，或避免拼接 HTML，使用 DOM API 设置 dataset；同时对 Profile id 做严格格式校验和长度限制。
- Status: open

## 已确认的正向结果

- 远程页面不能通过当前 renderer 来源校验调用高权限 IPC：`isRendererFrame` 要求主窗口仍处于本地 file 页面且 `!state.currentTarget`；设置 IPC 仅接受 `state.settingsWindow.webContents`。
- Preload 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，且仅暴露白名单方法；没有暴露通用 `send`/任意 channel。
- Profile Store 使用 `userData/profiles.json`、临时文件原子替换和 mode `0600`；设置保存通过白名单字段归一化，测试确认额外 `token` 字段不会落盘。
- 本地 Server 配置、数据和日志目录使用 Desktop userData 下的隔离路径，配置和日志权限为 `0600`；子进程环境会清理生产配置/数据库相关环境变量。
- 设置页渲染名称、URL、连接字段时使用 HTML escape；600px CSS 断点处理了 Profile 换行和长值溢出。
- Local Server 重启/停止均需从设置窗口触发，停止操作有确认提示。
