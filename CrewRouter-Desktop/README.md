# CrewRouter Desktop

Electron shell，复用 CrewRouter Web UI。Local 模式启动真正的 CrewRouter Server，Remote 模式先进入已配置的官方 Demo 转向入口，再承载目标 Personal/Team Server 页面。

## Blora Design 2.0

启动连接页正式使用 `@bloret-crew/blora-design@2.0.8` 的发布 CSS、token 和组件样式。页面使用官方 `.blora-button`、`.blora-card`、`.blora-badge`、`.blora-input` 结构与 `data-variant`，页面专用 CSS 只负责布局，不复制官方 token 或组件实现。没有使用 Blora 1.x 的 `blora-btn`、`Blora.init()` 或 UMD 脚本。SF Symbols 图标优先使用远程图标地址，图标不可用时仍由本地字符 fallback 保证核心界面可用。详见 [`docs/blora-integration.md`](docs/blora-integration.md)。



## 开发

```bash
npm install
# 可选：指向父项目；未设置时使用仓库内 staging/server
CREWROUTER_SERVER_ROOT=/path/to/CrewRouter npm start
```

Local 模式使用 `LocalServerManager` 在 `app.getPath('userData')` 下创建隔离的 runtime/config、data、logs，启动完整 CrewRouter Server（不是 demo/mock），明确使用 `runtime=desktop-local`、`edition=personal` 和 `auth.required=false` 的本地身份，因此不需要用户交互登录。服务端仍保留 login-report 和 stats-report 模块及其启用配置；这表示实例上报逻辑不因免登录而关闭，不会伪造用户登录事件。服务只监听 `127.0.0.1`，清理继承的 CR 配置/数据库环境变量并选择动态回环端口；退出时只停止本实例持有的子进程。服务端仍需要 PostgreSQL；Desktop 不修改父项目配置，也不会触碰生产端口。可通过 `CREWROUTER_SERVER_ROOT` 指向父项目，打包后则从 `resources/server` 查找 staged release。就绪检查依次验证 `/api/version`、`/api/setup/status` 和 `/api/instance`。

## Remote 与 Demo 转向

在连接页输入 `http(s)` 地址。Desktop 请求 `/api/instance` 读取服务器权威的 runtime、edition 和认证能力：Personal Server 仅 Passport，Team Server 保持密码与飞书两种方式。远程页面自身负责登录，Desktop 不硬编码登录界面、不伪造 OAuth、不交换或保存 Token/API Key；Local 仅使用本实例的本地免交互认证。

设置 `CREWROUTER_DEMO_URL` 后，Remote 点击会先读取目标 `/api/instance`，再生成绑定目标的一次性、短时效 state，并通过系统浏览器打开已配置的官方 Demo 转向入口。当前仓库未发现服务端 Demo redirect endpoint，因此不能编造 `/connect` 接口；Desktop 不会在 Demo 配置缺失时静默直连。受支持的 `crewrouter://connect/` 或 `crewrouter://oauth/callback` 回调必须携带当前进程创建的 state，缺失、过期、未知和重放都会拒绝。Desktop 仅校验目标 origin 和 URL policy，不接受 code、Token、API Key 或其他敏感参数。目标服务器负责自己的登录：Personal 使用 Passport，Team 保持服务端现有认证方式。详细边界见 [`docs/remote-redirect.md`](docs/remote-redirect.md)。

## 验证

安装依赖后，按以下顺序运行：

```bash
npm test
npm run syntax
npm run test:local-server
npm run build
```

`npm test` 覆盖 URL policy、RedirectFlow、ProfileStore、ConnectionManager、LocalServerManager，以及无需 Electron 的主进程入口。`test:packaged-server` 使用仓库内 `staging/server`、临时 PostgreSQL、临时 userData 和动态非生产端口验证完整 Server，并在结束时停止服务；开发模式也可用 `CREWROUTER_SERVER_ROOT` 覆盖 staged fallback。正式 Electron 运行从 `resources/server` 查找 bundle。

## 打包与交付

```bash
npm run stage:server -- /path/to/release
npm run pack
```

`stage-server.js` 只复制父项目 release 产物，明确排除 `node_modules`、`.env` 和 git 数据；正式发布包需要预先提供服务端运行依赖与 PostgreSQL。当前配置提供 Linux AppImage，可运行构建环境；Windows NSIS、macOS DMG 及 `crewrouter` 协议注册资源路径已预留，尚未在本机交叉验证。不要把密钥写入仓库或命令行 URL。

## 安全边界

BrowserWindow 使用 `contextIsolation: true`、`nodeIntegration: false`、sandbox；preload 只暴露状态、模式、连接、外部打开、重启和退出 IPC。导航仅允许当前目标 origin；其他链接交给系统浏览器。单实例启动时，第二次进程的协议参数会转交首实例。
