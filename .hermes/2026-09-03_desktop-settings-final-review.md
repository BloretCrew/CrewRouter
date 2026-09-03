# Desktop 设置最终只读复审报告

- 复审日期：2026-09-03
- 复审范围：最终修复后的 `CrewRouter-Desktop` 设置窗口、设置专用 preload、相关主进程 IPC、callback fragment 校验及测试。
- 复审方式：只读检查源码、最终修复提交 `d06b6a75b911d90ad226c0f854c99d72f70354cb`、现有测试，并执行语法检查和测试命令。
- 实现代码：未修改。

## 结论

复审报告中指出的两个设置问题已正确修复：

1. 设置窗口现在明确使用 `src/settings-preload.js`，不再继承主窗口的完整连接桥接。
2. `desktop:restart-local` IPC 现在只接受可信设置窗口来源；主窗口 preload 不再暴露 `restartLocal`。

未发现由本次修复引入的实现回归。callback fragment 校验也已补齐并有测试覆盖。

## Issues

为空。未发现需要修改实现代码的问题。

## 复审明细

### 1. `settings-preload.js` 白名单

- `src/settings-preload.js` 仅暴露设置页所需的：读取/保存设置、profile 重命名/删除、本地服务停止/重启、诊断信息。
- 未暴露主窗口的连接控制能力，包括 `connectRemote`、`connectCustomRemote`、`chooseMode`、`switchProfile`、`openExternal`、`quit`、`openSettings` 及状态订阅。
- 使用 `Object.freeze` 暴露桥接对象，符合最小权限方向。
- `src/preload.js` 已移除 `restartLocal`，避免主窗口获得设置页专用重启能力。

### 2. 设置窗口 IPC 可用性与来源限制

- `createSettingsWindow()` 使用 `preload: path.join(__dirname, 'settings-preload.js')`，同时保留 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 设置页所需 IPC handler 均已注册：`desktop:get-settings`、`desktop:save-settings`、`desktop:rename-profile`、`desktop:delete-profile`、`desktop:stop-local`、`desktop:restart-local`、`desktop:get-diagnostics`。
- `isSettingsFrame()` 校验设置窗口 `webContents`、精确 `file://.../settings.html` 主 frame；设置窗口也拒绝 window.open、非设置页导航和 webview attach。
- `desktop:restart-local` 已从“主窗口或设置窗口”收紧为“仅设置窗口”。

### 3. 主窗口既有连接能力

- 主窗口 preload 仍保留已有连接流程能力：状态读取、模式选择、本地用户名设置、官方 Demo 连接、自定义远程连接、外部链接、安全 profile 列表/切换、退出、打开设置及状态监听。
- 本次修复仅移除主窗口的 `restartLocal`，未误删远程/本地连接、profile 切换或打开设置能力。
- 主进程仍保留对应 handler，包括 `desktop:get-status`、`desktop:choose-mode`、`desktop:setup-local-profile`、`desktop:connect-remote`、`desktop:connect-custom-remote`、`desktop:open-external`、`desktop:list-profiles`、`desktop:switch-profile`、`desktop:open-settings`、`desktop:quit`。

### 4. callback fragment 校验

- `src/redirect-flow.js` 的 `parseCallback()` 在处理 state 和目标服务器前拒绝任何 `url.hash`，错误为“回调不得携带 fragment”。
- `test/core.test.js` 新增带 `#access_token=secret` 的 callback 断言，确认 fragment 被拒绝。
- 该校验与已有的 callback 协议、state 必填、敏感 query 参数拒绝、单次 state、目标 origin 绑定逻辑共同生效。

### 5. 测试覆盖

- `npm run syntax`：通过。
- 补充执行 `node --check src/settings-preload.js`、`node --check src/renderer/settings.js`、`node --check src/renderer/renderer.js`：通过。
- `npm test`：28/29 通过，1 项失败；失败原因为当前工作树缺少已声明依赖 `CrewRouter-Desktop/node_modules/@bloret-crew/blora-design/package.json`，不是设置实现或本次修复逻辑失败。其余包括设置桥接静态检查、设置 IPC 注册检查、fragment 拒绝测试均通过。
- 现有测试对 preload 白名单和 IPC 注册主要采用源码静态断言，尚未通过 Electron mock/GUI 实际创建窗口验证桥接对象和 sender/frame 运行时行为；这属于测试深度限制，不构成本次修复确认到的实现问题。

## 验证限制

当前未执行 Electron GUI/E2E；`npm test` 不能完全通过是因为 Desktop 依赖未安装或未准备到当前工作树。该限制已单独记录，不将其误判为本次设置修复回归。
