# Troubleshooting

## 403 `permission_not_configured`

The route is protected but has no entry in the API key permission catalog. API
keys are denied by default. This usually means the route is new or internal.
Use the browser console, or add a permission mapping in the server repository
(`public/js/api-key-permissions.json`) and rerun `npm run sdk:generate`.

## 403 `permission_denied`

The key is valid but lacks the required permission. Check
`error.permission` and grant it on the key:

```ts
await client.keys.update(keyId, { permissions: ['gateway.chat', 'keys.read'] });
```

A key created by another API key cannot grant permissions the parent key does not
hold.

## 403 `admin_required`

The key carries an `admin.*` permission but its owner is not an administrator.
Create the key under an administrator account. Adding `admin.*` ids is not
enough.

## 403 `session_required`

The endpoint is session-only (`/auth/*`, `/api/2fa/*`, `/api/passkey/*`,
`/api/setup/*`, `/api/admin/update/*`, `/oauth/authorize*`,
`/oauth/authorizations*`, `/api/user/model-trace/*`). API keys cannot call it.
The SDK refuses to send the request.

## `model` has no effect

CrewRouter normally ignores the request body `model`. Update the key's model
queue instead:

```ts
await client.keys.setModels(keyId, { models: ['claude-fable-5'] });
```

`/v1/models` is a virtual list; use `client.models.list()` or the admin model
catalog for the real list.

## 413 `request_too_large`

Gateway request bodies are limited to 50 MB and normal management requests to
2 MB. The SDK does not chunk bodies. Reduce the payload or split the operation.

## 415 `unsupported_content_encoding`

The gateway supports `zstd` only on Node builds with zstd support. Decompress
the body and send plain JSON if you hit this.

## Streaming stops without `[DONE]`

The upstream may have ended the stream, or a proxy buffered/closed it. Check
`event.event`, proxy buffering settings (`X-Accel-Buffering: no` is set by the
gateway) and the instance logs using `response.requestId`.

Set a longer idle timeout for slow first tokens:

```ts
new CrewRouter({ baseUrl, apiKey, streamIdleTimeoutMs: 300_000 });
```

## `CrewRouterTimeoutError`

- Management default: 30 seconds.
- Gateway default: 600 seconds.
- Stream idle default: 120 seconds.

Raise `timeoutMs` for long generations or slow instances.

## Duplicate charges after a retry

Gateway POSTs are not idempotent. `maxRetries` defaults to 0 for this reason.
If you enabled retries (or `retryNonIdempotent`), a lost response can produce a
second billed generation. Prefer a job queue or application-level idempotency.

## `ERR_CREWROUTER_MULTIPLE_INSTANCES` (embedded, planned)

The embedded SDK supports one instance per process. Config, the pg pool and the
plugin registry are process globals. Run additional instances in separate
processes.

## Cannot mount at `/crewrouter` (embedded, planned)

The first embedded version supports root mounting only. Put nginx or another
reverse proxy in front and strip the prefix before forwarding, for example:

```nginx
location /crewrouter/ {
    proxy_pass http://127.0.0.1:20003/;
    proxy_set_header Host $host;
    proxy_buffering off;
}
```

## Where to get help

Include the following when reporting an issue:

- SDK version (`@bloret-crew/crewrouter-sdk` version and `CONTRACT_VERSION`)
- HTTP status, `error.code`, `error.type`
- `error.requestId`
- The operation id and whether you used a typed wrapper or `call`
