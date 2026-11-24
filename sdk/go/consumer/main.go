package main

import (
	"context"

	crewrouter "github.com/BloretCrew/CrewRouter/sdk/go"
)

func NewClient(baseURL, apiKey string) (*crewrouter.Client, error) {
	return crewrouter.New(crewrouter.Options{BaseURL: baseURL, APIKey: apiKey})
}

func main() {
	client, err := NewClient("https://example.invalid", "sk-test")
	if err != nil {
		panic(err)
	}
	chat := crewrouter.ChatCompletionRequest{Messages: []crewrouter.ChatMessage{{Role: "user", Content: "hello"}}}
	anthropic := crewrouter.AnthropicMessagesRequest{MaxTokens: 64, Messages: []crewrouter.ChatMessage{{Role: "user", Content: "hello"}}}
	responses := crewrouter.OpenAIResponsesRequest{Input: "hello"}
	var _ func(context.Context, crewrouter.ChatCompletionRequest, ...crewrouter.CallOptions) (*crewrouter.Response, error) = client.Gateway.Chat.Completions.Create
	var _ func(context.Context, crewrouter.AnthropicMessagesRequest, ...crewrouter.CallOptions) (*crewrouter.Response, error) = client.Gateway.Messages.Create
	var _ func(context.Context, crewrouter.OpenAIResponsesRequest, ...crewrouter.CallOptions) (*crewrouter.Response, error) = client.Gateway.Responses.Create
	_ = chat
	_ = anthropic
	_ = responses
}
