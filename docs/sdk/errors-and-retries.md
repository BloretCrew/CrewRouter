# Errors and retries

## Error classes

All SDK errors extend `CrewRouterError`:

| Class | Status |
| --- | --- |
| `CrewRouterBadRequestError` | 400, 413, 422 |
| `CrewRouterAuthenticationError` | 401 |
| `CrewRouterPermissionError` | 403 |
| `CrewRouterNotFoundError` | 404 |
| `CrewRouterConflictError` | 409 |
| `CrewRouterRateLimitError` | 429 |
| `CrewRouterServerError` | 5xx |
| `CrewRouterConnectionError` | network/DNS/TLS failures |
| `CrewRouterTimeoutError` | request or stream idle timeout |
| `CrewRouterAbortError` | caller aborted the request |
| `CrewRouterStreamError` | protocol-level stream failure |

## Fields

```ts
error.status;      // HTTP status, when available
error.code;        // e.g. permission_denied, model_access_denied, session_required
error.type;        // protocol error type
error.permission;  // needed permission for 403 permission errors
error.requestId;   // X-CrewRouter-Request-Id
error.retryAfter;  // seconds, from Retry-After
error.rawBody;     // parsed body or raw text
error.headers;     // response Headers
error.protocol;    // 'openai' | 'anthropic' | 'management' | 'unknown'
```

The SDK parses all of these shapes:

- OpenAI: `{ "error": { "type", "message", "code" } }`
- Anthropic: `{ "type": "error", "error": { "type", "message" } }`
- Management: `{ "error": "message", "code": "permission_denied", "permission": "keys.read" }`
- Plain text, HTML and empty bodies

## Retry policy

**Default `maxRetries` is 0.** Gateway POSTs can be billed, so the SDK does not
retry them unless you opt in.

When retries are enabled:

- Retryable statuses: 408, 429, 500, 502, 503, 504.
- Retryable methods by default: `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`.
- `POST` and `PATCH` retry only when `retryNonIdempotent: true`.
- `Retry-After` is honored; otherwise exponential backoff with jitter is used.
- Aborted requests are never retried.
- Streaming requests do not retry after any event has been received. A retry may
  happen only while establishing the response, and only when retries are enabled.

```ts
const client = new CrewRouter({
  baseUrl,
  apiKey,
  maxRetries: 2,             // GET/HEAD/PUT/DELETE only
  retryNonIdempotent: false,
});
```

## Duplicate billing warning

A gateway POST is not idempotent from CrewRouter's point of view. If a request
reaches an upstream and the response is lost, retrying can produce a second
billed generation. Keep `maxRetries: 0` for chat/messages/responses unless your
application can tolerate duplicates, and prefer client-side idempotency keys or
a higher-level job queue.

## Timeouts

- Management requests default to 30 seconds.
- Gateway non-streaming requests default to 600 seconds.
- Streams use an idle timeout (default 120 seconds) rather than a total duration.

Override with `timeoutMs` (non-streaming) or `streamIdleTimeoutMs` / the
`idleTimeoutMs` stream option.

## Errors during streaming

If the upstream fails after SSE headers are sent, the gateway may emit an error
event or a protocol-specific failure event (`response.failed` for Responses).
The SDK yields those events so the caller can inspect them; the stream then
ends. A transport failure raises `CrewRouterStreamError` or
`CrewRouterConnectionError`.

## Debugging checklist

1. Read `error.code` first; it is stable across protocol shapes.
2. Check `error.permission` for 403 `permission_denied`.
3. Include `error.requestId` when reporting an issue; the server writes the same
   id to its request log.
4. For upstream failures, `error.rawBody` preserves the upstream message.
