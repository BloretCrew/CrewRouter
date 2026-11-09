# Python quick start

## Install

```bash
pip install crewrouter-sdk
```

Requires Python >= 3.9. The only runtime dependency is `httpx`.

## Synchronous

```python
import os
from crewrouter import CrewRouter

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

Use `with CrewRouter(...) as client:` to close the connection.

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
created = client.keys.create({
    "name": "CI",
    "permissions": ["gateway.chat", "gateway.messages"],
})
client.keys.set_models(created.data["id"], {"models": ["claude-fable-5"]})

usage = client.usage.get({"days": 7})
balance = client.balance.get()

users = client.call("admin.users.list", query={"page": 1})
provider = client.call("admin.providers.byId.get", path_params={"id": "openai-main"})
```

## Asynchronous

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

## Errors

```python
from crewrouter import CrewRouterPermissionError

try:
    client.keys.list()
except CrewRouterPermissionError as error:
    print(error.status, error.code, error.permission, error.request_id)
```

Full package documentation: [`sdk/python/README.md`](../../sdk/python/README.md).
