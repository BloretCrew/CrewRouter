# CrewRouter Desktop

Electron shell，复用 CrewRouter Web UI。Local 模式启动真正的 CrewRouter Server，Remote 模式直接承载 Personal/Team Server 页面。

## 开发

```bash
npm install
CREWROUTER_SERVER_ROOT=/path/to/CrewRouter npm start
```

Local 模式使用动态回环端口、独立 `userData` 日志，并通过 `/api/version` 与 `/api/instance` 等待服务就绪。服务端仍需要 PostgreSQL；Desktop 不修改父项目配置，也不会触碰生产端口。可通过 `CREWROUTER_SERVER_ROOT` 指向父项目，打包后则从 `resources/server` 查找 staged release。

## Remote 与 Demo 转向

在连接页输入 `http(s)` 地址。Desktop 请求 `/api/instance` 自动识别 `personal` 或 `team`，edition/capabilities 以服务器为权威。远程页面自身负责登录，Desktop 不伪造 OAuth、不交换或保存 Token/API Key。

可选地设置 `CREWROUTER_DEMO_URL` 并由外部入口发起 `crewrouter://connect?serverUrl=https%3A%2F%2F...` 转向。Desktop 仅校验协议和目标地址；不接受凭据 URL。生产远程目标禁止本机/内网地址，开发 localhost 需显式使用连接页并自行调整实现策略。

## 打包与交付

```bash
npm run stage:server -- /path/to/release
npm run pack
```

`stage-server.js` 只复制父项目 release 产物，明确排除 `node_modules`、`.env` 和 git 数据；正式发布包需要预先提供服务端运行依赖与 PostgreSQL。当前配置提供 Linux AppImage，可运行构建环境；Windows NSIS、macOS DMG 及 `crewrouter` 协议注册资源路径已预留，尚未在本机交叉验证。不要把密钥写入仓库或命令行 URL。

## 安全边界

BrowserWindow 使用 `contextIsolation: true`、`nodeIntegration: false`、sandbox；preload 只暴露状态、模式、连接、外部打开、重启和退出 IPC。导航仅允许当前目标 origin；其他链接交给系统浏览器。单实例启动时，第二次进程的协议参数会转交首实例。
