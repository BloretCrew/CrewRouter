# CrewRouter Desktop 远程连接改为官方 Demo 转向任务书

> 给 Grok：在 `/data/CrewRouter/CrewRouter-Desktop` 完成本任务。使用 `bloret-router`，只 commit 不 push。先审查当前真实代码和测试，不要 reset、不要破坏已完成的 Local/Remote、Blora、bridge 和安全逻辑。

## 用户最终要求

用户要的不是重新设计一套 Desktop 登录系统，也不是让 Desktop 直接打开目标服务器然后在 WebView 里自行处理登录。用户只需要：

```text
Desktop
  → 官方 Demo（demo:true）
  → 官方 Demo 只负责转向
  → 目标 CrewRouter Server
  → 使用目标服务器/Helper 现有登录方式
```

官方 Demo 站的职责仅是转向，不负责：认证、Token 交换、API Key 保存、AI 请求代理、服务器数据库、统一账号中心。

Desktop 也不负责实现 Passport/密码/飞书登录，不接管远程 Token，不把 token/API key 放入 URL。目标 CrewRouter Server 自己处理登录；登录方式与 CrewRouterHelper 使用的目标服务器 OAuth/登录流程保持一致。

## 当前已知代码

- `src/main.js` 的 `connect(url)` 当前直接请求目标 `/api/instance`，然后 `BrowserWindow.loadURL(target origin)`。
- `src/main.js` 的 `DEMO_URL` 目前仅在启动时可选打开 `redirectFlow.buildDemoUrl()`，不是用户点击 Remote 时的正式转向流程。
- `src/redirect-flow.js` 已有 state、一次性消费、回调解析、Demo URL 生成，但需要按真实协议补齐。
- `src/connection-manager.js` 当前会先请求目标 `/api/instance`，Remote 转向流程不能因此绕过 Demo 或把目标类型硬编码。
- `src/renderer/renderer.js` 的 Remote 提交目前调用 `api.connectRemote(url)`。
- `src/preload.js` 只有最小 IPC，不能开放 Node 能力。
- CrewRouterHelper 的现有 OAuth 流程在 `/data/CrewRouter/CrewRouterHelper/cr-report.py` 的 `cmd_login`：目标 URL `/oauth/authorize`，PKCE，随机 state，本机回调，随后目标 URL `/oauth/token` 换取凭据；Helper 认证凭据主要用于 API 上报。

## 实现目标

### Remote 点击流程

远程输入或选择目标服务器后：

1. Desktop 生成一次性短期 state，并保存目标服务器信息（仅内存，不泄露）；
2. Desktop 打开官方 Demo URL 的转向入口；
3. Demo 只返回 302/转向到目标 CrewRouter 的授权/登录入口，或按既有 Helper 规则将请求转给目标；
4. 目标服务器自身展示正确登录方式：Personal Server 仅 Passport，Team Server 保持现有两种方式；
5. 目标服务器完成登录后通过 `crewrouter://oauth/callback` 或 localhost callback 回到 Desktop；
6. Desktop 只验证 state、目标 origin 和服务器 `/api/instance` metadata，然后加载目标 Web UI；
7. 如果目标服务器暂时不支持 Desktop callback，必须实现一个诚实的兼容路径：通过 Demo 转向后打开目标服务器网页，用户在目标网页登录；不能伪称 Desktop 已完成 OAuth。

必须先从现有官方 Demo/服务端路由代码确认实际可用的转向 URL/参数。不能编造不存在的 `/connect` 接口。若 Demo 转向接口尚未在服务端实现，不要偷偷改生产服务；可以在 Desktop 实现可配置模板并在文档中标注服务端配套缺口，或只实现目标服务器已有的 Helper-compatible authorization URL。

### 官方 Demo 边界

- Demo URL 必须配置化，例如 `CREWROUTER_DEMO_URL` 或 profile 配置；不写死秘密。
- 不允许任意开放重定向：目标 URL 必须经过已有 `url-policy`；Demo 地址自身也必须是允许的 http/https origin。
- 禁止把 access token、refresh token、API key 放在 query、fragment、普通日志或 profile JSON。
- state 必须一次性、短时效、绑定目标/回调和客户端流程，重放拒绝。
- 外部 Demo/认证页面通过 `openExternal` 或明确的安全导航白名单打开；不允许任意页面获得 preload/Node 能力。
- 认证页面可能需要系统浏览器而非应用 WebView；按现有安全设计选择，并文档化。

### Helper 兼容边界

- 复用 Helper 已验证的 PKCE 参数语义、OAuth endpoint 命名和 Personal/Team 认证入口语义；不要直接复制 Helper 的 API Key 或事件上报凭据到 Desktop。
- 如果目标服务器的 OAuth 协议当前只支持 Helper 的本机 callback，增加 Desktop 自定义协议/localhost callback 的兼容适配，但保持服务端授权语义不变。
- Desktop 的 profile 只保存非敏感连接 metadata；若必须保存 token，使用安全系统存储，但本任务优先采用目标网页 cookie/目标端授权，不保存 token。

## 需要修改的区域

- `src/main.js`：Remote IPC 和协议回调流程；保持 Local 分支不变。
- `src/redirect-flow.js`：补齐 Demo redirect URL 构造、目标绑定、state metadata、callback 解析和一次性消费。
- `src/connection-manager.js`：区分“探测 metadata”和“开始远程转向”，不要在转向前泄露凭据。
- `src/preload.js`：如需新增 IPC，只增加最小方法。
- `src/renderer/renderer.js` / `src/renderer/index.html`：Remote 文案准确表达“通过官方入口连接/目标服务器负责登录”，显示转向状态和失败原因。
- `src/url-policy.js`：如需扩展验证，保持禁止私网/危险协议；开发 localhost 必须显式开启。
- `test/*.test.js`：补齐测试。
- `README.md`、`docs/remote-redirect.md`：说明流程和 Demo 的职责边界。

## 测试要求

至少覆盖：

- Remote 点击会进入 Demo redirect flow，而不是直接绕过 Demo；
- Demo URL 配置缺失时给出清晰错误，不静默直连；如保留显式兼容直连，必须由用户/开发配置开启并单测；
- state 生成、目标绑定、过期、一次性消费和重放拒绝；
- 目标服务器 URL、Demo URL、callback URL 的安全策略；
- Personal metadata 显示 Passport；Team metadata 显示现有两种认证；Desktop Local 不受影响；
- token/API key 不进入 URL、日志或 profile；
- 自定义协议 callback 和 localhost callback；
- 目标服务器登录失败/取消/无 callback 时明确提示；
- 现有全部测试保持通过。

运行：

```bash
npm test
npm run syntax
npm run build
```

如果需要真实服务验证，必须使用隔离临时服务/临时端口，禁止触碰父项目生产 `20003`、Show `20004` 和生产配置。不要为了验证修改官方 Demo 生产站。

## 交付要求

- 先给出真实研究结论：当前官方 Demo/目标服务端是否已有可用转向入口；Helper 的实际 OAuth endpoint 和 callback 语义；
- 不存在的服务端接口不能伪造；如需服务端配套，明确列为阻塞；
- 只 commit 不 push；
- 输出修改文件、实际转向流程、测试结果、未验证的真实登录/E2E 边界和 commit hash；
- 50 轮不足时先 commit 已验证阶段，下一轮继续，不要 reset。
