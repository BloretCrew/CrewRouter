# Gateway semantics

CrewRouter exposes three protocol entries and one model-list entry:

| Endpoint | Client protocol | Typical use |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | OpenAI SDKs and chat clients |
| `POST /v1/messages` | Anthropic Messages | Anthropic SDKs and Claude Code |
| `POST /v1/responses` | OpenAI Responses | Codex and Responses clients |
| `GET /v1/models` | OpenAI Models | List the models visible to this key |

The same handlers are also mounted under `/api` (`/api/chat/completions`,
`/api/messages`, `/api/responses`, `/api/models`). The SDK uses `/v1` for gateway
calls and `/api` for management calls.

CrewRouter converts between protocols as needed. A client using the OpenAI shape
can be routed to an Anthropic upstream and vice versa.

## `model` is normally ignored

This is the most important behavior to understand:

- CrewRouter routes by the API key's `current_model_id`, the ordered
  `api_key_models` queue, or a per-harness override (`claude_code`, `codex`,
  `grok`, `opencode`, `qwen_code`, `hermes`, `openclaw`, `deepseek_harness`).
- The request body `model` is accepted so existing SDKs keep working, but it does
  not select the upstream model.
- The exception is `fusion` / `fusion*`, which enters the multi-model Fusion
  pipeline.
- To change routing, update the key's model queue through
  `client.keys.setModels(id, { models: [...] })` or the console.

`GET /v1/models` is a virtual list for the current key (its display model plus
`fusion`). It is not the administrator model catalog; use `client.models.list()`
or `client.call('admin.models.list')` for that.

## Streaming

All three protocol entries support SSE when the request sets `stream: true`.
The SDK exposes typed async iterables:

```ts
for await (const event of client.gateway.chat.completions.stream(body)) {
  if (event.done) break;
  // event.event === null for OpenAI chunks
  // event.parsed is the parsed JSON object
}
```

Anthropic streams use `event:` fields (`message_start`, `content_block_delta`,
`message_delta`, `message_stop`, and so on). Responses streams use
`response.created`, `response.output_text.delta`, `response.completed`, etc.
The parser preserves the raw `event`, `data` and `parsed` values, so unknown
event types are not lost.

See [streaming.md](./streaming.md).

## Response signatures

When signature injection is enabled on the key, CrewRouter may set:

- `X-CrewRouter-Signature` — plain text when safe.
- `X-CrewRouter-Signature-B64` — base64(UTF-8) for long or non-header-safe text.

The SDK exposes `response.signature` and `response.signatureBase64`. For
human-readable chat responses the signature may also be appended to the content.
Set `signatureMode` on the client (or `x-crewrouter-signature-mode` per request)
to request `header`, `content` or `both`.

Tool-only responses, `json_object` / `json_schema` responses and Responses calls
with only function-call items skip content appending.

## Request limits

- Gateway request bodies: up to 50 MB.
- Normal management API requests: up to 2 MB.
- `Content-Encoding: zstd` is supported by the gateway on Node versions with
  zstd support; unsupported encodings return 415.

The SDK does not split large bodies. A 413 response is mapped to
`CrewRouterBadRequestError` with `code: "request_too_large"`.

## Fusion

Send a model name starting with `fusion` (for example `fusion`) to use the
Fusion pipeline. Fusion runs multiple panel models, analyzes their outputs and
synthesizes a final answer. Fusion can be configured per API key or through
named presets in the console. Streaming is supported.

If Fusion is disabled for the key, the gateway returns 403 with
`code: "fusion_disabled"`.

## Anthropic passthrough and safeguards

`POST /v1/messages` forwards top-level fields to native Anthropic upstreams,
overriding only `model`, `stream` and `response_format`. When a request carries
`safeguards` (or the `dangerous-tool-use-2026-09-03` beta) and the selected
upstream is not native Anthropic, the gateway returns a named
`400 invalid_request_error` instead of silently stripping the field. Clients
should retry without the field and fall back to local classification.

## Errors

Gateway errors follow the client protocol:

- OpenAI / Responses: `{ "error": { "type", "message", "code" } }`
- Anthropic: `{ "type": "error", "error": { "type", "message" } }`

The SDK normalizes both into `CrewRouterError` subclasses. See
[errors-and-retries.md](./errors-and-retries.md).
