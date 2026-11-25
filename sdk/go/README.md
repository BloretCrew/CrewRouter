# CrewRouter Go SDK

Official Go SDK for the CrewRouter AI model gateway. Current planned pre-release: **27.0 Beta** (`v27.0.0-beta.3`).


- OpenAI Chat Completions, Anthropic Messages and OpenAI Responses, including SSE streaming.
- Full management API coverage through the generated operation catalog.
- Convenience wrappers for API keys, usage, balance, models, providers and teams.
- Standard library only (`net/http`, `context`, `encoding/json`, `bufio`); Go 1.22+.

> **License:** GPL-3.0. See [LICENSE](./LICENSE).

## Install

```bash
go get github.com/BloretCrew/CrewRouter/sdk/go
```

The module lives under `sdk/go`; release tags use `sdk/go/vX.Y.Z`.

## Quick start

```go
package main

import (
    "context"
    "fmt"
    "os"

    crewrouter "github.com/BloretCrew/CrewRouter/sdk/go"
)

func main() {
    client, err := crewrouter.New(crewrouter.Options{
        BaseURL: os.Getenv("CREWROUTER_BASE_URL"),
        APIKey:  os.Getenv("CREWROUTER_API_KEY"),
    })
    if err != nil {
        panic(err)
    }

    response, err := client.Gateway.Chat.Completions.Create(context.Background(), crewrouter.ChatCompletionRequest{
        Model: "claude-fable-5", // accepted for compatibility; routing uses the key binding
        Messages: []crewrouter.ChatMessage{{Role: "user", Content: "Hello!"}},
    })
    if err != nil {
        panic(err)
    }
    fmt.Println(response.Text())
}
```

## Streaming

```go
stream, err := client.Gateway.Chat.Completions.Stream(ctx, crewrouter.ChatCompletionRequest{
    Messages: []crewrouter.ChatMessage{{Role: "user", Content: "Write a haiku"}},
})
if err != nil {
    panic(err)
}
defer stream.Close()

for {
    event, err := stream.Next()
    if err == io.EOF {
        break
    }
    if err != nil {
        panic(err)
    }
    if event.Done {
        break
    }
    fmt.Println(event.Event, string(event.Parsed))
}
```

`StreamEvent` exposes `Event`, `Data`, `Parsed` (valid JSON only) and `Done`.

## Management API

```go
keys, err := client.Keys.List(ctx)
var keyRows []crewrouter.ApiKeyListItem
if err := keys.JSON(&keyRows); err != nil { panic(err) }
// KeyValue is nil unless the caller has keys.secret and owns the Key.

usage, err := client.Usage.Get(ctx, map[string]any{"days": 7})
var dailyUsage []crewrouter.DailyUsageItem
if err := usage.JSON(&dailyUsage); err != nil { panic(err) }

balance, err := client.Balance.Get(ctx)
var balanceSummary crewrouter.UserBalance
if err := balance.JSON(&balanceSummary); err != nil { panic(err) }

models, err := client.Models.List(ctx)
var visibleModels []crewrouter.UserModelListItem
if err := models.JSON(&visibleModels); err != nil { panic(err) }

providers, err := client.Providers.List(ctx)
var visibleProviders []crewrouter.UserProviderListItem
if err := providers.JSON(&visibleProviders); err != nil { panic(err) }

codeBalances, err := client.Call(ctx, "user.codeBalances.list", crewrouter.CallOptions{})
var refundableCodes []crewrouter.UserCodeBalanceItem
if err := codeBalances.JSON(&refundableCodes); err != nil { panic(err) }

providerTagsResponse, err := client.Call(ctx, "user.providerTags.list", crewrouter.CallOptions{})
var providerTags []crewrouter.ProviderTag
if err := providerTagsResponse.JSON(&providerTags); err != nil { panic(err) }

membership, err := client.Call(ctx, "user.apiKeys.byId.members.list", crewrouter.CallOptions{PathParams: map[string]any{"id": id}})
var memberList crewrouter.ApiKeyMembersResponse
if err := membership.JSON(&memberList); err != nil { panic(err) }

created, err := client.Keys.Create(ctx, map[string]any{
    "name":        "CI",
    "expiresIn":   720,
    "permissions": []string{"gateway.chat", "gateway.messages"},
})
modelsUpdated, err := client.Keys.SetModels(ctx, id, map[string]any{"modelIds": []string{"claude-fable-5"}})
var modelsUpdate crewrouter.ApiKeyModelsUpdateResponse
if err := modelsUpdated.JSON(&modelsUpdate); err != nil { panic(err) }

```

Every non-session operation is reachable through `Call`:

```go
users, err := client.Call(ctx, "admin.users.list", crewrouter.CallOptions{
    Query: map[string]any{"page": 1},
})
provider, err := client.Call(ctx, "admin.providers.byId.get", crewrouter.CallOptions{
    PathParams: map[string]any{"id": "openai-main"},
})
refreshed, err := client.Admin.Providers.RefreshKey(ctx, "openai-main")
```

`client.Operations` is the generated catalog. Session-only routes are present but
`Call` rejects them before sending a request.

## Response handling

```go
var payload map[string]any
if err := response.JSON(&payload); err != nil {
    panic(err)
}
fmt.Println(response.Status, response.RequestID, response.Signature)
```

## Errors

```go
var apiErr *crewrouter.APIError
if errors.As(err, &apiErr) {
    fmt.Println(apiErr.Status, apiErr.Code, apiErr.Permission, apiErr.RequestID)
}
```

- `maxRetries` defaults to `0`; retries can duplicate gateway billing.
- When enabled, only idempotent methods retry by default. Set
  `RetryNonIdempotent: true` for POST/PATCH.
- `Retry-After` is honored.
- `ConnectionError`, `TimeoutError`, `AbortError` and `StreamError` cover
  transport failures.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `BaseURL` | `CREWROUTER_BASE_URL` | Instance URL, with or without `/v1` |
| `APIKey` | `CREWROUTER_API_KEY` | API key |
| `OAuthToken` | — | `crh_...` token (gateway/events only) |
| `AuthStyle` | `bearer` | `bearer` or `x-api-key` |
| `Timeout` | 30s management / 600s gateway | Non-streaming timeout |
| `StreamIdleTimeout` | 120s | Stream idle timeout |
| `MaxRetries` | `0` | Retries after the first attempt |
| `RetryNonIdempotent` | `false` | Allow POST/PATCH retries |
| `SignatureMode` | — | `header`, `content` or `both` |
| `HTTPClient` | Same-origin redirects only | Custom HTTP clients retain their own redirect policy; configure `CheckRedirect` to protect credentials |
| `Sleep` | timer | Injectable sleep for tests |

## Important gateway semantics

- The request body `model` is normally ignored; routing uses the API key binding.
  `fusion*` names are the exception.
- `GET /v1/models` is a virtual list, not the admin catalog.
- Gateway request bodies allow up to 50 MB; management requests allow 2 MB.
- Response signatures may appear in `X-CrewRouter-Signature` headers and, for
  human-readable responses, in the content.

## Tests

```bash
cd sdk/go
go test ./...
go vet ./...
```
