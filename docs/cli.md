# CrewRouter CLI (`cr`)

CrewRouter CLI 是 GPL-3.0 终端客户端，包含非交互式命令和全屏 TUI。独立 npm Beta 包已发布到 `beta` 标签：

```bash
npm install -g @bloret-crew/crewrouter@beta
cr --help
```

本仓库源码可通过根目录 `npm link` 激活 `cr`。Standalone npm CLI 只包含客户端程序；本机 `start` / `serve` 需要另行安装兼容的 CrewRouter Server。

## 源码开发

在仓库根目录执行 `npm link`，可在源码开发时同时创建 `cr` 和 `crewrouter` 两个入口。Standalone npm CLI 只包含 CLI 客户端，不嵌入 CrewRouter Server；其本机 `start` / `serve` 需另行安装 compatible 的 CrewRouter Server。

## 首次使用

### 连接远程实例

```bash
cr connect https://router.example.com
cr login
```

`cr connect` 会保存 profile，并校验 `/api/instance`。`cr login` 支持：

- 用户名/邮箱 + 密码（可用 `--password-stdin` 从管道读取，不会保存密码）；
- TOTP 2FA；
- API Key 登录（`cr login --api-key-stdin`）。

登录成功后只保存会话 Cookie/CSRF 或 API Key，文件权限为 `0600`；不会保存密码或 TOTP 密钥。

### 从本机启动服务

本机服务依赖 PostgreSQL，需要已有 `config.json` 或 `CR_DB_*` 环境变量：

```bash
cp config.example.json config.json   # 填写 database
cr start
cr status
```

默认只绑定 `127.0.0.1:20003`，不会暴露到所有网卡。`cr start` 会写 PID/日志状态，`cr stop` 在停止前校验进程归属。

开发环境可用 `cr start --demo` 无数据库试用；已有服务会校验健康状态并复用，`cr serve` 在前台运行。

## 命令

```text
cr status [--json]
cr connect <URL> [--name NAME]
cr login [--url URL] [--username U] [--password-stdin|--api-key-stdin]
cr logout
cr profiles [--json]
cr use <NAME>

cr start [--port N] [--config PATH] [--demo]
cr stop [--force]
cr restart [--force]
cr logs [--lines N] [-f]
cr serve [--port N] [--config PATH] [--demo]

cr overview [--days N] [--json]
cr providers [--json]
cr providers ping <ID>
cr providers toggle <ID> --enabled|--disabled
cr models [--search Q] [--json]
cr models test <ID>
cr keys list|create|enable|disable|rename|delete|config ...
cr usage [--days N] [--json]
cr sessions [--days N] [--page N] [--json]
cr sessions messages <KEY> [--page N] [--json]

cr doctor [--json]
cr version
cr help
```

读命令支持 `--json`，输出 `{"ok":true,"profile":"...","data":...}`；错误写 stderr，退出码：`1` API/网络错误、`2` 参数错误、`3` 未登录/权限不足、`4` 本地服务错误。

## 认证与权限

- 密码登录使用 `POST /auth/login`，2FA 使用 `POST /auth/login/2fa`；登录会重建会话，CLI 会自动刷新 CSRF token。
- API Key 通过 `x-api-key` 发送，跳过 CSRF。默认 Key 只有 gateway 权限，管理命令可能需要 `keys.read`、`usage.read`、`models.read`、`providers.read` 等权限。
- API Key 模式无法调用 `/auth/me`；CLI 用 `/api/user/balance` 验证，并通过 `/api/admin/providers` 的 200/403 结果推断管理员身份，因此管理员状态可能是“未知”。
- Personal/Desktop Local 实例可能禁用密码登录；此时使用 API Key，或先在浏览器登录。
- OAuth `crh_...` token 只适用于 gateway/client-events，不能用于管理接口。
- 远程管理请使用 HTTPS；HTTP 仅建议用于本机或受信内网测试，密码和会话 Cookie 在 HTTP 下不会被加密。

## 配置与凭证

默认目录（可用 `CR_CLI_HOME` 覆盖）：

```text
~/.config/crewrouter/
├── cli.json          # profiles、当前 profile、TUI 设置（无 secret）
├── sessions.json     # Cookie/CSRF 或 API Key（0600）
├── service.json      # cr 启动的本机服务 PID/端口/日志（0600）
└── logs/             # 本机服务日志（0600）
```

相关环境变量：

```text
CR_CLI_HOME
CREWROUTER_URL / CR_URL
CREWROUTER_API_KEY / CR_API_KEY
CR_CONFIG_PATH
CR_THEME / CR_PALETTE / CR_COLOR_SCHEME
```

仅日志命令可使用 `-f` 跟随；删除/变更命令默认需要 `--yes`。全屏 TUI 支持键盘、方向键、鼠标、`q` 退出；非 TTY 默认退化为 JSON 状态查询。

## 版本

CLI 预发布版本使用年号版本 **27.0 Beta**。独立 npm 包 `@bloret-crew/crewrouter@27.0.0-beta.1` 已发布到 `beta` 标签，可执行 `npm install -g @bloret-crew/crewrouter@beta`。
