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
