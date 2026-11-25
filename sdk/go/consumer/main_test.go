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
	var enabledResponse crewrouter.ApiKeyEnabledUpdateResponse
	if err := json.Unmarshal([]byte(`{"success":true,"enabled":true}`), &enabledResponse); err != nil || !enabledResponse.Enabled {
		t.Fatalf("decode enabled response: %#v, %v", enabledResponse, err)
	}
	var swallowResponse crewrouter.ApiKeySwallowImagesUpdateResponse
	if err := json.Unmarshal([]byte(`{"success":true,"swallow_images":false}`), &swallowResponse); err != nil || swallowResponse.SwallowImages {
		t.Fatalf("decode swallow-images response: %#v, %v", swallowResponse, err)
	}
	var commandsResponse crewrouter.ApiKeyCommandsUpdateResponse
	if err := json.Unmarshal([]byte(`{"success":true,"crewrouter_commands":true}`), &commandsResponse); err != nil || !commandsResponse.CrewRouterCommands {
		t.Fatalf("decode CrewRouter commands response: %#v, %v", commandsResponse, err)
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
	var usageDetail crewrouter.UserUsageLogDetailResponse
	if err := json.Unmarshal([]byte(`{"log":{"id":1,"user_id":7,"model_id":null,"api_key_id":3,"tokens_used":"12","prompt_tokens":"10","completion_tokens":"2","cached_tokens":"0","provider_id":null,"request_type":"chat","request_source":"unknown","user_agent":null,"latency_ms":"25","is_stream":false,"ttft_ms":null,"upstream_first_byte_ms":null,"generation_ms":null,"tpot_ms":null,"output_tps":null,"e2e_ms":null,"upstream_processing_ms":null,"service_tier":null,"rate_limit":null,"ip_address":null,"messages":[{"role":"user","content":"hi"}],"response":{"choices":[]},"cost":"0.01","created_at":"2026-01-01T00:00:00Z","key_prefix":"sk-test","key_name":"CI","series":null,"model_name":"Model","upstream_model_id":null,"requested_model":null,"resolved_model":null,"response_model":null,"provider_name":null}}`), &usageDetail); err != nil {
		t.Fatalf("decode usage log detail: %v", err)
	}
	if usageDetail.Log.ID != 1 || usageDetail.Log.Messages == nil {
		t.Fatalf("unexpected usage log detail payload: %#v", usageDetail)
	}

	var keyModels crewrouter.ApiKeyModelsResponse
	if err := json.Unmarshal([]byte(`{"models":[{"id":"m1","name":"Model","provider":"p1","series":"s1","description":null,"enabled":true,"icon_url":null,"input_price_per_1k_tokens":"0.01","output_price_per_1k_tokens":0.02,"assigned":true,"sort_order":0}],"queue":[{"model_id":"m1","id":"m1","name":"Model","provider":"p1","series":"s1","icon_url":null,"sort_order":0}]}`), &keyModels); err != nil {
		t.Fatalf("decode API key models: %v", err)
	}
	if len(keyModels.Queue) != 1 || keyModels.Queue[0].SortOrder != 0 || len(keyModels.Models) != 1 {
		t.Fatalf("unexpected API key models payload: %#v", keyModels)
	}
	var modelsUpdate crewrouter.ApiKeyModelsUpdateResponse
	if err := json.Unmarshal([]byte(`{"success":true,"modelIds":["m1"],"current_model_id":"m1"}`), &modelsUpdate); err != nil {
		t.Fatalf("decode API key models update: %v", err)
	}
	if !modelsUpdate.Success || modelsUpdate.CurrentModelID == nil || *modelsUpdate.CurrentModelID != "m1" {
		t.Fatalf("unexpected API key models update payload: %#v", modelsUpdate)
	}

	var statsFilters crewrouter.UserStatsFiltersResponse
	if err := json.Unmarshal([]byte(`{"sources":[{"id":"claude_code","name":"Claude Code"}],"models":[{"id":"m1","name":"Model"}],"providers":[{"id":"p1","name":"Provider"}],"teams":[{"id":2,"name":"Team"}]}`), &statsFilters); err != nil {
		t.Fatalf("decode user stats filters: %v", err)
	}
	if len(statsFilters.Sources) != 1 || statsFilters.Teams[0].ID != 2 {
		t.Fatalf("unexpected stats filters payload: %#v", statsFilters)
	}

	var legacyUsers []crewrouter.AdminUser
	if err := json.Unmarshal([]byte(`[{"id":9,"username":"alice","email":null,"email_verified":false,"avatar":null,"balance":"1.5","refund_balance":"0","is_admin":false,"tags":[],"rate_limit_rpm":0,"rate_limit_tpm":0,"created_at":"2026-01-01T00:00:00Z","team_id":null,"team_name":null}]`), &legacyUsers); err != nil {
		t.Fatalf("decode legacy admin users: %v", err)
	}
	var pagedUsers crewrouter.AdminUsersPage
	if err := json.Unmarshal([]byte(`{"items":[{"id":9,"username":"alice","email":null,"email_verified":false,"avatar":null,"balance":"1.5","refund_balance":"0","is_admin":false,"tags":[],"rate_limit_rpm":0,"rate_limit_tpm":0,"created_at":"2026-01-01T00:00:00Z","team_id":null,"team_name":null}],"total":1,"page":1,"limit":50,"stats":{"adminCount":0,"verifiedCount":0,"totalBalance":1.5}}`), &pagedUsers); err != nil {
		t.Fatalf("decode paged admin users: %v", err)
	}
	if len(legacyUsers) != 1 || pagedUsers.Total != 1 || pagedUsers.Stats.TotalBalance != 1.5 {
		t.Fatalf("unexpected admin user response: %#v / %#v", legacyUsers, pagedUsers)
	}
	var adminProducts []crewrouter.AdminProduct
	if err := json.Unmarshal([]byte(`[{"id":1,"name":"Product","description":null,"price":"2.5","image_url":null,"link":null,"is_active":true,"sort_order":0,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}]`), &adminProducts); err != nil {
		t.Fatalf("decode admin products: %v", err)
	}
	if len(adminProducts) != 1 || adminProducts[0].Price != "2.5" || adminProducts[0].Description != nil {
		t.Fatalf("unexpected admin product response: %#v", adminProducts)
	}
	var teamMembers []crewrouter.TeamMember
	if err := json.Unmarshal([]byte(`[{"id":9,"username":"alice","email":null,"avatar":null,"created_at":"2026-01-01T00:00:00Z"}]`), &teamMembers); err != nil {
		t.Fatalf("decode team members: %v", err)
	}
	if len(teamMembers) != 1 || teamMembers[0].Email != nil {
		t.Fatalf("unexpected Team member response: %#v", teamMembers)
	}

	var config crewrouter.ApiKeyClaudeConfig
	if err := json.Unmarshal([]byte(`{"env":{"ANTHROPIC_BASE_URL":"https://router.example","ANTHROPIC_AUTH_TOKEN":"sk-fixture-secret","ANTHROPIC_MODEL":"claude-fable-5","ANTHROPIC_DEFAULT_HAIKU_MODEL":"claude-fable-5","ANTHROPIC_DEFAULT_SONNET_MODEL":"claude-fable-5","ANTHROPIC_DEFAULT_OPUS_MODEL":"claude-fable-5"},"model":"claude-fable-5","effortLevel":"high"}`), &config); err != nil {
		t.Fatalf("decode API key config: %v", err)
	}
	if config.Env.AnthropicAuthToken == "" || config.Model != "claude-fable-5" {
		t.Fatal("API key config secret/model fields were not decoded")
	}
	var fusion crewrouter.ApiKeyFusionConfig
	if err := json.Unmarshal([]byte(`{"panel_models":["m1"],"judge_model_id":"","outer_model_id":"","fusion_enabled":true,"fusion_synthesis_prompt_enabled":true}`), &fusion); err != nil {
		t.Fatalf("decode Fusion config: %v", err)
	}
	if len(fusion.PanelModels) != 1 || !fusion.FusionEnabled {
		t.Fatalf("unexpected Fusion config: %#v", fusion)
	}
	var action crewrouter.ApiKeyActionSuccess
	if err := json.Unmarshal([]byte(`{"success":true}`), &action); err != nil || !action.Success {
		t.Fatalf("decode Fusion update response: %#v, %v", action, err)
	}

	var harnessModels crewrouter.ApiKeyHarnessModelsResponse
	if err := json.Unmarshal([]byte(`{"harness_models":[{"harness":"codex","model_id":"m1","name":"Model","provider_name":"Provider","label":"Codex"}],"available_harnesses":[{"id":"codex","label":"Codex"}]}`), &harnessModels); err != nil {
		t.Fatalf("decode API key harness models: %v", err)
	}
	if len(harnessModels.HarnessModels) != 1 || harnessModels.AvailableHarnesses[0].ID != "codex" {
		t.Fatalf("unexpected API key harness model response: %#v", harnessModels)
	}

	var requestBindings crewrouter.ApiKeyRequestModelBindingsResponse
	if err := json.Unmarshal([]byte(`{"bindings":[{"request_model_name":"fast","harness":null,"model_id":"m1","name":"Model","provider_name":"Provider"}],"models":[{"id":"m1","name":"Model","alias":null,"upstream_model_id":"upstream-m1"}],"available_harnesses":[{"id":"codex","label":"Codex"}]}`), &requestBindings); err != nil {
		t.Fatalf("decode request model bindings: %v", err)
	}
	if len(requestBindings.Bindings) != 1 || requestBindings.Bindings[0].Harness != nil || requestBindings.Models[0].UpstreamModelID == nil {
		t.Fatalf("unexpected request model bindings payload: %#v", requestBindings)
	}

	var products []crewrouter.UserProduct
	if err := json.Unmarshal([]byte(`[{"id":1,"name":"Product","description":null,"image_url":null,"link":null,"sort_order":0}]`), &products); err != nil {
		t.Fatalf("decode user products: %v", err)
	}
	if len(products) != 1 || products[0].Description != nil || products[0].SortOrder != 0 {
		t.Fatalf("unexpected products payload: %#v", products)
	}

	var codeBalances []crewrouter.UserCodeBalanceItem
	if err := json.Unmarshal([]byte(`[{"amount":"2.5","fee_rate":"0.1","code":"redeem-1","code_amount":"3","net_amount":"2.2727"}]`), &codeBalances); err != nil {
		t.Fatalf("decode code balances: %v", err)
	}
	if len(codeBalances) != 1 || codeBalances[0].Code != "redeem-1" || codeBalances[0].NetAmount != "2.2727" {
		t.Fatalf("unexpected code balances payload: %#v", codeBalances)
	}

	var providerTags []crewrouter.ProviderTag
	if err := json.Unmarshal([]byte(`[{"id":2,"name":"gateway","color":"#445566","sort_order":1}]`), &providerTags); err != nil {
		t.Fatalf("decode provider tags: %v", err)
	}
	if len(providerTags) != 1 || providerTags[0].SortOrder != 1 {
		t.Fatalf("unexpected provider tags payload: %#v", providerTags)
	}
	var assignedTags crewrouter.ApiKeyTagsResponse
	if err := json.Unmarshal([]byte(`{"tags":[{"id":2,"name":"prod","color":"#445566"}]}`), &assignedTags); err != nil {
		t.Fatalf("decode assigned API key tags: %v", err)
	}
	if len(assignedTags.Tags) != 1 || assignedTags.Tags[0].ID != float64(2) {
		t.Fatalf("unexpected assigned API key tags payload: %#v", assignedTags)
	}

	var uptime crewrouter.ModelUptimeResponse
	if err := json.Unmarshal([]byte(`{"days":1,"hours":24,"slots":96,"granularity":"15m","items":{"m1":{"uptime_pct":null,"label":"No data","total_success":0,"total_fail":0,"spark":["none"]}}}`), &uptime); err != nil {
		t.Fatalf("decode uptime response: %v", err)
	}
	if uptime.Granularity != "15m" || uptime.Hours == nil || *uptime.Hours != 24 || uptime.Items["m1"].UptimePct != nil {
		t.Fatalf("unexpected uptime payload: %#v", uptime)
	}

	var detail crewrouter.ModelUptimeDetailResponse
	if err := json.Unmarshal([]byte(`{"model_id":"m1","uptime_pct":null,"label":"No data","total_success":0,"total_fail":0,"granularity":"15m","hours":24,"slots":96,"days":[{"date":"2026-01-01T00:00:00.000Z","status":"none","success":0,"fail":0}]}`), &detail); err != nil {
		t.Fatalf("decode uptime detail: %v", err)
	}
	if detail.Granularity != "15m" || len(detail.Days) != 1 || detail.Days[0].Status != "none" {
		t.Fatalf("unexpected uptime detail payload: %#v", detail)
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
