# Integration guide

There are three ways to put CrewRouter in front of an application. Choose the
smallest one that solves your problem.

## 1. Keep your current OpenAI/Anthropic SDK

CrewRouter is wire-compatible with the official SDKs. Only the base URL and key
change.

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-host/v1",
    api_key="sk-your-key",
)
```

### Anthropic Python SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="https://your-host",
    api_key="sk-your-key",
)
```

### OpenAI Node SDK

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://your-host/v1',
  apiKey: process.env.CREWROUTER_API_KEY,
});
```

### Google Gen AI SDK (Gemini / Interactions)

Point the SDK at the gateway. `apiVersion` selects the `/v1beta` surface the
google-genai SDK expects; the API key is the CrewRouter key.

```python
from google import genai

client = genai.Client(
    api_key="sk-your-key",
    http_options={"base_url": "https://your-host"},
)

response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents="Hello",
)
print(response.text)
```

```python
interaction = client.interactions.create(
    model="gemini-2.5-flash",
    input="Hello",
)
print(interaction.output_text)
```

The gateway also accepts raw REST calls to
`/v1beta/models/{model}:generateContent`,
`:streamGenerateContent?alt=sse`, `:countTokens`, `/v1beta/models`, and
`/v1beta/interactions`. Gemini clients authenticate with `x-goog-api-key` or
`?key=`. The path `model` is advisory like the other protocols; actual routing
comes from the API key binding.

The request body `model` is normally ignored; routing comes from the API key
binding. See [docs/sdk/gateway.md](./sdk/gateway.md).

## 2. Use a CrewRouter SDK

Use this when you want streaming helpers, typed errors, retries, and management
API access in one client.

```bash
npm install @bloretcrew/crewrouter-sdk          # Node/TypeScript
pip install crewrouter-sdk          # Python
go get github.com/BloretCrew/CrewRouter/sdk/go
```

```ts
import { CrewRouter } from '@bloretcrew/crewrouter-sdk';

const client = new CrewRouter({
  baseUrl: process.env.CREWROUTER_BASE_URL,
  apiKey: process.env.CREWROUTER_API_KEY,
});

const response = await client.gateway.chat.completions.create({
  messages: [{ role: 'user', content: 'Hello' }],
});

const keys = await client.keys.list();
```

Documentation: [docs/sdk/README.md](./sdk/README.md).

## 3. Embed the gateway in a Node application (planned)

The embedded form runs CrewRouter in-process, without a separate service. It is
planned for Phase 2; the intended API is documented in
[docs/sdk/embedded-server.md](./sdk/embedded-server.md).

## Configure coding tools

The console can generate configuration for Claude Code, Codex, Grok Build,
OpenCode, Qwen Code, Hermes, OpenClaw and DeepSeek Harness. See
[desktop-client-config.md](./desktop-client-config.md).

## Choosing a key

| Need | Recommended key permissions |
| --- | --- |
| Call models only | default `gateway.*` |
| Read usage/balance | `gateway.*` + `usage.read` |
| Manage API keys | `gateway.*` + `keys.read` / `keys.write` |
| Automate the admin console | admin-owned key + the specific `admin.*` permissions |

Session-only endpoints cannot be automated with API keys. Use the browser console
for login, 2FA, passkey, setup, update, OAuth consent and model-trace jobs.

## Common pitfalls

- `model` does not select the upstream model.
- `/v1/models` is not the real catalog.
- New keys only get `gateway.*`.
- `admin.*` still requires an administrator owner.
- Gateway POST retries can duplicate billing; keep `maxRetries: 0` unless you
  accept that risk.
- There is no session-cookie mode in the SDK.

See [docs/sdk/troubleshooting.md](./sdk/troubleshooting.md).
