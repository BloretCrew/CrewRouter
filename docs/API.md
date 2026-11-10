# CrewRouter HTTP API

CrewRouter exposes an OpenAI/Anthropic/Gemini-compatible gateway plus a management API.

## Machine-readable contract

- OpenAPI 3.1: [`docs/api/openapi.json`](./api/openapi.json)
- Generated endpoint table: [`docs/api/reference.md`](./api/reference.md)
- SDK contract source: [`sdk/contract/operations.json`](../sdk/contract/operations.json)

The OpenAPI document is generated from the Express routers and the API key
permission catalog. Untyped management responses are marked
`x-crewrouter-schema-status: untyped`; the SDK does not fabricate schemas.

## Gateway endpoints

| Method | Path | Protocol |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/responses` | OpenAI Responses |
| GET | `/v1/models` | OpenAI Models (virtual list per key) |
| POST | `/v1beta/models/{model}:generateContent` | Google Gemini generateContent |
| POST | `/v1beta/models/{model}:streamGenerateContent?alt=sse` | Google Gemini streaming |
| POST | `/v1beta/models/{model}:countTokens` | Google Gemini token counting |
| GET | `/v1beta/models` | Google Gemini model list |
| POST | `/v1beta/interactions` | Google Gemini Interactions API |
| GET/DELETE | `/v1beta/interactions/{id}` | Interactions retrieval/deletion |
| POST | `/v1beta/interactions/{id}/cancel` | Interactions cancellation |

The Gemini endpoints are also available under `/v1` (for example
`/v1/models/{model}:generateContent` and `/v1/interactions`). The same
OpenAI/Anthropic/Responses handlers are mounted at `/api/chat/completions`,
`/api/messages`, `/api/responses` and `/api/models`.

Gemini clients authenticate with `x-goog-api-key: sk-...` or `?key=sk-...`
(query keys are accepted only on Gemini routes). Interactions state is stored
locally per gateway user so `previous_interaction_id` works regardless of which
upstream provider serves the turn.

See [docs/sdk/gateway.md](./sdk/gateway.md) for model routing, streaming,
signatures, limits and Fusion.

## Authentication

```http
Authorization: Bearer sk-...
```

```http
x-api-key: sk-...
```

```http
x-goog-api-key: sk-...
```

OAuth access tokens (`crh_...`) are Bearer tokens accepted only on gateway and
client-event endpoints. Browser sessions use the `connect.sid` cookie.

See [docs/api-key-permissions.md](./api-key-permissions.md) and
[docs/sdk/authentication.md](./sdk/authentication.md).

## Management API

The management API covers users, API keys, models, providers, teams, usage,
billing, notifications, plugins, OAuth clients, audit logs and settings. Every
route is listed in the generated reference with its required permission and auth
modes.

- Non-session routes are callable with an API key that has the required
  permission.
- `admin.*` permissions additionally require `users.is_admin = true`.
- Session-only routes (`/auth/*`, `/api/2fa/*`, `/api/passkey/*`, `/api/setup/*`,
  `/api/admin/update/*`, `/oauth/authorize*`, `/oauth/authorizations*`,
  `/api/user/model-trace/*`) never accept API keys.

## Errors

Gateway errors follow the client protocol:

```json
{ "error": { "type": "invalid_request_error", "message": "..." } }
```

```json
{ "type": "error", "error": { "type": "invalid_request_error", "message": "..." } }
```

Gemini generateContent and Interactions errors use the Google envelope:

```json
{ "error": { "code": 400, "message": "...", "status": "INVALID_ARGUMENT" } }
```

Interactions non-stream errors use `{ "error": { "code": "invalid_request", "message": "..." } }`;
streaming errors arrive as `event: error` with `event_type: "error"`.

Management errors use `{ "error": "message", "code": "permission_denied", "permission": "keys.read" }`
and similar shapes. Every response includes `X-CrewRouter-Request-Id`.

## SDKs

| Language | Package | Documentation |
| --- | --- | --- |
| Node/TypeScript | `crewrouter-sdk` | [docs/sdk/README.md](./sdk/README.md) |
| Python | `crewrouter-sdk` | [docs/sdk/quickstart-python.md](./sdk/quickstart-python.md) |
| Go | `sdk/go` module | [docs/sdk/quickstart-go.md](./sdk/quickstart-go.md) |

## Existing OpenAI/Anthropic SDKs

You do not need the CrewRouter SDK to use the gateway. Point an existing client at
the instance:

```python
from openai import OpenAI
client = OpenAI(base_url="https://your-host/v1", api_key="sk-...")
```

```python
from anthropic import Anthropic
client = Anthropic(base_url="https://your-host", api_key="sk-...")
```

See [docs/integration-guide.md](./integration-guide.md).
