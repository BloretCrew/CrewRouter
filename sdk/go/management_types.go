package crewrouter

// ApiKeyTag is a tag attached to an API key.
type ApiKeyTag struct {
	ID    any    `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color,omitempty"`
}

// ApiKeyModelQueueItem describes an API key's ordered model binding.
type ApiKeyModelQueueItem struct {
	ModelID  string `json:"model_id"`
	Name     string `json:"name,omitempty"`
	Provider string `json:"provider,omitempty"`
}

// ApiKeyListItem is the stable common shape returned by GET /api/user/api-keys.
// KeyValue is intentionally nullable: the server redacts secrets unless the
// caller has keys.secret and owns the key.
type ApiKeyListItem struct {
	ID                           any                    `json:"id"`
	Name                         string                 `json:"name"`
	KeyGroup                     string                 `json:"key_group,omitempty"`
	KeyPrefix                    *string                `json:"key_prefix,omitempty"`
	KeyValue                     *string                `json:"key_value"`
	Permissions                  []string               `json:"permissions"`
	CurrentModelID               *string                `json:"current_model_id,omitempty"`
	CurrentModelName             *string                `json:"current_model_name,omitempty"`
	CurrentModelProviderName     *string                `json:"current_model_provider_name,omitempty"`
	CurrentModelTestOK           *bool                  `json:"current_model_test_ok,omitempty"`
	CurrentModelTestLatencyMS    *int                   `json:"current_model_test_latency_ms,omitempty"`
	CurrentModelTestTokensPerSec *float64               `json:"current_model_test_tokens_per_second,omitempty"`
	CurrentModelTestTestedAt     *string                `json:"current_model_test_tested_at,omitempty"`
	Enabled                      bool                   `json:"enabled"`
	ExpiresAt                    *string                `json:"expires_at,omitempty"`
	CreatedAt                    *string                `json:"created_at,omitempty"`
	LastUsedAt                   *string                `json:"last_used_at,omitempty"`
	TotalTokens                  any                    `json:"total_tokens,omitempty"`
	TotalCost                    any                    `json:"total_cost,omitempty"`
	TotalRequests                any                    `json:"total_requests,omitempty"`
	Tags                         []ApiKeyTag            `json:"tags"`
	ModelQueue                   []ApiKeyModelQueueItem `json:"model_queue"`
	HarnessModels                []map[string]any       `json:"harness_models,omitempty"`
	RequestModelBindings         []map[string]any       `json:"request_model_bindings,omitempty"`
	Owner                        map[string]any         `json:"owner,omitempty"`
	Members                      []map[string]any       `json:"members,omitempty"`
	MemberCount                  int                    `json:"member_count,omitempty"`
	IsOwner                      bool                   `json:"is_owner,omitempty"`
	IsCoKey                      bool                   `json:"is_co_key,omitempty"`
	KeyType                      string                 `json:"key_type,omitempty"`
	CoKeyRole                    *string                `json:"co_key_role,omitempty"`
	CustomModelName              string                 `json:"custom_model_name,omitempty"`
	IsSystem                     bool                   `json:"is_system,omitempty"`
	SignatureEnabled             bool                   `json:"signature_enabled,omitempty"`
	SignatureTemplate            string                 `json:"signature_template,omitempty"`
	APISignatureEnabled          bool                   `json:"api_signature_enabled,omitempty"`
	APISignatureTemplate         string                 `json:"api_signature_template,omitempty"`
	QuotaWarningEnabled          bool                   `json:"quota_warning_enabled,omitempty"`
	SwallowImages                bool                   `json:"swallow_images,omitempty"`
	CrewRouterCommands           bool                   `json:"crewrouter_commands,omitempty"`
	ScheduleEnabled              bool                   `json:"schedule_enabled,omitempty"`
	ScheduleOnTime               *string                `json:"schedule_on_time,omitempty"`
	ScheduleOffTime              *string                `json:"schedule_off_time,omitempty"`
	ScheduleDays                 []int                  `json:"schedule_days,omitempty"`
	ScheduleTimezone             *string                `json:"schedule_timezone,omitempty"`
}

// DailyUsageItem is one row in GET /api/user/usage.
type DailyUsageItem struct {
	Date          string `json:"date"`
	TotalTokens   any    `json:"total_tokens"`
	TotalCost     any    `json:"total_cost"`
	TotalRequests any    `json:"total_requests"`
}

// TeamQuotaRule is a quota rule returned with the balance summary.
type TeamQuotaRule struct {
	RuleType      string `json:"rule_type"`
	LimitValue    any    `json:"limit_value,omitempty"`
	DurationHours int    `json:"duration_hours,omitempty"`
	Current       any    `json:"current,omitempty"`
}

// UserBalance is returned by GET /api/user/balance.
type UserBalance struct {
	Balance       float64       `json:"balance"`
	RefundBalance float64       `json:"refund_balance"`
	RateLimitRPM  int           `json:"rate_limit_rpm"`
	RateLimitTPM  int64         `json:"rate_limit_tpm"`
	Group         *BalanceGroup `json:"group"`
}

// BalanceGroup contains the optional team quota configuration.
type BalanceGroup struct {
	ID          any             `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Rules       []TeamQuotaRule `json:"rules"`
}

// UserModelListItem is one model returned by GET /api/user/models.
type UserModelListItem struct {
	ID                     string  `json:"id"`
	UpstreamModelID        string  `json:"upstream_model_id"`
	Name                   string  `json:"name"`
	Alias                  *string `json:"alias"`
	Provider               string  `json:"provider"`
	ProviderName           string  `json:"provider_name"`
	InputPricePer1KTokens  any     `json:"input_price_per_1k_tokens"`
	OutputPricePer1KTokens any     `json:"output_price_per_1k_tokens"`
	OutputKind             string  `json:"output_kind"`
}
