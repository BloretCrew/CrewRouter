# OpenCode Console Keyless Auth 与 CrewRouter 兼容性评估

日期：2026-11-22

## 结论

**更可能的目标是 CI/CD 工作负载通过 OIDC 使用 OpenCode Console，而不是让开发者在本地配置 DSH。** 公告特别强调 CI 和 OIDC-compatible environments；CrewRouter 应优先研究作为 CI 工作负载使用方/代理服务时，如何在如 GitHub Actions 这样的受信 Job 上完成身份联邦。

需严格区分 GitHub Actions 的 OIDC ID token 与 Console 推理 API 的 Bearer 凭证：OIDC token 通常只用于向受信服务证明 Job 身份，不能未经交换就当成模型 API token。公告及现可查 API/CLI 文档仍没有公布 Console 的联邦兑换端点、audience、请求/响应 schema 或服务账户信任策略；因此我们可以确认“目标场景是 CI”，但不能安全地猜造 exchange 请求。OpenCode Console CLI 的 DSH device-code OAuth 是另一个交互式方案，不是本次 Keyless 目标。

## 官方信息核查

- [OpenCode 官方 X 公告](https://x.com/opencode/status/2124037654639468759)：声明 Console 支持 keyless auth，可从 CI 或任意支持 OIDC 的环境调用模型，不再需要长期 API token。结合 CI 的表述，最符合的目标是 GitHub Actions 等短期工作负载身份，而不是本地桌面/CLI 登录。公告没有给出 OIDC token 兑换 API 或具体配置步骤。
- 本地 checkout 的 `opencode-console-cli` README 与 OpenCode Console 官方 DeepSeek Harness 集成页描述的是浏览器交互授权；发布 CLI 源码使用 device-code OAuth 和 `OPENCODE_API_KEY`。这说明它不是公告里 CI Keyless 的实现，不能再以该 CLI 未实现为依据断言 Keyless 未有实现。
- [Console Inference API 文档](https://opencode.ai/docs/console/api/inference/)：示例及认证章节要求请求以 `Authorization: Bearer <token>` 发送 personal/service-account API key。
- [Console API 总览](https://opencode.ai/docs/console/api/)：列出的凭证类型仍为 personal API key 与 service account key。
- [Console Harnesses 文档](https://opencode.ai/docs/console/harnesses/)：通用的其他 Harness 指南要求 Console API key；这和新公告的 CI Keyless 能力可能是不同配置/产品路径。
- [Console Providers API 文档](https://opencode.ai/docs/console/api/providers/)：自定义供应商网关同样要求 Bearer Console token。
- 官方发布的 [@opencode/console CLI 仓库 README](https://github.com/anomalyco/opencode-console-cli) 明确支持 `npx @opencode/console setup deepseek-harness`。它为 DSH 安装官方插件并连接工作区模型；插件从 CLI 凭据库读取 token，模型流量走 OpenCode Console，而非 CrewRouter。官方 CLI 源码 [`console-client.ts`](https://github.com/anomalyco/opencode-console-cli/blob/dev/src/console-client.ts) 与 [`credentials.ts`](https://github.com/anomalyco/opencode-console-cli/blob/dev/src/credentials.ts) 显示，当前已公开的凭证路径是浏览器批准的 device-code OAuth（access/refresh token）或 `OPENCODE_API_KEY`，并未发现 OIDC workload token exchange。该集成是可用的官方 DSH-to-Console 方案，但不能等同于 CrewRouter 上游 Keyless 供应商支持。

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

## 决策与后续

用户指出应聚焦 GitHub CI 等环境；这一判断与公告的措辞一致。本次更正将该方向列为主要目标，先前强调本地 DSH 配置/普通 API Key 的分析不能作为否定 Keyless 的依据。

实现仍需取得 Console 实际的 OIDC audience/identity-token endpoint 约定、交换 API（如有）和 token 响应契约。OIDC 受众可能只是 OpenCode Console inference 本身；也可能要向身份交换服务换取 Console bearer token。两者请求头、生命周期和安全边界截然不同，当前公开资料不足以判断，不能直接将 GitHub ID token 当 Bearer，也不能虚构 token exchange。

下一步应按 GitHub Actions Job 场景获取并验证官方 Keyless 用法与真实 Console 流程，之后再把已确认的身份来源/协议封装进 CrewRouter 专用 provider auth；保持限制：只在 GitHub Actions 等可安全获取 OIDC identity 的 job 运行态生效，缺身份时 fail-closed，不把任何 job 的 ID token 持久化入库。静态 API key 路径保持兼容。常驻 CrewRouter 实例需另获官方支持证明。
