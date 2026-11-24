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

	var tag crewrouter.UserKeyTag
	if err := json.Unmarshal([]byte(`{"id":3,"name":"prod","color":"#00aa00","sort_order":1,"created_at":"2026-01-01T00:00:00.000Z"}`), &tag); err != nil {
		t.Fatalf("decode user key tag: %v", err)
	}
	if tag.ID != 3 || tag.SortOrder != 1 {
		t.Fatalf("unexpected user key tag payload: %#v", tag)
	}

	var members crewrouter.ApiKeyMembersResponse
	if err := json.Unmarshal([]byte(`{"is_owner":true,"members":[{"id":9,"username":"member","email":"member@example.test","created_at":"2026-01-01T00:00:00.000Z"}]}`), &members); err != nil {
		t.Fatalf("decode API key members: %v", err)
	}
	if !members.IsOwner || len(members.Members) != 1 || members.Members[0].Username != "member" {
		t.Fatalf("unexpected API key members payload: %#v", members)
	}

	var warning crewrouter.ApiKeyQuotaWarning
	if err := json.Unmarshal([]byte(`{"quota_warning_enabled":true}`), &warning); err != nil {
		t.Fatalf("decode quota warning: %v", err)
	}
	if !warning.QuotaWarningEnabled {
		t.Fatalf("unexpected quota warning payload: %#v", warning)
	}

	var schedule crewrouter.ApiKeySchedule
	if err := json.Unmarshal([]byte(`{"schedule_enabled":false,"schedule_on_time":null,"schedule_off_time":null,"schedule_days":[0,1,2,3,4,5,6],"schedule_timezone":"Asia/Shanghai"}`), &schedule); err != nil {
		t.Fatalf("decode schedule: %v", err)
	}
	if schedule.ScheduleOnTime != nil || len(schedule.ScheduleDays) != 7 {
		t.Fatalf("unexpected schedule payload: %#v", schedule)
	}

	var current crewrouter.CurrentModelResponse
	if err := json.Unmarshal([]byte(`{"currentModel":null}`), &current); err != nil {
		t.Fatalf("decode current model: %v", err)
	}
	if current.CurrentModel != nil {
		t.Fatalf("expected no current model, got %#v", current.CurrentModel)
	}

	var usageLogs crewrouter.UserUsageLogsResponse
	if err := json.Unmarshal([]byte(`{"total":1,"page":1,"logs":[{"id":1,"user_id":7,"model_id":null,"api_key_id":3,"tokens_used":"12","prompt_tokens":"10","completion_tokens":"2","cached_tokens":"0","provider_id":null,"request_type":"chat","request_source":"unknown","user_agent":null,"latency_ms":"25","ip_address":null,"cost":"0.01","created_at":"2026-01-01T00:00:00Z","key_prefix":"sk-test","key_name":"CI","series":null,"model_name":"Model","upstream_model_id":null,"requested_model":null,"resolved_model":null,"response_model":null,"provider_name":null}]}`), &usageLogs); err != nil {
		t.Fatalf("decode usage logs: %v", err)
	}
	if usageLogs.Total != 1 || usageLogs.Logs[0].TokensUsed != "12" {
		t.Fatalf("unexpected usage log response: %#v", usageLogs)
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
