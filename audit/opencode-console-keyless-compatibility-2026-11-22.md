# OpenCode Console Keyless Auth 与 CrewRouter 兼容性评估

日期：2026-11-22

## 结论

**目前不能安全地把公告中的 OIDC Keyless Auth 接入 CrewRouter 的模型供应商请求链路；本轮不修改运行时代码。** 公告证实 OpenCode Console 宣布支持在 CI 或其他支持 OIDC 的环境中无长期 API token 调用模型，但可查的官方接口文档仍要求推理请求携带 Console API key。缺少 OIDC token 换取推理访问凭据的公开协议，不能凭二手分析自行猜测 endpoint、audience、token 格式或凭证期限。

需要 OpenCode 官方提供服务端集成协议，或发布包含该能力的官方客户端/SDK，才能按契约实现和测试。当前可以确认的 CrewRouter 工作负载身份不代表 OpenCode 已接受对应 token；**绝不能把 GitHub/Kubernetes 的 OIDC JWT 直接放进模型请求的 `Authorization: Bearer` 头**。

## 官方信息核查

- [OpenCode 官方 X 公告](https://x.com/opencode/status/2124037654639468759)：声明 Console 支持 keyless auth，可从 CI 或任意支持 OIDC 的环境调用模型，不再需要长期 API token。公告未附兑换 API 或客户端实现细节。
- [Console Inference API 文档](https://opencode.ai/docs/console/api/inference/)：示例及认证章节要求请求以 `Authorization: Bearer <token>` 发送 personal/service-account API key。
- [Console API 总览](https://opencode.ai/docs/console/api/)：列出的凭证类型仍为 personal API key 与 service account key。
- [Console Harnesses 文档](https://opencode.ai/docs/console/harnesses/)：其他 Harness 按文档使用 Console API key；Console CLI 可执行 `setup deepseek-harness` 进行浏览器授权接入，但这描述的是用户交互式 Console 连接，不是可直接推导为无人的服务器端 OIDC token exchange。
- [Console Providers API 文档](https://opencode.ai/docs/console/api/providers/)：自定义供应商网关同样要求 Bearer Console token。
- 工作区内 OpenCode 源码与官方文档快照中未发现 Console 推理 OIDC token exchange 的实现或协议。其 OpenCode Console provider 支持 OAuth/device-code 用户授权和 API key 两种连接方式，但这也不证明该交互式 OAuth 流程就是公告所指的 Keyless 服务端机制。

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

## 决策

待上述官方契约公开或由用户提供可验证的官方实现后，再立项编码。若 Keyless 只适用于 GitHub Actions 等 job 上下文，可先用于 CrewRouter 自身在该 CI job 内运行的场景；不能据此承诺常驻 CrewRouter 部署支持 OIDC 联邦。现有静态 API key 接入方式不变。
