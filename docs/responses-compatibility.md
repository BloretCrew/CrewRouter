# Responses 请求与错误兼容

CrewRouter 将 Responses 请求转换为 Chat Completions 或 Anthropic Messages 时，过滤 `X-OpenAI-Internal-Codex-Responses-Lite` 请求头，避免上游按 Responses Lite 协议校验转换后的请求。

Codex Responses Lite 不使用顶层 `tools`，而是把命名空间工具放在 `input` 的 `additional_tools`。转换时把其中的 `function` 和 `custom` 工具提升为 Chat Completions 工具，并在回写时按原命名空间恢复 `function_call` 或 `custom_tool_call`。`functions` 命名空间按 Codex 的默认命名空间省略。`additional_tools` 不会变成空的 developer 消息。后续轮次里的 `custom_tool_call` 与 `custom_tool_call_output` 会转成 Chat 的工具调用和工具结果。原生 Responses 透传保持 `additional_tools` 原样。

原生 Responses 路径仅在最终发送的请求体包含 `reasoning.context: all_turns` 时保留该请求头。模型未启用推理参数透传、或协议转换丢失该字段时，移除请求头，不强行添加上游不支持的参数。

流式请求在上游返回成功后才发送 SSE 响应头。开始传输前的上游错误保留 HTTP 状态码，并返回标准错误 JSON；传输中的异常发送 `response.failed` 并结束响应，不发送表示成功完成的 `response.completed`。错误保留上游提供的 `message`、`type`、`code` 和 `param`。

运行 `npm run test:responses-compat` 验证请求头过滤、错误响应、读取异常及正常文本流。测试不请求真实模型，也不产生模型费用。

生产实例必须重新加载修改后的服务端代码才能生效。历史空白回复不会自动补出正文，需要重新发起请求。
