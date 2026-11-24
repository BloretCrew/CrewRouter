package crewrouter

import (
	"encoding/json"
	"fmt"
)

// ChatMessage is a message in a Chat Completions or Anthropic Messages request.
type ChatMessage struct {
	Role       string `json:"role"`
	Content    any    `json:"content,omitempty"`
	Name       string `json:"name,omitempty"`
	ToolCallID string `json:"tool_call_id,omitempty"`
}

// ChatCompletionRequest is the stable common subset of the Chat Completions
// request. Additional provider-specific fields may be supplied through Extra.
type ChatCompletionRequest struct {
	Model       string         `json:"model,omitempty"`
	Messages    []ChatMessage  `json:"messages"`
	Stream      bool           `json:"stream,omitempty"`
	Temperature *float64       `json:"temperature,omitempty"`
	MaxTokens   *int           `json:"max_tokens,omitempty"`
	Extra       map[string]any `json:"-"`
}

func (r ChatCompletionRequest) MarshalJSON() ([]byte, error) {
	value := map[string]any{"messages": r.Messages}
	if r.Model != "" {
		value["model"] = r.Model
	}
	if r.Stream {
		value["stream"] = true
	}
	if r.Temperature != nil {
		value["temperature"] = *r.Temperature
	}
	if r.MaxTokens != nil {
		value["max_tokens"] = *r.MaxTokens
	}
	return marshalRequest(value, r.Extra)
}

// AnthropicMessagesRequest is the stable common subset of an Anthropic Messages
// request. Additional provider-specific fields may be supplied through Extra.
type AnthropicMessagesRequest struct {
	Model       string         `json:"model,omitempty"`
	MaxTokens   int            `json:"max_tokens"`
	Messages    []ChatMessage  `json:"messages"`
	Stream      bool           `json:"stream,omitempty"`
	System      any            `json:"system,omitempty"`
	Temperature *float64       `json:"temperature,omitempty"`
	Extra       map[string]any `json:"-"`
}

func (r AnthropicMessagesRequest) MarshalJSON() ([]byte, error) {
	value := map[string]any{"max_tokens": r.MaxTokens, "messages": r.Messages}
	if r.Model != "" {
		value["model"] = r.Model
	}
	if r.Stream {
		value["stream"] = true
	}
	if r.System != nil {
		value["system"] = r.System
	}
	if r.Temperature != nil {
		value["temperature"] = *r.Temperature
	}
	return marshalRequest(value, r.Extra)
}

// OpenAIResponsesRequest is the stable common subset of a Responses request.
// Input accepts either a string or a structured provider-specific value.
type OpenAIResponsesRequest struct {
	Model        string         `json:"model,omitempty"`
	Input        any            `json:"input"`
	Stream       bool           `json:"stream,omitempty"`
	Instructions string         `json:"instructions,omitempty"`
	Temperature  *float64       `json:"temperature,omitempty"`
	Extra        map[string]any `json:"-"`
}

func (r OpenAIResponsesRequest) MarshalJSON() ([]byte, error) {
	value := map[string]any{"input": r.Input}
	if r.Model != "" {
		value["model"] = r.Model
	}
	if r.Stream {
		value["stream"] = true
	}
	if r.Instructions != "" {
		value["instructions"] = r.Instructions
	}
	if r.Temperature != nil {
		value["temperature"] = *r.Temperature
	}
	return marshalRequest(value, r.Extra)
}

func marshalRequest(value any, extra map[string]any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	for key, item := range extra {
		if _, exists := fields[key]; exists {
			return nil, fmt.Errorf("crewrouter: extra request field %q conflicts with a typed field", key)
		}
		fields[key] = item
	}
	return json.Marshal(fields)
}
