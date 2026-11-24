package crewrouter_test

import (
	"context"
	"testing"

	crewrouter "github.com/BloretCrew/CrewRouter/sdk/go"
)

func TestExportedTypedGatewayRequestsCompile(t *testing.T) {
	client, err := crewrouter.New(crewrouter.Options{BaseURL: "https://example.invalid", APIKey: "sk-test"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	chatRequest := crewrouter.ChatCompletionRequest{
		Messages: []crewrouter.ChatMessage{{Role: "user", Content: "hello"}},
	}
	anthropicRequest := crewrouter.AnthropicMessagesRequest{
		MaxTokens: 64,
		Messages:  []crewrouter.ChatMessage{{Role: "user", Content: "hello"}},
	}
	responsesRequest := crewrouter.OpenAIResponsesRequest{Input: "hello"}
	var chatCreate func(context.Context, crewrouter.ChatCompletionRequest, ...crewrouter.CallOptions) (*crewrouter.Response, error) = client.Gateway.Chat.Completions.Create
	var messagesCreate func(context.Context, crewrouter.AnthropicMessagesRequest, ...crewrouter.CallOptions) (*crewrouter.Response, error) = client.Gateway.Messages.Create
	var responsesCreate func(context.Context, crewrouter.OpenAIResponsesRequest, ...crewrouter.CallOptions) (*crewrouter.Response, error) = client.Gateway.Responses.Create
	_ = chatCreate
	_ = messagesCreate
	_ = responsesCreate
	_ = chatRequest
	_ = anthropicRequest
	_ = responsesRequest
}
