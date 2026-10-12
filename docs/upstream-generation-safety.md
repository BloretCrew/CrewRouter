# 上游生成消耗、安全重试与诊断

## 修复范围

CrewRouter 保留 Chat 和 Responses 转 OpenAI 的 `prompt_cache_key`，保留 OpenAI → Anthropic 的 system、文本、图片、工具定义和工具结果缓存标记。第四缓存断点仍遵守现有开关，已有 TTL 不被覆盖。原生 Anthropic 的 `redacted_thinking.data` 和思考签名按不透明内容保留。

所有统一传输请求合并客户端生命周期和上游超时信号。客户端取消后停止网络请求；背压等待处理 drain、close、error、abort，并清理监听器。流读取失败、流内错误和缺少完成事件的 EOF 终止成功收尾。失败路径取消 reader 并释放锁。

原生 Anthropic 是有签名思考和 redacted thinking 的推荐流式接口。旧跨协议流转换不能完整表达这些内容时返回明确的能力错误，避免静默丢失数据。不要把该兼容性限制理解为可以修改或省略原生签名。

## 重试规则

| 情况 | 行为 |
|---|---|
| 无响应、DNS 解析失败或连接被拒绝 | 在共享预算内允许回退 |
| 客户端取消、超时、连接重置、结果不确定的传输错误 | 终止自动回退 |
| 收到响应后 JSON 无效、响应截断、SSE 中断 | 终止自动回退 |
| HTTP 429、5xx、认证或参数错误 | 返回原错误，不自动重新生成 |
| HTTP 重定向 | 不自动跟随，避免 POST 重放绕过预算 |
| 达到 12 次传输尝试预算 | 不发送新请求，计数保持 12 |
| 重复配置相同供应商 Key | 一次失败链只尝试该凭据一次 |

HTTP 5xx 和客户端响应尚未发送，都不能证明上游尚未开始生成。保守规则会增加部分故障场景下的客户端可见错误，同时减少隐式重复生成。客户端自行重试和兼容上游内部重试仍需独立检查。

429 保留上游状态及合法的 `Retry-After`。CR 不在内部等待并重新提交生成；客户端可依据等待提示决定后续请求。

## 尝试诊断

`[UpstreamAttempt]` 日志包含本地请求 ID、调用用途、尝试号、阶段、HTTP 状态及是否收到响应头。日志不包含 URL、密钥、认证头、缓存键或对话正文。

- `sending`：进入传输尝试，不证明 Claude 已接受生成。
- `headers`：已收到 HTTP 响应头。
- `completed`：HTTP 响应流结束，不等同于协议生成成功。
- `failed`：传输失败或流中断。

调用用途包括 `user_request`、`model_test`、`session_summary`、`provider_parse` 和 `fusion`。用途用于诊断，不能作为授权或计费依据；客户端可能提供用途提示。

模型测试发送真实的小型生成请求，结果保存在模型测试表，普通用量列表未必覆盖测试调用。会话总结、智能解析和 Fusion 同样会产生推理。消息结构分析和多维度聚合在本地执行。内置 Claude 额度查询使用 OAuth usage GET 接口。

## 本地验证

```sh
node server/scripts/test-upstream-generation-routes.js
node --test server/scripts/test-upstream-transport.js
node server/scripts/test-upstream-stream-safety.js
node --test server/scripts/test-model-identity.js server/protocol/test/protocol.test.js server/protocol/test/protocol-bridge.test.js
```

路由测试加载实际 Express router、协议转换、生命周期和 Axios 传输，仅隔离数据库、认证、计费、供应商和插件边界。上游限于本地 HTTP。测试真实接收请求次数、连接关闭及最终 JSON/SSE，不调用 Claude、不写生产用量。

本地上游连接关闭证明 CR 及时停止传输。远端兼容服务收到断连后是否停止内部推理，需要检查该服务实现和真实运行日志。

## Claude Pro 对照实验

真实请求会消耗额度，需要用户单独批准。生产部署、重启和配置修改也分别需要批准。

1. 固定同一账号、兼容上游版本、模型、客户端版本及账号池路由。
2. 排除或记录其他用户和后台调用，确认 usage 查询账号与生成账号一致。
3. 固定提示词、历史、tools、输出上限、thinking、stream、请求头、缓存键和缓存标记。
4. 先用短上下文及低输出上限交替执行直连和 CR 对照；再在获准预算内测试可控重复前缀。
5. 记录客户端请求、CR 尝试、兼容上游实际 Claude 请求、usage 分解、结束原因以及额度快照时间。
6. 避免用接近百万 token 的历史请求起步。缓存预热顺序、usage 更新延迟和窗口统计粒度均需控制或注明。
7. 注入内容属于真实差异，可在获准的隔离配置中追加无注入对照，不直接修改生产用户配置。
8. 账号无法固定或额度刷新粒度不足时，只报告请求和 usage 差异，不宣称精确订阅扣费倍率。

当前修复不证明真实 Claude Pro 的消耗降低了某个百分比。上游报告的输入包含缓存 token，不能直接换算订阅额度。

## 发布与Desktop

本轮修改源代码，不自动重启生产、推送或更新发布产物。Desktop 使用打包后的本地服务，需要在正式发布时重新生成服务 bundle，并按现有 `stage:server` 流程打包。禁止将生产配置和密钥复制到 Desktop 发布包。

部署后观察每请求尝试数、取消后连接存活时间、错误比例和缓存指标。出现兼容性回归时回滚对应提交或发布包，保留脱敏诊断证据。
