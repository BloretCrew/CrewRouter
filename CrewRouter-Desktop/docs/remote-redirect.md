# 远程连接与官方站登录

## 官方站登录（Remote → 官方站）

1. 启动页选择“通过官方站连接”，主进程创建 `nonce`、PKCE `code_verifier` / `code_challenge`（S256），并在 `127.0.0.1` 的动态端口启动一次性回调服务器。
2. 用系统浏览器打开 `${CREWROUTER_DEMO_URL 或 https://crewrouter.bloret.net}/store?helper_login=1&state=<nonce>&redirect_uri=http://127.0.0.1:<port>/callback&client_id=crewrouter-desktop&scope=events:report&code_challenge=...&code_challenge_method=S256`。
3. 官方站列出该访问者登录过的 CrewRouter；用户选择后跳到目标实例 `/oauth/authorize`，授权完成后回调 `redirect_uri?code=...&state=<base64url({nonce, router_url})>`。
4. 回调校验：仅 `GET /callback`、`state.nonce` 必须等于本次 nonce、必须有 `code`、`router_url` 必须通过 URL 策略。无效回调返回 400，等待继续；有效回调关闭回调服务器。
5. Desktop 向 `router_url/oauth/desktop-session` POST `code + client_id + code_verifier`，取回 Web Session Cookie 并写入 Electron session（`httpOnly`，https 时 `secure`）。
6. 通过 `ConnectionManager.connect()` 读取 `/api/instance`、保存 profile（仅非敏感元数据）并打开目标页面。失败时进入 `error` 状态并可重试。
7. 等待超过 5 分钟自动失败；用户可随时取消或重新打开浏览器链接。

Desktop 不保存授权码、Token 或 API Key；Cookie 由 Electron session 持久化，与浏览器登录等价。

## 自定义地址

输入 `http(s)` 地址后经 `url-policy` 校验（仅 http/https、禁止凭据/fragment/敏感 query、禁止 localhost 与内网、DNS 解析到内网也拒绝），再读取 `/api/instance` 校验 runtime/edition/auth，成功后保存 profile 并打开页面。登录由目标服务器负责。

## 深链

`crewrouter://connect?serverUrl=https://...` 只会打开启动页并预填“输入服务器地址”表单，需要用户确认后才连接。旧版基于 state 的 Demo 转向流程已移除。
