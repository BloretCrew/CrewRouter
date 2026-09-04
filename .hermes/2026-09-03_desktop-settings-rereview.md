# Desktop 设置修复独立复审

复审日期：2026-09-03
复审对象：当前 worktree `CrewRouter-Desktop` 及上一版报告 `/data/CrewRouter/.hermes/2026-09-03_desktop-settings-review.md`
复审方式：独立阅读实现、历史问题响应、测试与静态检查；未修改实现代码。

## 验证结果

- 上一版 8 项问题逐项复核：1、2、3、4、5、6、8 已在当前代码中看到对应修复；第 7 项按上一版记录为 `wontfix`，当前仍保持 Local-only，并在设置页显示 Remote Desktop 暂未开放说明。
- `cd CrewRouter-Desktop && npm run syntax`：通过。
- `cd CrewRouter-Desktop && npm test`：29 个测试中 28 个通过、1 个失败。失败为 `test/renderer.test.js` 读取缺失的 `CrewRouter-Desktop/node_modules/@bloret-crew/blora-design/package.json`，与上一版相同，属于测试依赖未安装，不是断言失败。
- 静态 i18n key 对齐检查：`settings.html` 的全部 `data-i18n` key 均存在于 zh/en 两套词典；动态状态、主题、复制反馈也使用词典 key。
- 当前 worktree 在复审前已有与本任务无关的删除、修改和未跟踪文件；复审未触碰这些文件。

## 逐项复核

### 1. Fragment/token 是否可能落盘

上一版问题已修复：`validateRemoteUrl` 拒绝任何 URL fragment 和敏感 query/credentials；Profile Store 只保存归一化白名单字段；设置保存只保留四个设置字段；诊断为白名单字段；日志对常见凭据做脱敏。当前正常连接和设置保存路径不会把 URL fragment、access token 或 API key 写入 `profiles.json`。

补充注意：`RedirectFlow.parseCallback` 目前只检查 callback 的 query 参数，没有显式拒绝 callback URL 的 fragment。其 target 仍经过 `validateRemoteUrl`，且 callback fragment 不会被写入 profile；但带有 `#access_token=...` 的回调会被接受后丢弃 fragment。该行为不会导致当前已审计的普通 JSON 落盘，但属于凭据输入边界不一致，列入 Open Issues 1。

### 2. 设置窗口 IPC 来源校验

设置 IPC 要求 sender 是当前 `state.settingsWindow.webContents`，且 sender frame URL 精确为 settings file URL，并拒绝非主框架；设置窗口禁止新窗口、webview 和非 settings file 导航。普通远程页面不能满足该 sender 条件，当前来源校验未发现可通过导航或 preload bridge 绕过的路径。

发现一个边界回归：`desktop:restart-local` 使用 `!isRendererFrame(event) && !isSettingsFrame(event)`，因此主窗口 renderer 也被允许调用 restart；这与“设置 IPC 仅接受设置窗口”及“Local 停止/重启均需从设置窗口触发”的既定边界不一致。当前主 renderer preload 仍暴露 `restartLocal`，所以这不是纯理论上的不可达 channel。列入 Open Issues 2。

### 3. stop/restart 安全性

`LocalServerManager` 保存 child 引用、PID 和启动 nonce；`stop(expectedNonce)` 校验 nonce、PID 与 child 对象后才发送信号，不接受外部 PID，设置页停止还有确认提示。设置 IPC 也不接受目标 PID。当前未发现可由设置输入导致误杀其他进程的路径。

但 restart 复用 `startLocal()`：先停止现有 manager，再创建新 manager；并且重启 IPC 当前可由主 renderer 触发，扩大了高权限操作入口，和上面的来源边界问题相同。除此之外，未发现新的明确 stop/restart 进程归属绕过。

### 4. settings bridge 失败时交互稳定性

