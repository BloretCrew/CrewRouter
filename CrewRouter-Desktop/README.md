# CrewRouter Desktop

Electron shell，复用 CrewRouter Web UI。Local 模式启动真正的 CrewRouter Server，Remote 模式直接承载 Personal/Team Server 页面。

## 开发

```bash
npm install
CREWROUTER_SERVER_ROOT=/path/to/CrewRouter npm start
```

Local 模式使用 `LocalServerManager` 在 `app.getPath('userData')` 下创建隔离的 runtime/config、data、logs，清理继承的 CR 配置/数据库环境变量并选择动态回环端口；退出时只停止本实例持有的子进程。服务端仍需要 PostgreSQL；Desktop 不修改父项目配置，也不会触碰生产端口。可通过 `CREWROUTER_SERVER_ROOT` 指向父项目，打包后则从 `resources/server` 查找 staged release。就绪检查依次验证 `/api/version`、`/api/setup/status` 和 `/api/instance`。

## Remote 与 Demo 转向

在连接页输入 `http(s)` 地址。Desktop 请求 `/api/instance` 自动识别 `personal` 或 `team`，edition/capabilities 以服务器为权威。远程页面自身负责登录，Desktop 不伪造 OAuth、不交换或保存 Token/API Key。

可选地设置 `CREWROUTER_DEMO_URL`，应用会生成带一次性、短时效 state 的转向地址；外部 `crewrouter://connect` 或 `crewrouter://oauth/callback` 回调必须携带由当前进程创建的 state，缺失、过期、未知和重放都会拒绝。Desktop 仅校验有限格式和目标地址；不接受凭据或敏感 query。生产远程目标统一经过 `url-policy` 的 DNS/内网校验。

## 验证

安装依赖后，按以下顺序运行：

```bash
npm test
npm run syntax
npm run test:local-server
npm run build
```

`npm test` 覆盖 URL policy、RedirectFlow、ProfileStore、ConnectionManager、LocalServerManager，以及无需 Electron 的主进程入口。`test:local-server` 需要父项目依赖、PostgreSQL 和 `CREWROUTER_SERVER_ROOT=/data/CrewRouter`，会使用临时 userData、动态非生产端口并在结束时停止服务。未安装依赖时 `npm run build` 会因缺少 `electron-builder` 失败；当前环境未进行 Electron GUI/E2E 或跨平台打包验证。

## 打包与交付

```bash
npm run stage:server -- /path/to/release
npm run pack
```

`stage-server.js` 只复制父项目 release 产物，明确排除 `node_modules`、`.env` 和 git 数据；正式发布包需要预先提供服务端运行依赖与 PostgreSQL。当前配置提供 Linux AppImage，可运行构建环境；Windows NSIS、macOS DMG 及 `crewrouter` 协议注册资源路径已预留，尚未在本机交叉验证。不要把密钥写入仓库或命令行 URL。

## 安全边界

BrowserWindow 使用 `contextIsolation: true`、`nodeIntegration: false`、sandbox；preload 只暴露状态、模式、连接、外部打开、重启和退出 IPC。导航仅允许当前目标 origin；其他链接交给系统浏览器。单实例启动时，第二次进程的协议参数会转交首实例。
