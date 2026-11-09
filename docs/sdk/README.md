# CrewRouter SDK

CrewRouter is an OpenAI/Anthropic-compatible AI model gateway with a management
API for keys, models, providers, usage and billing. The SDKs give applications a
consistent way to call both surfaces.

## Two forms

| Form | What it does | Status |
| --- | --- | --- |
| **Client SDK** | Calls a running CrewRouter instance over HTTP: gateway + full management API. | Node/TypeScript, Python and Go available (0.1.0). |
| **Embeddable server SDK** | Mounts the CrewRouter gateway inside a Node/Express application. | Preview available; see [embedded-server.md](./embedded-server.md). |

The embeddable form is Node-only because CrewRouter itself is a Node/Express +
PostgreSQL service. Python and Go applications use the client SDK; running the
full gateway from Python/Go requires a sidecar process.

## Packages

| Language | Package | Notes |
| --- | --- | --- |
| Node/TypeScript | npm `crewrouter-sdk` | Zero runtime dependencies, Node >= 20, ESM + CJS + types |
| Python | PyPI `crewrouter-sdk` (import `crewrouter`) | Sync + async, `httpx`, Python >= 3.9 |
| Go | `github.com/BloretCrew/CrewRouter/sdk/go` | Standard library only, Go 1.22+ |
| Node embedded | `crewrouter/embedded` | Preview, limited options |

All packages are GPL-3.0, matching the main project. See
[licensing.md](./licensing.md).

## Quick start (Node)

```bash
npm install crewrouter-sdk
```

```ts
import { CrewRouter } from 'crewrouter-sdk';

const client = new CrewRouter({
  baseUrl: process.env.CREWROUTER_BASE_URL,
  apiKey: process.env.CREWROUTER_API_KEY,
});

const response = await client.gateway.chat.completions.create({
  model: 'claude-fable-5',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.data);
```

Streaming:

```ts
for await (const event of client.gateway.chat.completions.stream({
  messages: [{ role: 'user', content: 'Write a haiku' }],
})) {
  if (event.done) break;
  process.stdout.write(JSON.stringify(event.parsed) + '\n');
}
```

Management:

```ts
const keys = await client.keys.list();
const usage = await client.usage.get({ days: 7 });
const providers = await client.call('admin.providers.list');
```

## Three things to know before you start

1. **The request body `model` is normally ignored.** CrewRouter routes by the API
   key's `current_model_id`, its ordered model queue, or a recognized harness
   override. `fusion*` names are the exception. See [gateway.md](./gateway.md).
2. **New API keys only get `gateway.*` permissions.** Management calls need
   explicit grants; `admin.*` also requires the key owner to be an administrator.
   See [authentication.md](./authentication.md).
3. **Session-only endpoints are not callable with an API key.** They are excluded
   from generated methods. See [management-api.md](./management-api.md).

## Documentation map

| Document | Contents |
| --- | --- |
| [quickstart-node.md](./quickstart-node.md) | Install, configure, gateway/streaming/management examples |
| [quickstart-python.md](./quickstart-python.md) | Python sync/async client examples |
| [quickstart-go.md](./quickstart-go.md) | Go client, context and streaming examples |
| [gateway.md](./gateway.md) | Endpoints, model routing, SSE, signatures, limits |
| [authentication.md](./authentication.md) | Bearer, `x-api-key`, OAuth, permissions, session-only routes |
| [management-api.md](./management-api.md) | Full API coverage, `call`, path/query/body, uploads, downloads |
| [streaming.md](./streaming.md) | SSE parsing, events, abort, idle timeout |
| [errors-and-retries.md](./errors-and-retries.md) | Error classes, status codes, retry policy |
| [embedded-server.md](./embedded-server.md) | Planned `createCrewRouter` embedding |
| [versioning.md](./versioning.md) | Versions, `contractVersion`, compatibility |
| [licensing.md](./licensing.md) | GPL-3.0 obligations |
| [troubleshooting.md](./troubleshooting.md) | Common 403/413/stream issues |

Machine-readable HTTP reference: [`docs/api/openapi.json`](../api/openapi.json)
and the generated [`docs/api/reference.md`](../api/reference.md).
