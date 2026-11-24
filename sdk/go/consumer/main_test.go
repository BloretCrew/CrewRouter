package main

import "testing"

func TestSDKConsumerCompiles(t *testing.T) {
	client, err := NewClient("https://example.invalid", "sk-test")
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	if client.Gateway == nil || client.Gateway.Chat.Completions == nil {
		t.Fatal("Gateway.Chat.Completions is not initialized")
	}
}
