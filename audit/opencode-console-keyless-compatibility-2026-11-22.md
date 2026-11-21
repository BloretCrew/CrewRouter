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

## 解锁实现所需信息

1. 官方 OIDC token 来源与支持的运行环境（GitHub Actions、GitLab、Kubernetes 等），是否支持长驻服务进程，而不只是 CI job。
2. issuer、audience、信任策略/Service Account 绑定及 token 获取方法。
3. 兑换端点、HTTP 方法与请求 schema、响应 schema、有效期、刷新/撤销和错误语义。
4. 兑换后的凭据适用于哪些 inference URL/API family、模型访问权限如何绑定及是否要求额外 session header。
5. 官方 SDK/CLI 中可依赖的稳定实现/API，及其版本/兼容保证。

## CrewRouter 实现前需要厘清的部署模式

存在两个不同的 Keyless 用法，不能混为一谈：

用户已确认目标是 **CrewRouter 使用 GitHub CI 等运行环境的 OIDC 身份调用 OpenCode Console，再由 CrewRouter 承接模型代理**，不是 DSH 官方 CLI 登录，也不是 CI 客户端绕过 CrewRouter 直连 Console。因此实现应假设 CrewRouter 进程运行在该 CI Job 的身份上下文里，自己从 GitHub OIDC runtime 获取 assertion 并向 Console 认证。

若 CrewRouter 实际部署在 CI Job 以外的常驻服务，Job 的 OIDC token 不会自动出现在该进程中；不能把它当作当前方案，除非另行设计并确认受信的 token delegation。此部署限制需要在功能配置/文档中明确。

## 推荐实施方案（协议确认之后）

1. **先核实协议，不先猜 endpoint。** 在 OpenCode Console 官方文档/CLI/源码中找 Keyless 服务账户创建说明、GitHub OIDC token 获取 audience、兑换 URL、request/response、expires 字段、模型 API 使用方式；如果官方实现仍未公开，需由用户给出能访问的官方设置页面/文档或可安全观察的配置步骤，再继续。
2. **GitHub Actions job 级接入，不给整个 workflow 广泛授权。** 最小化 `permissions: id-token: write` 的作用范围；建议只授予专用调用模型的 job；限制 trust policy 至精确 repository、protected branch/ref、workflow/environment，明确 fork PR 不得获得该身份；定期确认拒绝日志和审计归属。
3. **建模为专用 runtime credential provider，而不是数据库长期密钥。** 供应商记录只持久化认证模式和非秘密参数；OIDC assertion 与短时 Console credential 只驻留进程内、按官方 expires 提前刷新/重取，绝不写 providers.api_key 或日志。刷新失败 fail-closed，不静默退回 Keyless 模式下的旧静态密钥。
4. **OIDC 取 token 与 inference 请求分层。** 只允许受支持的 GitHub Actions OIDC 环境 source；将 assertion 发送到固定/官方 exchange origin，超时与响应大小受限，不接受任意用户配置 URL；exchange 成功后只把官方规定的 credential 放入 inference auth header。跳转不得把 assertion/token 带到其他 origin。
5. **OpenCode Console 专用 inference 配置。** 按官方支持的 inference root/API family/model IDs 配置 base URL；若 Console 要求 session affinity，再从 CrewRouter 请求上下文生成并传稳定 session header。对其他 provider 不改变行为。
6. **可测性与测试。** 注入 OIDC source 与 HTTP transport；mock GitHub OIDC token endpoint、Console exchange 及 inference。覆盖不在 Actions/权限缺失、trust rejection、无效响应、timeout、expires/刷新、并发 refresh、credential 脱敏、错误不能 fallback、chat/responses/anthropic/streaming，以及既有 static key regressions。无真实 GitHub token/Console账户的测试。

## 待确认/阻塞信息

- 官方 exchange endpoint 与 aud/claim 契约（这是编码前的必要条件）。
- 首版是否只支持 GitHub Actions，或需要 GitLab 等 OIDC 平台；附件虽列出 Custom OIDC，但具体支持需证实。
- 目标路径已确定为 CI Job 中 CrewRouter 进程自己取得 OIDC token 并认证 OpenCode；需确认它是否只运行在 GitHub Actions，或也要 GitLab 等 OIDC 平台。
- 若将来要支持 CI 外的常驻 CrewRouter 服务，需单独确认官方支持的 workload identity 来源或安全 token delegation；不在当前 GitHub Job OIDC 范围内。
- Keyless 是否适用于 OpenCode 自有模型和 BYOK/provider-connections，及 Service Account 权限/预算范围。

## 结论

应继续将 GitHub Actions 等 CI Job 作为主要方向。现在已充分提取附件中的可执行安全要求，但关键协议仍无可信证据，暂不写运行时代码。静态 API Key 路径保持兼容；常驻 CrewRouter 部署需官方额外支持 workload identity 的方法。
