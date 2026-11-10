# 协议桥媒体支持

本文件记录 `server/protocol/` 在 Anthropic / OpenAI Chat / OpenAI Responses /
Gemini / Interactions 之间转换图片与非图片媒体时的行为。

## Source 归一化

图片 source 由 `server/protocol/helpers.js` 统一归一化为三种 canonical 形态：

- `{ kind: 'data', mimeType, data, dataUri }`
- `{ kind: 'url', url, detail? }`
- `{ kind: 'file', fileId, detail? }`

各 codec 的 image 编码分支通过 `imageSourceToOpenAI` / `imageSourceToAnthropic` /
`imageSourceToResponses` / `imageSourceToGemini` 输出目标方言需要的形状。
同方言的合法输入保持原样，不会被改写。

## 媒体能力

`server/protocol/capabilities.js` 的 `MediaQuirks` 声明各方言的输入/输出能力：

| 方言 | image 输入 | document 输入 | audio 输入 | 媒体输出 |
| --- | --- | --- | --- | --- |
| openai | supported | degrade | supported | degrade |
| anthropic | supported | supported | degrade | degrade |
| responses | supported | supported | degrade | degrade |
| gemini | supported | supported | supported | supported |
| interactions | supported | supported | supported | supported |

`degrade` 表示目标协议没有等价表达时会生成文本占位符
`[media omitted: <mime>, <bytes> bytes]`，不会产生非法的 `image_url` / `input_image`，
也不会静默丢弃。OpenAI Chat 的 `file_id` 没有等价物，会降级为占位文本。

## 限制与运行时兜底

- Gemini 的 `fileData.fileUri` 只对 Gemini 上游有效。`server/gateway/bridge-proxy.js`
  的 `materializeMedia` 会把远程 HTTP 图片下载为 base64；非 Gemini 目标遇到
  `fileUri` 会抛出 `unsupported_media_source`。
- OpenAI/Anthropic 的 `file_id` 在 Gemini 中没有等价物。
- 工具结果（`tool_result` / `function_call_output`）里的媒体：
  - Anthropic、Responses 原生保留；
  - OpenAI Chat、Gemini 把媒体拆到紧随其后的 user 消息，tool 消息只保留文本。
- 响应方向（模型输出图片）在 OpenAI Chat / Anthropic / Responses 中降级为文本占位符；
  Gemini 目标保留原生媒体。

## 计费与存储

- 图片 token 优先取上游 usage 中的 `image_tokens`；缺失时按请求图片数量估算，
  再乘 `models.image_ratio`（缺省或 0 视为 1.0）。
- `usage_records` / Playground 写入前会把 base64 媒体替换为
  `[media redacted: <mime>, <bytes> bytes, sha256:<prefix>]`。
- `gemini_interactions` 是可重放存储，保留原图；受单请求大小上限与保留期约束。
