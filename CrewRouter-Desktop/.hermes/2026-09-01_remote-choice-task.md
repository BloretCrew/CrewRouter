# CrewRouter Desktop 远程连接方式选择改造

> 给 Grok：在 `/data/CrewRouter/CrewRouter-Desktop` 完成远程连接 OOBE 改造。使用 `bloret-router`，只 commit 不 push。先审查当前真实代码、截图和未提交修改，不要 reset 或破坏已完成的功能。

## 用户最终确认的交互

点击首屏“连接服务器”后，不应直接显示服务器地址输入框。应先给出两种远程连接方式：

```text
连接服务器

[通过官方站连接]
打开 https://crewrouter.bloret.net
由官方 Demo 负责转向，目标服务器负责登录

[输入服务器地址]
自己填写服务器地址
仍然通过官方 Demo 转向
```

完整流程：

```text
首屏
├── 本地使用
└── 连接服务器
      ├── 通过官方站连接
      │     └── 打开 crewrouter.bloret.net，由其负责转向
      └── 输入服务器地址
            └── 填写目标地址，再通过官方 Demo 转向
```

## 具体要求

### 1. Remote 方法选择页

点击首屏“连接服务器”后显示一个简洁的远程方法选择页面，只包含：

- 返回按钮；
- “通过官方站连接”按钮/卡片；
- “输入服务器地址”按钮/卡片；
- 简短说明：Personal/Team 由目标服务器自动识别，登录由目标服务器负责。

不要在这一页显示 URL 输入框。不要让用户手动选择 Personal/Team。

### 2. 官方站连接

- 默认官方站地址为 `https://crewrouter.bloret.net`，但通过配置项覆盖（如 `CREWROUTER_DEMO_URL`）；
- 通过官方站连接时，只打开官方 Demo 的转向入口；
- 官方 Demo 只负责转向，不负责认证、Token 交换、API Key 保存或 AI 请求代理；
- 如果当前没有真实 Demo 转向 endpoint，必须按现有安全逻辑明确提示配置缺失/等待回调，不能编造接口，也不能静默直连目标服务器；
- 不把 token/API key 放进 URL。

### 3. 自定义服务器地址

- 点击“输入服务器地址”后，才进入地址填写页面；
- 显示 URL 输入框、连接按钮和返回按钮；
- 提交后仍然通过官方 Demo 转向，不允许绕过；
- 目标服务器的 Personal/Team 和登录方式由服务端处理；
- 继续执行 http/https、私网、凭据、危险协议等 URL policy。

### 4. 状态和可访问性

- 三个页面状态要清楚：首屏、远程方法选择、远程地址填写；
- loading/error/等待转向回调使用单一状态区域，不造成布局跳动；
- 保持 label、aria、键盘回车、焦点管理和重复点击保护；
- 保持正式 Blora Design 2.0：官方 card/button/input/token，不能退回自写 fallback 或 1.x API；
- 继续使用 SF Symbols 图标，不引入 Lucide。

### 5. 业务不可回归

- Local：完整 CrewRouter personal server、`desktop-local`、免登录、`demo=false`、保留上报；
- Remote：官方站转向和自定义地址都不直接绕过 Demo；
- 保持 preload、IPC、单实例、导航白名单、URL policy；
- 不修改父项目生产服务和配置。

## 要修改的文件

按实际需要修改：

- `src/renderer/index.html`
- `src/renderer/renderer.js`
- `src/renderer/styles.css`
- `src/main.js`
- `src/preload.js`（仅必要时）
- `src/redirect-flow.js`
- `test/*.test.js`
- `README.md` / `docs/remote-redirect.md`

## 测试要求

新增/修改测试覆盖：

- 首屏点击连接服务器进入方法选择页，而不是直接显示 URL 输入；
- 方法选择页含“通过官方站连接”和“输入服务器地址”；
- 官方站默认地址与配置覆盖；
- 自定义地址只在第二步出现；
- 两种远程方式都经过 Demo redirect flow；
- 缺少 Demo 配置时明确失败，不直连；
- URL policy、state、防重放、无凭据 URL；
- 返回流程和键盘交互；
- 现有所有测试不回归。

运行：

```bash
npm test
npm run syntax
npm run build
```

必须使用正式 Electron main 流程实际截图并读取：

- `.hermes/screenshots/remote-methods-960x700.png`
- `.hermes/screenshots/remote-custom-960x700.png`

确认方法选择页确实有两个远程入口，且自定义地址只在下一步显示。截图不能只检查文件存在。

## 提交

完成测试和真实截图验收后只 commit 不 push。输出修改文件、实际交互流程、测试输出、截图检查结果、本地 commit hash 和未验证事项。50 轮不足时先提交已验证阶段，下一轮继续，不要 reset。