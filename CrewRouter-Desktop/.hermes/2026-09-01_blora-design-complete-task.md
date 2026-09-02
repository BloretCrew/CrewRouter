# CrewRouter Desktop 完整 Blora Design 2.0 规范化任务书

> 给 Grok：在 `/data/CrewRouter/CrewRouter-Desktop` 继续完成启动/连接页。使用 `bloret-router`，只 commit 不 push。先检查当前真实工作树和 diff，不要 reset 或丢失已有功能。

## 上一轮验收结论：布局通过但桥接错误仍未通过

上一轮提交 `aa568ca` 后继续留下了未提交修改，并生成实时截图。之后提交 `376b686 fix: restore Electron preload bridge in verification`，但父会话检查真实代码发现：

- `src/preload.js` 本身暴露了 `window.crewrouterDesktop`；
- `src/main.js` 的正常 `createWindow()` 使用 preload；
- 但上一轮的真实截图仍显示“桌面桥接加载失败”；
- `376b686` 可能只修复了验证脚本创建 BrowserWindow 时没有传 preload 的问题，不等于正式应用启动流程已验证通过。

因此必须继续追查，不要把“验证脚本窗口带 preload”当成实际 Desktop 已修好。

## 本轮必须完成

1. 真实启动正式 `src/main.js` Electron 应用（不是只运行 `tmp-inspect.js` 或复制验证窗口），确认正式 BrowserWindow 的 preload 真的加载。
2. 使用真实 renderer console/主进程诊断确认 `window.crewrouterDesktop` 存在且 `getStatus()` 能返回，不再显示“桌面桥接加载失败”。
3. 如果 `isRendererFrame(event)` 拒绝 IPC，找出真实原因：file URL path、rendererEntry、origin、frame URL 或 preload 页面加载时序，并修复正式逻辑；不能关闭安全校验来绕过。
4. 真实截图应显示正常初始状态“请选择一个连接方式”，而不是 bridge 错误。Local/Remote 按钮应能触发 IPC（可以用真实失败/测试环境，但不能桥接失败）。
5. 保持已通过的 960x700 / 600x700 布局和正式 Blora 2.0 依赖，不得回退。
6. 检查 `src/main.js` 的 `createWindow()`、`getWindowWebPreferences()`、`isRendererFrame()`、`loadFile()`，以及 `src/renderer/renderer.js` 的 bridge 检查。必要时增加仅用于开发/验收的安全诊断，但不得泄露秘密。
7. 若 VNC GUI 启动方式造成窗口截图不可靠，用 Electron 自身 `webContents.capturePage()` 获取 content screenshot，同时使用真实正式 main 进程；报告 screenshot 是 content viewport 还是窗口外框。

## 当前代码约束

- Local：完整 CrewRouter Server，runtime=desktop-local、edition=personal、auth.required=false、demo=false、保留 login-report/stats-report；
- Remote：读取 `/api/instance`，自动识别 Personal/Team/auth；
- Personal Server 仅 Passport，Team 双登录；
- preload 最小 IPC、单实例、导航白名单、URL policy 不削弱；
- 官方 `@bloret-crew/blora-design@2.0.8` 和 vendor 资源继续使用；禁止 1.x API、Lucide、CDN-only、自写 token fallback。

## 测试与视觉验收

运行：

```bash
npm test
npm run syntax
npm run build
```

必须使用正式 Desktop main 流程生成并实际检查：

- `.hermes/screenshots/connection-960x700-live.png`
- `.hermes/screenshots/connection-600x700.png`

960x700 必须同时满足：品牌、标题、Local/Remote 卡片、两个按钮、输入框、正常状态区、页脚全部显示；无裁切、无横向/不必要纵向滚动；状态区不能是 bridge 加载失败。

600x700：单列、无横向溢出、第一卡片完整，第二卡片可自然滚动。

截图后必须读取图片内容，不能只检查文件存在。Electron GPU/libva/shutdown 噪声与页面 bridge 问题分开判断。

禁止触碰父项目生产服务 20003、Show 20004 或生产配置。

## 提交

只有正式 main 流程的 bridge 修复、测试和实际截图都通过后才能 commit。只 commit 不 push。输出真实根因、修改文件、测试、截图实际检查、Electron 环境限制、本地 commit hash。50轮不足先提交已验证阶段，下一轮继续，不要 reset。
