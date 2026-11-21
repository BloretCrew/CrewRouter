# Node/TypeScript quick start

## Install

```bash
npm install @bloret-crew/crewrouter-sdk
```

Requires Node.js >= 20. The package uses native `fetch` and has no runtime
dependencies.

## Configure

```ts
import { CrewRouter } from '@bloret-crew/crewrouter-sdk';

const client = new CrewRouter({
  baseUrl: 'https://your-host',       // your CrewRouter instance URL
  apiKey: process.env.CREWROUTER_API_KEY,
});
```

`baseUrl` and `apiKey` fall back to `CREWROUTER_BASE_URL` and
`CREWROUTER_API_KEY` when omitted. Do not put the key in the URL.

## Chat Completions

```ts
const response = await client.gateway.chat.completions.create({
  model: 'claude-fable-5',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.data);
console.log(response.requestId, response.signature);
```

The `model` field is accepted for compatibility with OpenAI clients, but
CrewRouter normally routes by the API key binding. See
[gateway.md](./gateway.md).

## Streaming

```ts
for await (const event of client.gateway.chat.completions.stream({
  messages: [{ role: 'user', content: 'Write a haiku' }],
})) {
  if (event.done) break;
  console.log(event.event, event.parsed);
}
```

Each event has `event` (SSE `event:` field), `data` (raw string), `parsed`
(JSON when possible) and `done` (`[DONE]` sentinel).

Cancel a stream with an `AbortController`:

```ts
const controller = new AbortController();
const stream = client.gateway.chat.completions.stream(
  { messages: [{ role: 'user', content: 'Long answer' }] },
  { signal: controller.signal },
);

setTimeout(() => controller.abort(), 1_000);
for await (const event of stream) { /* ... */ }
```

## Anthropic Messages

```ts
const response = await client.gateway.messages.create({
  model: 'claude-fable-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
});
```

Use `client.gateway.messages.stream` for SSE.

## Responses API

```ts
const response = await client.gateway.responses.create({
  input: 'Explain server-sent events in one sentence.',
});
```

## Management API

```ts
// Keys
const keys = await client.keys.list();
const created = await client.keys.create({
  name: 'CI',
  expiresIn: 720,
  permissions: ['gateway.chat', 'gateway.messages'],
});

await client.keys.setModels(created.data.id, {
  models: ['claude-fable-5'],
});

// Usage and balance
const usage = await client.usage.get({ days: 7 });
const balance = await client.balance.get();
```

All operations, including admin endpoints, are reachable through `call`:

```ts
const users = await client.call('admin.users.list', { query: { page: 1 } });
const provider = await client.call('admin.providers.byId.get', {
  pathParams: { id: 'openai-main' },
});
const refreshed = await client.call('admin.providers.byId.refreshKey', {
  pathParams: { id: 'openai-main' },
});
```

`client.operations` is the generated catalog:

```ts
console.log(client.operations['admin.providers.byId.refreshKey']);
// { method: 'POST', path: '/api/admin/providers/:id/refresh-key', permission: 'admin.providers.write', ... }
```

## Errors

```ts
import {
  CrewRouterPermissionError,
  CrewRouterRateLimitError,
  CrewRouterTimeoutError,
} from '@bloret-crew/crewrouter-sdk';

try {
  await client.keys.list();
} catch (error) {
  if (error instanceof CrewRouterPermissionError) {
    console.error(error.status, error.code, error.permission);
  }
}
```

See [errors-and-retries.md](./errors-and-retries.md).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | env `CREWROUTER_BASE_URL` | Instance URL, with or without `/v1` |
| `apiKey` | env `CREWROUTER_API_KEY` | API key |
| `oauthToken` | — | `crh_...` token (gateway/events only) |
| `authStyle` | `bearer` | `bearer` or `x-api-key` |
| `headers` | — | Extra headers for every request |
| `timeoutMs` | 30s management / 600s gateway | Non-streaming timeout |
| `streamIdleTimeoutMs` | 120s | Stream idle timeout |
| `maxRetries` | `0` | Retries after the first attempt |
| `retryNonIdempotent` | `false` | Allow POST/PATCH retries |
| `fetch` | global `fetch` | Custom fetch implementation |
| `signatureMode` | unset | `header`, `content` or `both` |
| `userAgent` | `crewrouter-sdk-node/0.1.0` | User-Agent header |
