# Remote 转向协议

## 真实协议结论

当前 CrewRouter 服务端确实实现了自有 OAuth，但它不是 Demo 转向协议：

- `GET /oauth/authorize`
- `GET /oauth/authorize/info`
- `POST /oauth/authorize/approve`
- `POST /oauth/token`
- `GET /.well-known/oauth-authorization-server`

CrewRouterHelper 的登录流程使用 `client_id=crewrouter-helper`、`scope=events:report`、PKCE `S256`，授权入口为目标服务器的 `/oauth/authorize`，回调为 `http://127.0.0.1:<动态端口>/callback`，再由 Helper 将授权码提交到目标服务器 `/oauth/token`。Desktop 不复制这套 token 交换，也不保存 Helper 凭据。

服务端 `demo: true` 分支当前不挂载 `/oauth/*`，源码中也没有 Desktop 的 `/connect` 或 Demo redirect endpoint。因此 Desktop 不能声称 Demo 提供了 OAuth 或转向 API。

## Desktop 实际流程

1. 用户输入目标服务器地址。
2. Desktop 通过 `url-policy` 校验目标地址，并请求目标已有的 `GET /api/instance` 读取 runtime、edition 和认证能力。
3. Desktop 校验 `CREWROUTER_DEMO_URL`，生成内存中的一次性短期 `state`，并将目标地址绑定到 state。
4. Desktop 通过系统浏览器打开配置的官方 Demo URL。Demo URL 只作为外部转向入口；若官方 Demo 尚未配套处理该参数，Desktop 会诚实地停留在等待回调状态，不会绕过 Demo 直连。
5. 受支持的 Desktop 回调使用 `crewrouter://connect/?state=...&serverUrl=...` 或 `crewrouter://oauth/callback?state=...&serverUrl=...`。Desktop 校验 state、目标 origin 和 URL policy，然后加载目标服务器 Web UI。
6. 目标服务器负责自己的登录。Personal Server 显示 Passport，Team Server 保持服务端现有的密码/飞书认证能力。

回调不得携带 `code`、access token、refresh token、API key 或其他凭据；这些内容既不放入 URL，也不写入 profile 或普通日志。目标地址只保存为连接 metadata。

## 配置与兼容边界

配置官方 Demo 地址：

```bash
CREWROUTER_DEMO_URL=https://<官方 Demo 的真实转向入口> npm start
```

当前仓库未发现服务端 Demo 转向 endpoint，不能编造路径。若部署的官方 Demo 还没有实现 `state`/`serverUrl` 到 Desktop 回调的转向配套，应将其视为服务端配套缺口；Desktop 不会静默改为直接连接目标服务器。目标服务器暂不支持 Desktop callback 时，兼容行为只能是通过 Demo 转向后打开目标服务器网页，由用户在目标服务器网页完成登录，不能伪称 Desktop 已完成 OAuth。

回调 state 默认 10 分钟有效、成功或失败消费一次，未知、过期和重放均拒绝。生产目标和 Demo 地址均禁止危险协议、凭据、敏感 query、localhost 及解析到内网的域名；开发环境如需本地地址必须显式启用现有 localhost 策略。
