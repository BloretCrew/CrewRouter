# Responses 请求与错误兼容

CrewRouter 将 Responses 请求转换为 Chat Completions 或 Anthropic Messages 时，过滤 `X-OpenAI-Internal-Codex-Responses-Lite` 请求头，避免上游按 Responses Lite 协议校验转换后的请求。

原生 Responses 路径仅在最终发送的请求体包含 `reasoning.context: all_turns` 时保留该请求头。模型未启用推理参数透传、或协议转换丢失该字段时，移除请求头，不强行添加上游不支持的参数。

流式请求在上游返回成功后才发送 SSE 响应头。开始传输前的上游错误保留 HTTP 状态码，并返回标准错误 JSON；传输中的异常发送 `response.failed` 并结束响应，不发送表示成功完成的 `response.completed`。错误保留上游提供的 `message`、`type`、`code` 和 `param`。

运行 `npm run test:responses-compat` 验证请求头过滤、错误响应、读取异常及正常文本流。测试不请求真实模型，也不产生模型费用。

生产实例必须重新加载修改后的服务端代码才能生效。历史空白回复不会自动补出正文，需要重新发起请求。
