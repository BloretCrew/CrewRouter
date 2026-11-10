# CrewRouter CLI (`cr`)

CrewRouter CLI 是零第三方依赖的终端客户端，包含非交互式命令和全屏 TUI。它既能连接已有的远程 CrewRouter，也能从本机启动同包的 CrewRouter Server。

激活命令为 `cr`：

```bash
# 在仓库根目录
npm link

# 或全局安装
npm install -g .

cr
```

`npm link` / `npm install -g` 会同时创建 `cr` 和 `crewrouter` 两个入口。

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

无数据库时可试用 Demo 模式：

```bash
cr start --demo --port 20123
cr
```

其他本地服务命令：

```bash
cr start --port 20103 --config ./config.json
cr restart
cr logs --lines 100
cr logs -f
cr serve                 # 前台运行，适合 systemd/容器
cr stop
```

服务首次启动若数据库尚未初始化，TUI 会提示打开 `http://127.0.0.1:<port>/setup` 完成初始化。

## TUI

直接执行 `cr`（或 `cr tui`）打开全屏 TUI。页面包括：

- 概览：连接、账户、余额、近期用量；
- 服务/连接：启动/停止/重启本机服务、查看日志、切换 profile；
- 供应商、模型、API Key、用量、会话、账户。

界面采用 Blora Agent 的终端视觉：留白画布、顶部面包屑与细分割线、终端至少 100×18 时显示 28 列抬高侧栏、底部状态行与快捷键行；正文用 `▸` 分节、统计值用珊瑚色强调，不再使用围满屏幕的粗边框。

弹窗按完整终端居中并清空背景，使用圆角边框和 macOS 风格红黄绿窗口控件：

- 红色：关闭当前弹窗；
- 黄色：最小化为标题栏，再次点击恢复；
- 绿色：全屏/还原；
- 选择项使用 `❯` 高亮和整行选中底色，输入/表单显示光标位置。

鼠标与键盘均可操作：

- 点击左侧页面、子页签、操作行、底部 `r 刷新` / `s 服务` / `q 退出`；
- 点击弹窗选项、字段、底部“确认/取消”文字，支持滚轮滚动；
- 键盘等价：`↑↓` 选择、`Tab` 切换区域、`←→` 子页、`Enter` 打开、`PgUp/PgDn` 滚动、`r` 刷新、`q` 退出；
- 退出 TUI 不会自动登出，只有账户页“退出登录”才清除本地会话。

配色沿用 Blora Design 的六套调色板（珊瑚、靛蓝、石墨、单色、电路、暮色），支持亮/暗/自动/无色：

```bash
CR_THEME=coral-dark cr
CR_THEME=indigo-light cr
CR_PALETTE=dusk CR_COLOR_SCHEME=dark cr
NO_COLOR=1 cr
```

也兼容 `BLORA_THEME` / `BLORA_COLOR_SCHEME`。

## 命令一览

```text
cr [tui]                         打开 TUI
cr status [--json]               连接/服务/登录状态
cr login [--url URL]             密码、2FA 或 API Key 登录
cr logout                        退出登录并删除本地凭证
cr connect <URL> [--name NAME]   添加/切换远程 profile
cr profiles [--json]             列出 profile
cr use <NAME>                    切换 profile

cr start / stop / restart        本地服务生命周期
cr logs [--lines N] [-f]         本地日志
cr serve                         前台运行本地服务

cr overview [--days N] [--json]
cr providers [--json]
cr providers ping <ID>
cr providers toggle <ID> --enabled|--disabled
cr models [--search Q] [--json]
cr models test <ID>
cr keys list
cr keys create <名称> [--expires-in H] [--model M]
cr keys enable|disable <ID>
cr keys rename <ID> <新名称>
cr keys delete <ID> --yes
cr keys config <ID>
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
CR_CLI_HOME          配置目录
CR_CONFIG_PATH       本地服务 config.json 路径
CREWROUTER_URL       默认服务器地址
CR_URL               同上
CREWROUTER_API_KEY   API Key（不落盘）
CR_API_KEY           同上
NO_COLOR             禁用颜色
```

## 故障排查

```bash
cr doctor
cr status --json
cr logs --lines 200
```

- `cr start` 报 PostgreSQL 配置缺失：填写 `config.json` 的 `database`，或设置 `CR_DB_*`；也可 `--demo` 试用。
- 端口被占用：换 `--port`；如果端口上已经有 CrewRouter，`cr start` 会复用而不会再启动一个。
- 管理命令 403：API Key 需要相应管理权限；优先使用密码会话登录。
- 本地 HTTPS 自签名证书：使用 `NODE_EXTRA_CA_CERTS` 指定 CA，CLI 不会关闭 TLS 校验。
- 鼠标不可用：使用键盘等价操作；所有点击区域都有键盘路径。