启动时检查完整方法白名单；bridge 缺失时先渲染静态翻译文本、禁用 button/select/input 并显示稳定错误；初始化 IPC 失败时同样进入不可用状态，不绑定后续交互。正常初始化后的所有异步操作都通过 `action` 捕获 rejection；`render()` 对无 data 直接返回。当前未发现 bridge 缺失、初始化失败或单次操作失败会产生未处理 rejection 的路径。

### 5. i18n key 对齐

zh/en 词典均覆盖设置页 `data-i18n` key；动态 mode/target/runtime/edition/status/PID/port、主题 option、Profile 操作和复制反馈均有对应 key。设置页固定的 `Profiles`、`Local Server`、语言 option/aria-label 等仍有少量非 `data-i18n` 文案，但不构成上一版所述 key 缺失或动态状态语言回归。

### 6. system theme

设置页先加载 light tokens，再加载 dark override；`applyTheme('system')` 读取 `matchMedia('(prefers-color-scheme: dark)')` 并设置 `data-blora-color-scheme` 为 dark/light，且监听系统主题变化。light/dark 显式选择也会应用对应 scheme。实现与 token 文件的选择器匹配，未发现 system 固定为 dark 的回归。

### 7. CSP

设置页 CSP 为 `default-src 'none'; style-src 'self'; script-src 'self';`，页面只加载本地 CSS/JS；同时窗口拒绝新窗口、webview 和非 settings file 导航。当前未发现设置页必须资源被 CSP 阻断，也未发现可利用的 inline script、外链资源或 renderer 导航路径。

## Open Issues

### 1. Callback fragment 未被拒绝

- Severity: low/medium
- File: `CrewRouter-Desktop/src/redirect-flow.js:34-43`
- Description: `parseCallback()` 仅遍历 `url.searchParams` 检查敏感 callback 参数，没有检查 `url.hash`。带有 `#access_token=...` 的 callback 会通过 callback 层校验，随后 fragment 被忽略。它不会沿当前 target/profile 路径落盘，但会使 OAuth 凭据输入边界与普通 URL 校验不一致，并可能在协议回调错误处理、系统 URL 记录或调试环境中短暂暴露。
- Recommendation: 对 callback URL 的非空 fragment 直接拒绝；至少拒绝包含敏感字段的 fragment，并补充 fragment token 测试。
- Status: fixed
- Response: 已在 RedirectFlow.parseCallback 中拒绝任意非空 fragment，并补充 access_token fragment 回归测试。

### 2. restart IPC 仍允许主 renderer 来源

- Severity: medium
- File: `CrewRouter-Desktop/src/main.js:173-175`
- Description: `desktop:restart-local` 使用 `if (!isRendererFrame(event) && !isSettingsFrame(event))`，所以主窗口 renderer 满足 `isRendererFrame` 时可以调用 restart。主 renderer preload 也暴露 `restartLocal`。这违反当前报告已确认的“Local Server 重启/停止均需从设置窗口触发”边界；在主窗口处于本地 file 页面且本地 manager 存在的竞态/路径下，主 renderer 可触发停止并重启本地服务。
- Recommendation: restart handler 与 stop/settings handler 一致，仅接受 `isSettingsFrame(event)`；若主页面确需该能力，应改为受限且明确的 UI 入口并重新审计，不要依赖 preload 暴露即视为授权。
- Status: fixed
- Response: 已收紧为仅接受设置窗口来源；主窗口 preload 移除 restartLocal，设置窗口改用独立 settings-preload 暴露该能力，并补充静态回归测试。

## 结论

上一版 8 项问题的修复均有对应实现（第 7 项按 Local-only 决策继续 wontfix），本次两个 Open Issues 已修复并补充测试。当前未发现 fragment/token 普通设置数据落盘、设置窗口来源校验可由导航绕过、restart IPC 越权、stop 目标 PID 外部注入、bridge 失败导致交互崩溃、i18n key 缺失、system theme 固定深色或 CSP 资源配置错误。当前 Open Issues 已清零。
