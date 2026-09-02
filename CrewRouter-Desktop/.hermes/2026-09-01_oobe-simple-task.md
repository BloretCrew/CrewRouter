# CrewRouter Desktop OOBE 简化任务书

> 给 Grok：在 `/data/CrewRouter/CrewRouter-Desktop` 简化 Desktop 首次启动 OOBE。使用 `bloret-router`，只 commit 不 push。只改 OOBE/启动连接页，不破坏后端、本地服务、远程转向、Blora 正式依赖、认证、上报和安全 IPC。

## 用户要求

当前 OOBE 太复杂，改成简单直接的首次启动页。

目标体验：

```text
第一次打开 Desktop
        ↓
选择一种方式

[本地使用]
启动本机完整 CrewRouter Personal Server（无需登录）

[连接服务器]
通过官方 Demo 转向入口连接 Personal/Team Server
```

## 简化原则

1. 首屏只保留产品名、简短说明和两个主要入口：`本地使用`、`连接服务器`。
2. 不在 OOBE 首屏展示大段技术说明、过多 feature list、复杂状态信息、重复的 Personal/Team 解释或调试信息。
3. 远程 URL 输入只在用户点击/选择“连接服务器”后显示；不要默认铺满首屏。
4. 如果保留高级/直接地址入口，放在清晰的次要操作中，不抢主流程；仍必须走官方 Demo 转向，不得绕过。
5. Local 入口必须清楚写“一键启动本地服务、无需登录”；不要要求选择 Personal/Team，因为 Local 固定是 personal。
6. 远程入口只写“连接已有服务器”，登录由目标服务器处理；Personal/Team 自动识别，不让用户手选。
7. 错误、loading、连接中状态用一个简洁状态区域表达；不要让状态文本撑坏布局。
8. 首次启动页面在 Electron 的 960x700 内容 viewport 内完整显示，不需要滚动；600x700 下也应保持清爽，必要时自然滚动。
9. 保持正式 Blora Design 2.0：使用官方 `.blora-card`、`.blora-button`、`.blora-input`、官方 token 和 vendor 资源；删掉不必要的自定义装饰、编号、英文 slogan、复杂阴影和重复状态点。
10. 保持可访问性：键盘可用、label/aria、live region、回车提交、错误可读。

## 建议页面结构

```text
品牌头部
  CrewRouter Desktop

欢迎区
  开始使用 CrewRouter
  选择本地使用或连接服务器

两个简洁选择卡片/按钮
  本地使用
  连接服务器

远程连接表单（默认可折叠/第二步显示）
  服务器地址
  连接
  返回

单一状态区
页脚：简短隐私/登录说明 + 退出
```

可以采用两步 OOBE：第一步只选择 Local/Remote；第二步 Remote 才显示 URL 输入。不要加入账号注册向导或额外配置向导。

## 业务约束

- Local 仍启动真实完整 CrewRouter Server：`runtime=desktop-local`、`edition=personal`、`auth.required=false`、`demo=false`、保留 login-report/stats-report。
- Remote 仍使用配置的官方 Demo 转向入口；没有配置时显示明确错误，不得静默直连。
- Remote 目标 Personal/Team 和登录方式由目标服务器 metadata/页面负责，Desktop 不新造登录系统、不保存 token/API key、不把凭据放 URL。
- preload、IPC、单实例、导航白名单、URL policy 不削弱。

## 必须先检查的文件

- `src/renderer/index.html`
- `src/renderer/renderer.js`
- `src/renderer/styles.css`
- `src/main.js`
- `src/preload.js`
- `src/redirect-flow.js`
- 相关 `test/*.test.js`

## 测试与视觉验收

新增/更新测试覆盖：

- OOBE 首屏只有简化的核心入口；
- Remote 表单显示/隐藏流程；
- Local/Remote 业务 IPC 仍正确；
- 空 URL、错误、loading、回车提交；
- 页面继续使用正式 Blora 2.0，禁止 1.x API；
- 960x700 首屏不需要滚动即可看到主要入口；
- 600x700 无横向溢出。

运行：

```bash
npm test
npm run syntax
npm run build
```

必须实际启动正式 Electron main 流程，生成并读取：

- `.hermes/screenshots/oobe-960x700.png`
- `.hermes/screenshots/oobe-600x700.png`

截图必须确认：

- 首屏简洁；
- 两个入口清晰；
- 无复杂重复信息；
- 无白屏、bridge 错误、裁切或横向溢出；
- Remote 第二步可正常显示输入框和返回操作。

禁止触碰父项目生产服务 `20003`、Show `20004` 或生产配置。

## 提交

只有测试和实际截图都通过后才能 commit。只 commit 不 push。输出修改文件、简化后的流程、测试结果、截图实际检查结果、本地 commit hash 和未验证事项。50 轮不足时先提交已验证阶段，下一轮继续，不要 reset。
