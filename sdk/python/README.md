# CrewRouter Python SDK

Official Python SDK for the CrewRouter AI model gateway. Current planned pre-release: **27.0 Beta** (`27.0.0b1`).


- OpenAI Chat Completions, Anthropic Messages and OpenAI Responses, including SSE streaming.
- Synchronous and asynchronous clients.
- Full management API coverage through the generated operation catalog.
- Typed convenience wrappers for API keys, usage, balance, models, providers and teams.

> **License:** GPL-3.0. See [LICENSE](./LICENSE).

## Install

```bash
pip install crewrouter-sdk
```

Requires Python >= 3.9. The only runtime dependency is `httpx`.

## Synchronous quick start

```python
import os
from crewrouter import CrewRouter, ApiKeyListItem, DailyUsageItem, UserBalance, UserModelListItem, UserProviderListItem, UserCodeBalanceItem, ProviderTag, ApiKeyMembersResponse

client = CrewRouter(
    base_url=os.environ["CREWROUTER_BASE_URL"],
    api_key=os.environ["CREWROUTER_API_KEY"],
)

response = client.gateway.chat.completions.create({
    "model": "claude-fable-5",  # accepted for compatibility; routing uses the key binding
    "messages": [{"role": "user", "content": "Hello!"}],
})
print(response.data)
```

Use the client as a context manager to close the HTTP connection:

```python
with CrewRouter(base_url=..., api_key=...) as client:
    ...
```

### Streaming

```python
with client.gateway.chat.completions.stream({
    "messages": [{"role": "user", "content": "Write a haiku"}],
}) as stream:
    for event in stream:
        if event.done:
            break
        print(event.event, event.parsed)
```

### Management

```python
keys = client.keys.list()
key_rows: list[ApiKeyListItem] = keys.data
# The server returns key_value=null unless this key has keys.secret permission.
usage = client.usage.get({"days": 7})
usage_rows: list[DailyUsageItem] = usage.data
balance = client.balance.get()
balance_summary: UserBalance = balance.data
models = client.models.list()
model_rows: list[UserModelListItem] = models.data
providers = client.providers.list()
provider_rows: list[UserProviderListItem] = providers.data
code_balances = client.call("user.codeBalances.list")
refundable_codes: list[UserCodeBalanceItem] = code_balances.data
provider_tags_response = client.call("user.providerTags.list")
provider_tags: list[ProviderTag] = provider_tags_response.data
membership = client.call("user.apiKeys.byId.members.list", path_params={"id": created.data["id"]})
membership_data: ApiKeyMembersResponse = membership.data

created = client.keys.create({
    "name": "CI",
    "expiresIn": 720,
    "permissions": ["gateway.chat", "gateway.messages"],
})
client.keys.set_models(created.data["id"], {"models": ["claude-fable-5"]})

```

Every non-session operation is reachable through `call`:

```python
users = client.call("admin.users.list", query={"page": 1})
provider = client.call("admin.providers.byId.get", path_params={"id": "openai-main"})
client.call("admin.providers.byId.refreshKey", path_params={"id": "openai-main"})
```

`client.operations` is the generated catalog, including each operation's
permission and auth modes. Session-only routes are present but cannot be called
with an API key.

## Asynchronous quick start

```python
import asyncio
from crewrouter import AsyncCrewRouter

async def main():
    async with AsyncCrewRouter(base_url=..., api_key=...) as client:
        response = await client.gateway.messages.create({
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": "Hello"}],
        })
        print(response.data)

        async with client.gateway.chat.completions.stream({
            "messages": [{"role": "user", "content": "Write a haiku"}],
        }) as stream:
            async for event in stream:
                if event.done:
                    break
                print(event.event, event.parsed)

asyncio.run(main())
```

## Authentication

- `api_key` defaults to `Authorization: Bearer sk-...`.
- `auth_style="x-api-key"` sends `x-api-key`.
- `oauth_token` (`crh_...`) is sent as a Bearer token and works on gateway/event
  endpoints only.
- Session cookies are not supported.

## Errors and retries

```python
from crewrouter import CrewRouterPermissionError, CrewRouterRateLimitError

try:
    client.keys.list()
except CrewRouterPermissionError as error:
    print(error.status, error.code, error.permission)
```

- `max_retries` defaults to `0`; retries can duplicate gateway billing.
- When enabled, only idempotent methods retry by default. Set
  `retry_non_idempotent=True` for POST/PATCH.
- `Retry-After` is honored.
- Errors expose `status`, `code`, `type`, `permission`, `request_id`,
  `retry_after` and `raw_body`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `base_url` | `CREWROUTER_BASE_URL` | Instance URL, with or without `/v1` |
| `api_key` | `CREWROUTER_API_KEY` | API key |
| `oauth_token` | — | `crh_...` token (gateway/events only) |
| `auth_style` | `bearer` | `bearer` or `x-api-key` |
| `headers` | — | Extra headers |
| `timeout` | 30s management / 600s gateway | Non-streaming timeout |
| `max_retries` | `0` | Retries after the first attempt |
| `retry_non_idempotent` | `False` | Allow POST/PATCH retries |
| `signature_mode` | unset | `header`, `content` or `both` |
| `transport` / `client` | — | Custom `httpx` transport/client (useful for tests) |

## Important gateway semantics

- The request body `model` is normally ignored; routing uses the API key binding.
  `fusion*` names are the exception.
- `GET /v1/models` is a virtual list, not the admin catalog.
- Gateway request bodies allow up to 50 MB; management requests allow 2 MB.
- Response signatures may appear in `X-CrewRouter-Signature` headers and, for
  human-readable responses, in the content.

## Tests

```bash
cd sdk/python
PYTHONPATH=src python3 -m unittest discover -s tests -v
# or, with pytest installed:
python3 -m pytest
```
