# CrewRouter Desktop

Electron 壳，复用 CrewRouter Web UI。Local 模式在本机启动真正的 CrewRouter Server（含内置 PostgreSQL），Remote 模式通过官方站选择实例或直接输入服务器地址，页面本身由目标 CrewRouter 提供。

## 结构

```
src/main.js                 仅在 Electron 主进程中调用 createApp().bootstrap()
src/app/create-app.js       组装状态模型、连接管理、窗口、IPC、官方站登录、菜单；接受注入的 electron 便于测试
src/app/state.js            单一状态模型：idle | starting-local | connecting | awaiting-official-login | connected | error
src/app/ipc.js              IPC 信任分级（launcher / localConsole / remoteConsole）与允许矩阵
src/app/window.js           主窗口、导航白名单、加载失败回退
src/app/official-login.js   官方站登录：PKCE + 回环回调 + TTL + 取消，成功后进入 ConnectionManager
src/app/menu.js             最小应用菜单（返回启动页 / 打开日志目录 / 退出）
src/server-manager.js       本地 Server 生命周期：隔离配置、动态端口、健康检查、进度/退出事件、本地 token
src/postgres/               PostgreSQL provider：embedded-postgres（跨平台内置）或 Linux root 的系统 postgres 兜底
src/connection-manager.js   /api/instance 校验与 profile 元数据
src/profile-store.js        profiles.json（非敏感元数据 + 偏好）
src/url-policy.js           远程 URL 策略：仅 http/https、禁止内网/凭据、DNS 解析校验
src/preload.js              唯一 preload，暴露 window.crewrouterDesktop
src/renderer/               启动页（OOBE + 已保存连接 + 设置），仅使用 Blora 2.0 官方组件
```

## 启动页与状态

启动页只根据主进程推送的状态快照渲染：

| 状态 | 启动页 |
|---|---|
| `idle` | 欢迎页。有已保存连接时先显示“已保存的连接”列表（连接 / 重命名 / 删除），下方是“本地使用”与“连接服务器” |
| `starting-local` / `connecting` | 进度面板（准备数据库 → 启动服务 → 检查就绪 → 打开页面），可取消 |
| `awaiting-official-login` | “请在浏览器中继续”，可重新打开链接或取消；5 分钟未回调自动超时 |
| `error` | `blora-result` 错误说明 + 重试 / 查看日志 / 返回；重试信息由主进程携带 |
| `connected` | 主窗口已切换到目标 CrewRouter 页面 |

设置面板合并在启动页内（偏好、本地服务状态与重启/停止、诊断复制、重启/退出应用）。本地控制台的“CrewRouter Desktop 设置”卡片显示同样的内容；远程实例页面只能看到当前连接、返回启动页和重启/退出，不能读取其他已保存连接。

## 本地模式

- `LocalServerManager` 在 `app.getPath('userData')` 下生成隔离的 `runtime/config.json`、数据与日志目录，清理继承的 `CR_*` / `PG*` / `DATABASE_URL` 环境变量，只监听 `127.0.0.1` 的动态端口，退出时只停止自己持有的子进程。
- PostgreSQL 由 `src/postgres` 提供：优先 `embedded-postgres`（数据目录 `userData/postgres/data`，随机密码写入 `userData/runtime/postgres.json`）；在 Linux root 且存在 `postgres` 系统用户时退回 `runuser` 方案（仅开发容器）。可用 `CREWROUTER_POSTGRES_PROVIDER=embedded|system` 强制选择。
- 每次启动生成一次性 `CR_LOCAL_TOKEN`，主进程用 `session.webRequest` 为本地 origin 附加 `x-crewrouter-desktop-token`；服务端 desktop-local 中间件只为携带该 token 的回环请求建立免登录会话，本机其他进程无法冒用。
- 就绪检查依次验证 `/api/version`、`/api/setup/status`、`/api/instance`，并要求 `runtime=desktop-local`、`edition=personal`、`auth={required:false,methods:['local']}`、`demo=false`。
- 本地服务意外退出时回到启动页并提示重启；返回启动页不会停止本地服务，再次选择本地使用会直接复用。

## 远程模式

- **官方站**：Desktop 打开 `https://crewrouter.bloret.net/store?helper_login=1&...`（PKCE S256，回调 `http://127.0.0.1:<动态端口>/callback`）。用户在官方站选择登录过的实例并完成授权后，Desktop 用授权码向目标实例 `POST /oauth/desktop-session` 交换 Web Session Cookie，写入 Electron session 后通过 `ConnectionManager` 保存 profile 并打开页面。回调 nonce 不匹配时拒绝但不中断等待；可用 `CREWROUTER_DEMO_URL` 覆盖官方站地址。
- **自定义地址**：经 `url-policy` 校验后读取 `/api/instance`，登录由目标服务器页面完成。
- `crewrouter://connect?serverUrl=...` 深链只在启动页预填地址，不会自动连接。

## 安全边界

`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；导航只允许启动页文件与当前目标 origin，其他链接交给系统浏览器（同样经过 URL 策略）。IPC 按调用帧分级：启动页可调用全部；本地控制台可管理 profile/偏好/本地服务；远程控制台只能读取裁剪后的状态、返回启动页、重启/退出。

## 开发与验证

```bash
npm install
npm test                      # 行为测试：状态模型、IPC 矩阵、官方站登录、窗口、主进程编排、LocalServerManager
npm run syntax                # node --check 遍历 src/scripts/test
CREWROUTER_SERVER_ROOT=/path/to/CrewRouter npm run test:local-server   # 真实 Server + PostgreSQL provider，校验 token 门禁与进度事件
npm run test:electron:local-username   # xvfb 下的 Electron 验收：OOBE → 本地控制台 → 内嵌设置 → 启动页设置面板，截图到 ../.hermes/screenshots
npm run build                 # stage server + Linux AppImage
```

开发运行：`CREWROUTER_SERVER_ROOT=/path/to/CrewRouter npm start`（未设置时使用 `staging/server`）。

## 打包

`npm run stage:server` 只复制父项目 release 产物（排除 `node_modules`、`.env`、git 数据），`validate:server-bundle` 检查 bundle 与当前平台的 PostgreSQL 二进制。`embedded-postgres` 及其平台包通过 `asarUnpack` 解压，Windows/macOS 打包需要在各自平台运行以获得对应二进制。
