package main

import (
	"encoding/json"
	"testing"

	crewrouter "github.com/BloretCrew/CrewRouter/sdk/go"
)

func TestManagementResponseTypesDecode(t *testing.T) {
	var key crewrouter.ApiKeyListItem
	if err := json.Unmarshal([]byte(`{"id":7,"name":"CI","key_value":null,"permissions":["keys.read"],"tags":[],"model_queue":[]}`), &key); err != nil {
		t.Fatalf("decode API key: %v", err)
	}
	if key.KeyValue != nil || len(key.Permissions) != 1 {
		t.Fatalf("unexpected API key payload: %#v", key)
	}

	var balance crewrouter.UserBalance
	if err := json.Unmarshal([]byte(`{"balance":10,"refund_balance":8,"rate_limit_rpm":60,"rate_limit_tpm":1000,"group":null}`), &balance); err != nil {
		t.Fatalf("decode balance: %v", err)
	}
	if balance.Group != nil || balance.RefundBalance != 8 {
		t.Fatalf("unexpected balance payload: %#v", balance)
	}

	var model crewrouter.UserModelListItem
	if err := json.Unmarshal([]byte(`{"id":"model-1","upstream_model_id":"upstream-1","name":"Model One","alias":null,"provider":"p1","provider_name":"Provider","input_price_per_1k_tokens":"0.01","output_price_per_1k_tokens":0.02,"output_kind":"chat"}`), &model); err != nil {
		t.Fatalf("decode user model: %v", err)
	}
	if model.Alias != nil || model.UpstreamModelID != "upstream-1" {
		t.Fatalf("unexpected user model payload: %#v", model)
	}

	var provider crewrouter.UserProviderListItem
	if err := json.Unmarshal([]byte(`{"id":"shared-provider","name":"Shared","format":"openai","created_by":null}`), &provider); err != nil {
		t.Fatalf("decode provider: %v", err)
	}
	if provider.CreatedBy != nil || provider.Format != "openai" {
		t.Fatalf("unexpected provider payload: %#v", provider)
	}
}

func TestSDKConsumerCompiles(t *testing.T) {
	client, err := NewClient("https://example.invalid", "sk-test")
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	if client.Gateway == nil || client.Gateway.Chat.Completions == nil {
		t.Fatal("Gateway.Chat.Completions is not initialized")
	}
}
