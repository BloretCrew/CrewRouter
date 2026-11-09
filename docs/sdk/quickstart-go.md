# Go quick start

## Install

```bash
go get github.com/BloretCrew/CrewRouter/sdk/go
```

Requires Go 1.22+. The module lives under `sdk/go`; release tags use
`sdk/go/vX.Y.Z`.

## Client

```go
import (
    "context"
    "os"

    crewrouter "github.com/BloretCrew/CrewRouter/sdk/go"
)

client, err := crewrouter.New(crewrouter.Options{
    BaseURL: os.Getenv("CREWROUTER_BASE_URL"),
    APIKey:  os.Getenv("CREWROUTER_API_KEY"),
})
if err != nil {
    panic(err)
}
```

## Chat Completions

```go
response, err := client.Gateway.Chat.Completions.Create(context.Background(), map[string]any{
    "model":    "claude-fable-5", // accepted for compatibility; routing uses the key binding
    "messages": []any{map[string]any{"role": "user", "content": "Hello!"}},
})
if err != nil {
    panic(err)
}

var payload map[string]any
if err := response.JSON(&payload); err != nil {
    panic(err)
}
```

## Streaming

```go
stream, err := client.Gateway.Chat.Completions.Stream(ctx, map[string]any{
    "messages": []any{map[string]any{"role": "user", "content": "Write a haiku"}},
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

## Management

```go
keys, err := client.Keys.List(ctx)
created, err := client.Keys.Create(ctx, map[string]any{
    "name":        "CI",
    "permissions": []string{"gateway.chat", "gateway.messages"},
})
client.Keys.SetModels(ctx, id, map[string]any{"models": []string{"claude-fable-5"}})

usage, err := client.Usage.Get(ctx, map[string]any{"days": 7})
balance, err := client.Balance.Get(ctx)

users, err := client.Call(ctx, "admin.users.list", crewrouter.CallOptions{
    Query: map[string]any{"page": 1},
})
refreshed, err := client.Admin.Providers.RefreshKey(ctx, "openai-main")
```

## Errors

```go
var apiErr *crewrouter.APIError
if errors.As(err, &apiErr) {
    fmt.Println(apiErr.Status, apiErr.Code, apiErr.Permission, apiErr.RequestID)
}
```

Full package documentation: [`sdk/go/README.md`](../../sdk/go/README.md).
