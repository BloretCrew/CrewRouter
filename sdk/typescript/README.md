# CrewRouter Node/TypeScript SDK

Official Node.js SDK for the CrewRouter AI model gateway.

- OpenAI Chat Completions, Anthropic Messages and OpenAI Responses, including SSE streaming.
- Full management API coverage through the generated operation catalog.
- Typed convenience wrappers for API keys, usage, balance, models, providers and teams.
- Zero runtime dependencies (native `fetch`, Node.js >= 20).

> **License:** GPL-3.0. See [LICENSE](./LICENSE).

## Install

```bash
npm install @bloret-crew/crewrouter-sdk
```

## Quick start

```ts
import { CrewRouter } from '@bloret-crew/crewrouter-sdk';

const client = new CrewRouter({
  baseUrl: 'https://your-host',
  apiKey: process.env.CREWROUTER_API_KEY,
});

const response = await client.gateway.chat.completions.create({
  model: 'claude-fable-5', // accepted for SDK compatibility; CrewRouter routes by API Key binding
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.data);
```

### Streaming

```ts
for await (const event of client.gateway.chat.completions.stream({
  messages: [{ role: 'user', content: 'Write a haiku' }],
})) {
  if (event.done) break;
  process.stdout.write(JSON.stringify(event.parsed) + '\n');
}
```

### Anthropic Messages and Responses

```ts
const message = await client.gateway.messages.create({
  model: 'claude-fable-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});

const responses = await client.gateway.responses.create({
  input: 'Explain SSE in one sentence.',
});
```

## Management API

New API keys only receive the `gateway.*` permissions by default. Grant
management permissions explicitly (for example `keys.read`, `keys.write`,
`usage.read`). Admin operations additionally require the key owner to be an
administrator.

```ts
const keys = await client.keys.list();
const keyRows = keys.data; // ApiKeyListItem[]; key_value can be null when redacted
const created = await client.keys.create({
  name: 'CI',
  expiresIn: 720,
  permissions: ['gateway.chat', 'gateway.messages'],
});

await client.keys.setModels(created.data.id, { models: ['claude-fable-5'] });
const keyUsage = await client.keys.getUsage(created.data.id); // ApiKeyDailyUsageItem[]
const keyModels = await client.keys.getModels(created.data.id); // ApiKeyModelsResponse
const membership = await client.keys.getMembers(created.data.id); // ApiKeyMembersResponse
const schedule = await client.keys.getSchedule(created.data.id); // ApiKeySchedule

const usage = await client.usage.get({ days: 7 }); // DailyUsageItem[]
const balance = await client.balance.get(); // UserBalance
const visibleModels = await client.models.list(); // UserModelListItem[]
const visibleProviders = await client.providers.list(); // UserProviderListItem[]
const refundableCodes = await client.codeBalances.list(); // UserCodeBalanceItem[]
const uptime = await client.modelUptime.get({ days: 7 }); // ModelUptimeResponse; day or 15m granularity
```

Every non-session operation is reachable through `call`:

```ts
const providers = await client.call('admin.providers.list');
const refreshed = await client.call('admin.providers.byId.refreshKey', {
  pathParams: { id: 'openai-main' },
});
```

`client.operations` contains the full generated catalog, including each
operation's permission, auth modes and streaming flag. Session-only endpoints
(`/auth/*`, `/api/2fa/*`, `/api/passkey/*`, `/api/setup/*`, `/api/admin/update/*`,
`/oauth/authorize*`, `/oauth/authorizations*`, `/api/user/model-trace/*`) are
listed in the catalog but cannot be called with an API Key.

## Authentication

- `apiKey` defaults to `Authorization: Bearer sk-...`.
- Set `authStyle: 'x-api-key'` to send `x-api-key`.
- `oauthToken` (`crh_...`) is sent as a Bearer token and works on gateway/event
  endpoints only.
- Session cookies are not supported in this version.

## Errors and retries

```ts
import {
  CrewRouterPermissionError,
  CrewRouterRateLimitError,
} from '@bloret-crew/crewrouter-sdk';

try {
  await client.keys.list();
} catch (error) {
  if (error instanceof CrewRouterPermissionError) {
    console.error(error.code, error.permission);
  }
}
```

- `maxRetries` defaults to `0`; retries can duplicate gateway billing.
- When enabled, only idempotent methods retry by default. Set
  `retryNonIdempotent: true` to allow POST/PATCH retries.
- `Retry-After` is honored for 429 responses.
- Errors expose `status`, `code`, `type`, `permission`, `requestId`, `retryAfter`
  and `rawBody`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | `CREWROUTER_BASE_URL` | Instance URL, with or without `/v1` |
| `apiKey` | `CREWROUTER_API_KEY` | API Key |
| `authStyle` | `bearer` | `bearer` or `x-api-key` |
| `timeoutMs` | 30s management / 600s gateway | Non-streaming timeout |
| `streamIdleTimeoutMs` | 120s | Stream idle timeout |
| `maxRetries` | 0 | Retries after the first attempt |
| `signatureMode` | unset | `header`, `content` or `both` |
| `fetch` | global `fetch` | Custom fetch implementation |

## Important gateway semantics

- The request body `model` is normally **ignored**. CrewRouter routes by the API
  key's `current_model_id`, its ordered model queue, or a harness override.
  `fusion*` names are the exception.
- `GET /v1/models` is a virtual list, not the administrator model catalog.
- Response signatures can appear in `X-CrewRouter-Signature` /
  `X-CrewRouter-Signature-B64` and, for human-readable responses, in the content.
- Gateway request bodies allow up to 50 MB; management API requests allow 2 MB.

## Links

- SDK overview: `docs/sdk/README.md`
- Gateway semantics: `docs/sdk/gateway.md`
- Management API: `docs/sdk/management-api.md`
- Errors and retries: `docs/sdk/errors-and-retries.md`
