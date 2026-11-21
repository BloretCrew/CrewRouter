# OpenCode Console Keyless Auth 与 CrewRouter 兼容性评估

日期：2026-11-22

## 结论

**最可能的目标是 CI/CD 工作负载通过 OIDC 使用 OpenCode Console 模型，而非本地 DSH 登录。** 你提供的 HTML 对这一场景提供了具体待核实假设：在 Console 建立 `NoKeys` Service Account / Trust Policy；GitHub Job 声明 `id-token: write`；CrewRouter 进程获取包含 repo/ref/workflow 等 claims 的 OIDC JWT；把 JWT 交给 Console federated endpoint，Console 校验 issuer/JWKS/audience/claims 后返回短期模型凭证。但这份 HTML 未给出 endpoint、audience 字符串或实际请求/响应样例，而且上述要素尚未从官方源码/文档交叉验证，须作为待证假设，而非实现契约。

需严格区分 OIDC assertion 与 inference credential：按附件假设，它们是两个阶段；但只有官方 flow/可运行样例才能确认最终 inference header 是 `Bearer <短期 credential>`、直接使用原 OIDC token，还是其他形式。公开的 [Inference API 文档](https://opencode.ai/docs/console/api/inference/) 当前只说明静态 API Key 通用路径，可能未覆盖新公告。

## 官方信息核查

- [OpenCode 官方 X 公告](https://x.com/opencode/status/2124037654639468759)：声明 Console 支持 keyless auth，可从 CI 或任意支持 OIDC 的环境调用模型，不再需要长期 API token。结合 CI 的表述，最符合的目标是 GitHub Actions 等短期工作负载身份，而不是本地桌面/CLI 登录。公告没有给出 OIDC token 兑换 API 或具体配置步骤。
- 本地 checkout 的 `opencode-console-cli` README 与 OpenCode Console 官方 DeepSeek Harness 集成页描述的是浏览器交互授权；发布 CLI 源码使用 device-code OAuth 和 `OPENCODE_API_KEY`。这说明它不是公告里 CI Keyless 的实现，不能再以该 CLI 未实现为依据断言 Keyless 未有实现。
- [Console Inference API 文档](https://opencode.ai/docs/console/api/inference/)：通用示例及认证章节要求请求以 `Authorization: Bearer <token>` 发送 personal/service-account API key；文档可能尚未更新到新 Keyless 公告，故只能证明通用 key 路径已公开，不能据此断定 keyless 不支持 inference。
- [Console API 总览](https://opencode.ai/docs/console/api/)：列出的凭证类型仍为 personal API key 与 service account key。
- [Console Harnesses 文档](https://opencode.ai/docs/console/harnesses/)：通用的其他 Harness 指南要求 Console API key；这和新公告的 CI Keyless 能力可能是不同配置/产品路径。
- [Console Providers API 文档](https://opencode.ai/docs/console/api/providers/)：自定义供应商网关同样要求 Bearer Console token。
- 官方发布的 [@opencode/console CLI 仓库 README](https://github.com/anomalyco/opencode-console-cli) 明确支持 `npx @opencode/console setup deepseek-harness`。它为 DSH 安装官方插件并连接工作区模型；插件从 CLI 凭据库读取 token，模型流量走 OpenCode Console，而非 CrewRouter。官方 CLI 源码 [`console-client.ts`](https://github.com/anomalyco/opencode-console-cli/blob/dev/src/console-client.ts) 与 [`credentials.ts`](https://github.com/anomalyco/opencode-console-cli/blob/dev/src/credentials.ts) 显示，该 CLI 目前公开的凭证路径是浏览器批准的 device-code OAuth（access/refresh token）或 `OPENCODE_API_KEY`；这并未实现/展示 CI workload OIDC。它只是独立的交互式 DSH 集成，不能用来否定新公告的 CI Keyless。
- 官方 OpenCode GitHub 仓库的 [release workflow](https://github.com/anomalyco/opencode/blob/dev/.github/workflows/release.yml) 确实使用 `permissions: id-token: write` 向 AWS IAM 做 GitHub OIDC 联邦，再经临时 AWS role 凭证取得 Secrets Manager 凭据、云发布 token。它证明 OpenCode 自身 CI 已使用 workload identity federation 的模式，但这是 AWS 信任 GitHub OIDC，不是 OpenCode Console inference 的认证协议。不能把该工作流中的 IAM/role 配置挪用为 Console Keyless endpoint。

用户所附 `OPENCODE_NOKEY_ANA.html` 对信任策略、claims、凭证寿命和步骤作了详细描述；这些细节没有在上述可见官方契约中确认，应视为待验证线索，不宜直接当作接口规范。

## CrewRouter 接入面

CrewRouter 当前将供应商 API key 存在 `providers` 配置中，由服务端解密后用于多个不同的供应商协议与代理路径。已有 key 刷新器适用于供应商脚本刷新，不自动具备 OIDC 身份令牌获取、联邦兑换或其安全语义。因而仅增加一个 UI 选项或将 OIDC JWT 填进现有 `api_key` 字段既不能实现 Keyless，也会有凭据混用风险。

若未来取得正式协议，合理接入应是 OpenCode Console 专用的服务端认证实现：从明确支持的工作负载身份源获取短时 assertion，按官方约定交换访问凭据、在内存中短期缓存并按期刷新，再复用受支持的 Console inference API；静态 API key 兼容模式保持不变。需加并发刷新、超时/错误处理、token 脱敏与 mock 集成测试，并限制 issuer/audience/origin，避免任意 URL/SSRF。

## GitHub Actions OIDC：可确认的客户端侧行为

GitHub 的标准 OIDC token 请求由 Actions runner 提供环境变量 `ACTIONS_ID_TOKEN_REQUEST_URL` 与 `ACTIONS_ID_TOKEN_REQUEST_TOKEN`。客户端通过该 runner endpoint 请求 JWT，并可附上 audience；工作流需要在具体 Job 授权 `permissions: id-token: write`。token 的 `iss`、`sub`、`aud`、仓库/ref/workflow 等 claims 由 GitHub签发，但 audience 字符串必须由目标受信服务规定。GitHub 的 OIDC 文档说明的是 runner 获取机制和依赖方 federation 配置，不会替 OpenCode Console 定义其 audience、token exchange 或 inference 鉴权头。

因此 CrewRouter 可设计一层 GitHub Actions token source（只读取 runner 环境并请求指定 audience 的短时 JWT），但 audience 目前未知，不能写死或设置成猜测值。不能拿 `ACTIONS_ID_TOKEN_REQUEST_TOKEN`（它是对 runner OIDC request endpoint 的 bearer secret）直接作为模型凭证，也不能未经 Console 契约确认把返回的 JWT 放到 inference Authorization 头。

参考：[GitHub Actions OIDC 概念文档](https://docs.github.com/en/actions/concepts/security/openid-connect)、[OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)。

## 解锁实现所需信息

1. OpenCode Console 对 GitHub Actions 支持的 issuer 与 audience 精确值，以及它是否仅支持 GitHub Actions。
2. Console 是否接受 Job 的原始 OIDC JWT 直接做 inference 认证，还是需要交换；若需交换，给出官方 endpoint、HTTP method、content type/request schema、response schema、expires/refresh/revoke、redirect 和错误语义。
3. token 是否绑定 service account/workspace、模型 request 权限与预算；trust policy 的 `sub`/repository/ref/workflow/environment claims 匹配语义，以及 fork/PR 的拒绝规则。
4. 认证后的 inference 请求 base URL、API family 路径、Authorization 头格式、session/header 要求；是否覆盖 paid、Go、connected BYOK models。
5. 官方可依赖的 SDK/CLI 实现或测试示例及其稳定性/版本策略。

## CrewRouter 实现前需要厘清的部署模式

存在两个不同的 Keyless 用法，不能混为一谈：

用户已确认目标是 **CrewRouter 使用 GitHub CI 等运行环境的 OIDC 身份调用 OpenCode Console，再由 CrewRouter 承接模型代理**，不是 DSH 官方 CLI 登录，也不是 CI 客户端绕过 CrewRouter 直连 Console。因此实现应假设 CrewRouter 进程运行在该 CI Job 的身份上下文里，自己从 GitHub OIDC runtime 获取 assertion 并向 Console 认证。

若 CrewRouter 实际部署在 CI Job 以外的常驻服务，Job 的 OIDC token 不会自动出现在该进程中；不能把它当作当前方案，除非另行设计并确认受信的 token delegation。此部署限制需要在功能配置/文档中明确。

## 推荐实施方案（协议确认之后）

1. **协议关卡（先于代码）。** 获得 OpenCode 官方 audience、Console endpoint/schema、claims/trust 语义、结果凭证使用方式；至少有一份官方 CLI 源码/文档/可重复的官方 GitHub Actions workflow 对得上。没有这些证据不实现 Console federation URL/请求。
2. **只在目标 Job 放权。** 使用专用 Job（不是 workflow 顶层宽授权），Job 显式写 `permissions: contents: read, id-token: write`；外部 fork PR job 默认不给 `id-token: write`；只允许保护分支/环境触发 Keyless job，给维护者 review workflow changes，减少第三方 action 和不可信 PR 代码在获权 Job 中执行。Trust policy 精确限制 repo/ref/workflow/environment；CI 里的提示词、分支内容、模型输出仍视为不可信数据，不能让不可信分支借获权 Job 使用上游额度。
3. **新增 OpenCode 专用 provider auth 模块。** 不复用 providers.api_key 中的 encrypted long-term key 字段来存 runtime token。数据库只保存 `auth_mode`、可选官方 profile/workspace IDs 等非秘密配置；具体字段等 Console schema 确认后设计。provider 编辑页加 GitHub Actions OIDC 选项、健康状态/诊断但不显示 token。静态 key 保持单独路径。
4. **GitHub token source 适配器。** 仅在受支持 Actions runner 中读取 `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN`，使用官方 audience 请求短期身份 JWT；禁止把 runner request token 或 OIDC JWT保存到 DB、日志、报错详情、配额记录、API 响应。其它 CI 平台后续单独 adapter，不猜测通用 token file/env。
5. **协议化的 Console broker。** 视官方流程支持两种路径之一：A. JWT 直接用于 inference；B. JWT 发给官方固定 exchange endpoint，缓存 exchange 短时凭证。只按官方指定 URL/内容传输，HTTPS、无跨 origin redirect、超时和响应上限、结构及过期字段校验。内存缓存以 provider + GitHub repo/workflow/ref identity 隔离；在过期前重新取 OIDC assertion / 重新 exchange；并发合并刷新。任何错误 fail closed，不使用失效缓存或暗中回退 API Key。
6. **接入统一认证边界及转发。** 在 API proxy 获取 provider 的统一层给该 provider 解析请求级 auth header，避免逐路由散改；现有静态 key/provider OAuth refresh 不变。依官方指定的 OpenCode inference root/API family/model list/session headers 构造请求，覆盖流式与非流式。确认 Console 是否要求模型查找认证和 session affinity，准确分类 401/403，不重试不安全的 mutation。
7. **安全/审计范围。** 对签发拒绝/身份主体和使用量只记录非敏感的 run/repo/workflow/ref 标识（若合规且有官方 claim）；不记录 assertion/access token。严格来源允许名单、防止 arbitrary issuer/audience/endpoint config 与 SSRF；trust policy 是 Console 的根策略，CrewRouter 提示最小权限但不替代其 claim 校验。
8. **测试矩阵。** 注入 token source 和 HTTP transport，在本地模拟 runner OIDC metadata/token endpoint、（如果官方定义）exchange 与 inference。测试缺 Actions env、权限拒绝、aud 参数、OIDC/exchange 失败、假响应字段、过期和并发、refresh 时断网、redirect origin、日志/API 泄露、user-level provider 静态兼容、非 OpenCode provider 没有回归、chat/responses/anthropic + streaming/session header。加部署文档：工作流 YAML、repo/environment trust policy 最小示例、fork PR 限制、权限/审计和 CI 外实例不支持说明。

## 待确认/阻塞信息

- 官方 exchange endpoint 与 aud/claim 契约（这是编码前的必要条件）。
- 首版是否只支持 GitHub Actions，或需要 GitLab 等 OIDC 平台；附件虽列出 Custom OIDC，但具体支持需证实。
- 目标路径已确定为 CI Job 中 CrewRouter 进程自己取得 OIDC token 并认证 OpenCode；需确认它是否只运行在 GitHub Actions，或也要 GitLab 等 OIDC 平台。
- 若将来要支持 CI 外的常驻 CrewRouter 服务，需单独确认官方支持的 workload identity 来源或安全 token delegation；不在当前 GitHub Job OIDC 范围内。
- Keyless 是否适用于 OpenCode 自有模型和 BYOK/provider-connections，及 Service Account 权限/预算范围。

## 本次授权后的实施状态

用户已明确同意按本方案实现 CrewRouter CI OIDC 接入。但执行方案自身的第 1 步是协议关卡：本轮再次核对公开的 Console API 总览及 inference 文档，认证仍只写 API key/service-account key；官方 Console CLI 仍是 device-code OAuth / `OPENCODE_API_KEY`；OpenCode 仓库搜索到的 `id-token: write` 用例属于 AWS/GitHub App 等别的信任方，而非 Console inference Keyless。因此当前缺少被批准方案要求的 audience、Console exchange/直接 inference 认证契约。本轮**没有提交运行时代码**，以免把未经证实的身份 assertion 发送给真实模型服务或错误落入 Bearer 认证。

收到 OpenCode 官方 endpoint/audience 和协议（或能安全访问的官方配置/最小调用例）后，无需再讨论集成目标，可按此直接实施。建议代码落点：

- `server/utils/opencode-console-auth.js`：Actions token source + Console 官方 credential 解析/短期缓存；只接受既定 Console origin/audience，含并发刷新和秘密脱敏。
- `server/routes/api.js` 的 provider 请求入口（当前 `getProvider` / `getProviderForRequest` 与统一代理前）：按 `auth_mode` 解析请求级 credential，不把短期 token 填入 API key 数据字段。
- `server/scripts/init-db.js`：幂等 provider auth-mode 字段迁移；`server/routes/admin.js` 与 `public/js/admin.js`：只暴露非秘密配置和连接状态，静态 Key 兼容。
- `server/scripts/test-opencode-console-oidc.js`：替身 runner OIDC source / exchange / inference 的隔离测试，并跑现有 provider auth / upstream generation 回归。

## 结论

用户同意执行实现计划；当前是实现的协议前置条件未满足，而不是集成目标未确定。收到上述官方协议后继续完成代码、测试、文档与提交。静态 API Key 路径保持兼容；常驻 CrewRouter 部署需官方额外支持 workload identity 的方法。
