# Streaming

CrewRouter streams with Server-Sent Events (SSE) on all three gateway
completion endpoints when the request sets `stream: true`.

## SDK usage

```ts
const stream = client.gateway.chat.completions.stream({
  messages: [{ role: 'user', content: 'Write a haiku' }],
});

for await (const event of stream) {
  if (event.done) break;
  console.log(event.event, event.parsed);
}
```

Each `StreamEvent` has:

| Field | Description |
| --- | --- |
| `event` | SSE `event:` field, or `null` for OpenAI `data:`-only streams |
| `data` | Raw data string (multi-line data joined with `\n`) |
| `parsed` | `JSON.parse(data)` when possible, otherwise the raw string |
| `done` | `true` for the OpenAI `[DONE]` sentinel |

The parser handles:

- Chunks split across UTF-8 multi-byte characters
- CRLF and LF line endings
- Multiple `data:` lines per event
- Comment lines (`: keep-alive`)
- Unknown `event:` names
- `event: error`
- The `[DONE]` sentinel

## Cancellation

```ts
const controller = new AbortController();
const stream = client.gateway.messages.stream(body, { signal: controller.signal });

setTimeout(() => controller.abort(), 5_000);
for await (const event of stream) { /* ... */ }
```

You can also call `stream.abort(reason)` directly. Aborting raises
`CrewRouterAbortError` if the iterator is still pending.

## Idle timeout

Streams use an idle timeout, not a total duration. If no bytes arrive within
`streamIdleTimeoutMs` (default 120 seconds), the SDK cancels the reader and
throws `CrewRouterTimeoutError`. This catches a stalled upstream without
penalizing long generations that keep emitting tokens.

```ts
const client = new CrewRouter({ baseUrl, apiKey, streamIdleTimeoutMs: 300_000 });
```

Per-stream override:

```ts
client.gateway.chat.completions.stream(body, { idleTimeoutMs: 60_000 });
```

## Protocol event shapes

### OpenAI Chat Completions

```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}

data: [DONE]
```

### Anthropic Messages

```text
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}

event: message_stop
data: {"type":"message_stop"}
```

### OpenAI Responses

```text
event: response.created
data: {"type":"response.created","response":{...}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hi"}

event: response.completed
data: {"type":"response.completed","response":{...}}
```

The SDK does not discard unknown events. Consumers should switch on
`event.event || (event.parsed as any)?.type` and ignore events they do not need.

## Errors mid-stream

If the upstream fails before headers are sent, the request fails with the normal
error classes. If it fails after SSE headers are sent, the gateway emits a
protocol-specific error event (for example `response.failed` for Responses, or an
`error` event for OpenAI/Anthropic). The SDK yields that event and then ends the
stream. Inspect `event.event` and `event.parsed` to distinguish it from normal
completion.

## Retries

Streaming requests never retry after an event has been received. Retries during
connection establishment are disabled by default (`maxRetries: 0`), because a
gateway POST can be billed.
