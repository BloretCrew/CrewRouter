package crewrouter

// StatsFilterOption is a model, provider, or request-source filter choice.
type StatsFilterOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// StatsFilterTeam is a Team filter choice.
type StatsFilterTeam struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// UserStatsFiltersResponse contains the filter values available to a user.
type UserStatsFiltersResponse struct {
	Sources   []StatsFilterOption `json:"sources"`
	Models    []StatsFilterOption `json:"models"`
	Providers []StatsFilterOption `json:"providers"`
	Teams     []StatsFilterTeam   `json:"teams"`
}

// AdminUser is one administrator-visible user row.
type AdminUser struct {
	ID            int64   `json:"id"`
	Username      string  `json:"username"`
	Email         *string `json:"email"`
	EmailVerified bool    `json:"email_verified"`
	Avatar        *string `json:"avatar"`
	Balance       any     `json:"balance"`
	RefundBalance any     `json:"refund_balance"`
	IsAdmin       bool    `json:"is_admin"`
	Tags          any     `json:"tags"`
	RateLimitRPM  int     `json:"rate_limit_rpm"`
	RateLimitTPM  int64   `json:"rate_limit_tpm"`
	CreatedAt     string  `json:"created_at"`
	TeamID        *int64  `json:"team_id"`
	TeamName      *string `json:"team_name"`
}

// AdminProviderTag is a global provider tag returned to provider managers.
type AdminProviderTag struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	SortOrder int    `json:"sort_order"`
	CreatedAt string `json:"created_at"`
}

// TeamMember is one user returned in an administrator Team membership list.
type TeamMember struct {
	ID        int64   `json:"id"`
	Username  string  `json:"username"`
	Email     *string `json:"email"`
	Avatar    *string `json:"avatar"`
	CreatedAt string  `json:"created_at"`
}

// AdminProduct is one product returned to administrator clients.
type AdminProduct struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Price       any     `json:"price"`
	ImageURL    *string `json:"image_url"`
	Link        *string `json:"link"`
	IsActive    bool    `json:"is_active"`
	SortOrder   int     `json:"sort_order"`
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
}

// AdminUserStats summarizes the filtered administrator user list.
type AdminUserStats struct {
	AdminCount    int     `json:"adminCount"`
	VerifiedCount int     `json:"verifiedCount"`
	TotalBalance  float64 `json:"totalBalance"`
}

// AdminUsersPage is returned when the page query parameter is supplied.
type AdminUsersPage struct {
	Items []AdminUser    `json:"items"`
	Total int            `json:"total"`
	Page  int            `json:"page"`
	Limit int            `json:"limit"`
	Stats AdminUserStats `json:"stats"`
}

// Decode the unpaged array response into []AdminUser and the paged response into AdminUsersPage.

// ApiKeyTag is a tag attached to an API key.
type ApiKeyTag struct {
	ID    any    `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color,omitempty"`
}

// ApiKeyTagsResponse is returned after assigning tags to an API Key.
type ApiKeyTagsResponse struct {
	Tags []ApiKeyTag `json:"tags"`
}

// ApiKeyModelQueueItem describes an API key's ordered model binding.
type ApiKeyQueueItem struct {
	ModelID   string  `json:"model_id"`
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Provider  *string `json:"provider"`
	Series    *string `json:"series"`
	IconURL   *string `json:"icon_url"`
	SortOrder int     `json:"sort_order"`
}

// ApiKeyModelQueueItem is retained as a source-compatible alias.
type ApiKeyModelQueueItem = ApiKeyQueueItem

// ApiKeyListItem is the stable common shape returned by GET /api/user/api-keys.
// KeyValue is intentionally nullable: the server redacts secrets unless the
// caller has keys.secret and owns the key.
type ApiKeyListItem struct {
	ID                           any               `json:"id"`
	Name                         string            `json:"name"`
	KeyGroup                     string            `json:"key_group,omitempty"`
	KeyPrefix                    *string           `json:"key_prefix,omitempty"`
	KeyValue                     *string           `json:"key_value"`
	Permissions                  []string          `json:"permissions"`
	CurrentModelID               *string           `json:"current_model_id,omitempty"`
	CurrentModelName             *string           `json:"current_model_name,omitempty"`
	CurrentModelProviderName     *string           `json:"current_model_provider_name,omitempty"`
	CurrentModelTestOK           *bool             `json:"current_model_test_ok,omitempty"`
	CurrentModelTestLatencyMS    *int              `json:"current_model_test_latency_ms,omitempty"`
	CurrentModelTestTokensPerSec *float64          `json:"current_model_test_tokens_per_second,omitempty"`
	CurrentModelTestTestedAt     *string           `json:"current_model_test_tested_at,omitempty"`
	Enabled                      bool              `json:"enabled"`
	ExpiresAt                    *string           `json:"expires_at,omitempty"`
	CreatedAt                    *string           `json:"created_at,omitempty"`
	LastUsedAt                   *string           `json:"last_used_at,omitempty"`
	TotalTokens                  any               `json:"total_tokens,omitempty"`
	TotalCost                    any               `json:"total_cost,omitempty"`
	TotalRequests                any               `json:"total_requests,omitempty"`
	Tags                         []ApiKeyTag       `json:"tags"`
	ModelQueue                   []ApiKeyQueueItem `json:"model_queue"`
	HarnessModels                []map[string]any  `json:"harness_models,omitempty"`
	RequestModelBindings         []map[string]any  `json:"request_model_bindings,omitempty"`
	Owner                        map[string]any    `json:"owner,omitempty"`
	Members                      []map[string]any  `json:"members,omitempty"`
	MemberCount                  int               `json:"member_count,omitempty"`
	IsOwner                      bool              `json:"is_owner,omitempty"`
	IsCoKey                      bool              `json:"is_co_key,omitempty"`
	KeyType                      string            `json:"key_type,omitempty"`
	CoKeyRole                    *string           `json:"co_key_role,omitempty"`
	CustomModelName              string            `json:"custom_model_name,omitempty"`
	IsSystem                     bool              `json:"is_system,omitempty"`
	SignatureEnabled             bool              `json:"signature_enabled,omitempty"`
	SignatureTemplate            string            `json:"signature_template,omitempty"`
	APISignatureEnabled          bool              `json:"api_signature_enabled,omitempty"`
	APISignatureTemplate         string            `json:"api_signature_template,omitempty"`
	QuotaWarningEnabled          bool              `json:"quota_warning_enabled,omitempty"`
	SwallowImages                bool              `json:"swallow_images,omitempty"`
	CrewRouterCommands           bool              `json:"crewrouter_commands,omitempty"`
	ScheduleEnabled              bool              `json:"schedule_enabled,omitempty"`
	ScheduleOnTime               *string           `json:"schedule_on_time,omitempty"`
	ScheduleOffTime              *string           `json:"schedule_off_time,omitempty"`
	ScheduleDays                 []int             `json:"schedule_days,omitempty"`
	ScheduleTimezone             *string           `json:"schedule_timezone,omitempty"`
}

// ApiKeyDailyUsageItem is one grouped usage row for a single API key.
type ApiKeyDailyUsageItem struct {
	Date      string  `json:"date"`
	ModelID   string  `json:"model_id"`
	ModelName *string `json:"model_name"`
	Tokens    any     `json:"tokens"`
	Cost      any     `json:"cost"`
	Requests  any     `json:"requests"`
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

// ApiKeyMember is one member of a Co-Key.
type ApiKeyMember struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	Email     string `json:"email"`
	CreatedAt string `json:"created_at"`
}

// UserUsageLog is one user-visible request record returned in usage logs.
type UserUsageLog struct {
	ID               int64   `json:"id"`
	UserID           int64   `json:"user_id"`
	ModelID          *string `json:"model_id"`
	APIKeyID         *int64  `json:"api_key_id"`
	TokensUsed       any     `json:"tokens_used"`
	PromptTokens     any     `json:"prompt_tokens"`
	CompletionTokens any     `json:"completion_tokens"`
	CachedTokens     any     `json:"cached_tokens"`
	ProviderID       *string `json:"provider_id"`
	RequestType      *string `json:"request_type"`
	RequestSource    string  `json:"request_source"`
	UserAgent        *string `json:"user_agent"`
	LatencyMS        any     `json:"latency_ms"`
	IPAddress        *string `json:"ip_address"`
	Cost             any     `json:"cost"`
	CreatedAt        string  `json:"created_at"`
	KeyPrefix        *string `json:"key_prefix"`
	KeyName          *string `json:"key_name"`
	Series           *string `json:"series"`
	ModelName        *string `json:"model_name"`
	UpstreamModelID  *string `json:"upstream_model_id"`
	RequestedModel   *string `json:"requested_model"`
	ResolvedModel    *string `json:"resolved_model"`
	ResponseModel    *string `json:"response_model"`
	ProviderName     *string `json:"provider_name"`
}

// UserUsageLogDetail contains a user's full request record. Messages and Response
// are opaque upstream JSON and may be large or sensitive; avoid logging them.
type UserUsageLogDetail struct {
	UserUsageLog
	IsStream             *bool   `json:"is_stream"`
	TTFTMS               any     `json:"ttft_ms"`
	UpstreamFirstByteMS  any     `json:"upstream_first_byte_ms"`
	GenerationMS         any     `json:"generation_ms"`
	TPOTMS               any     `json:"tpot_ms"`
	OutputTPS            any     `json:"output_tps"`
	E2EMS                any     `json:"e2e_ms"`
	UpstreamProcessingMS any     `json:"upstream_processing_ms"`
	ServiceTier          *string `json:"service_tier"`
	RateLimit            any     `json:"rate_limit"`
	Messages             any     `json:"messages"`
	Response             any     `json:"response"`
}

// UserUsageLogDetailResponse wraps one detailed user-owned usage record.
type UserUsageLogDetailResponse struct {
	Log UserUsageLogDetail `json:"log"`
}

// UserUsageLogsResponse is the paginated response from GET /api/user/usage-logs.
type UserUsageLogsResponse struct {
	Total int64          `json:"total"`
	Page  int            `json:"page"`
	Logs  []UserUsageLog `json:"logs"`
}

// CurrentModel is the selected model summary returned by the current-model API.
type CurrentModel struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Provider    string  `json:"provider"`
	Series      *string `json:"series"`
	Description *string `json:"description"`
}

// CurrentModelResponse wraps the selected model, which can be null.
type CurrentModelResponse struct {
	CurrentModel *CurrentModel `json:"currentModel"`
}

// ApiKeySchedule is returned by GET /api/user/api-keys/:id/schedule.
type ApiKeySchedule struct {
	ScheduleEnabled  bool    `json:"schedule_enabled"`
	ScheduleOnTime   *string `json:"schedule_on_time"`
	ScheduleOffTime  *string `json:"schedule_off_time"`
	ScheduleDays     []int   `json:"schedule_days"`
	ScheduleTimezone string  `json:"schedule_timezone"`
}

// ApiKeyQuotaWarning is returned by the API Key quota-warning setting routes.
type ApiKeyQuotaWarning struct {
	QuotaWarningEnabled bool `json:"quota_warning_enabled"`
}

// ApiKeyModelsResponse is returned by GET /api/user/api-keys/:id/models.
type ApiKeyModelsResponse struct {
	Models []ApiKeyAvailableModel `json:"models"`
	Queue  []ApiKeyQueueItem      `json:"queue"`
}

// ApiKeyHarnessModel is one independently bound API Key model.
type ApiKeyHarnessModel struct {
	Harness      string `json:"harness"`
	ModelID      string `json:"model_id"`
	Name         string `json:"name"`
	ProviderName string `json:"provider_name"`
	Label        string `json:"label"`
}

// AvailableHarness describes a supported client harness.
type AvailableHarness struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// RequestModelBinding is one request-model-name mapping for an API Key.
type RequestModelBinding struct {
	RequestModelName string  `json:"request_model_name"`
	Harness          *string `json:"harness"`
	ModelID          string  `json:"model_id"`
	Name             string  `json:"name"`
	ProviderName     string  `json:"provider_name"`
}

// RequestModelBindingTarget is a model available for request-name mapping.
type RequestModelBindingTarget struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Alias           *string `json:"alias"`
	UpstreamModelID *string `json:"upstream_model_id"`
}

// ApiKeyRequestModelBindingsResponse is returned by the API Key request-name mapping route.
type ApiKeyRequestModelBindingsResponse struct {
	Bindings           []RequestModelBinding       `json:"bindings"`
	Models             []RequestModelBindingTarget `json:"models"`
	AvailableHarnesses []AvailableHarness          `json:"available_harnesses"`
}

// ApiKeyHarnessModelsResponse is returned by GET /api/user/api-keys/:id/harness-models.
type ApiKeyHarnessModelsResponse struct {
	HarnessModels      []ApiKeyHarnessModel `json:"harness_models"`
	AvailableHarnesses []AvailableHarness   `json:"available_harnesses"`
}

// ApiKeyFusionConfig is the resolved Fusion setting for an API Key.
type ApiKeyFusionConfig struct {
	PanelModels                  []string `json:"panel_models"`
	JudgeModelID                 string   `json:"judge_model_id"`
	OuterModelID                 string   `json:"outer_model_id"`
	FusionEnabled                bool     `json:"fusion_enabled"`
	FusionSynthesisPromptEnabled bool     `json:"fusion_synthesis_prompt_enabled"`
}

// ApiKeyFusionConfigPut is the accepted Fusion configuration replacement.
type ApiKeyFusionConfigPut struct {
	PanelModels                  []string `json:"panel_models"`
	JudgeModelID                 string   `json:"judge_model_id,omitempty"`
	OuterModelID                 string   `json:"outer_model_id,omitempty"`
	FusionEnabled                *bool    `json:"fusion_enabled,omitempty"`
	FusionSynthesisPromptEnabled *bool    `json:"fusion_synthesis_prompt_enabled,omitempty"`
}

// ApiKeyActionSuccess is the standard successful mutation response.
type ApiKeyActionSuccess struct {
	Success bool `json:"success"`
}

// ApiKeyClaudeConfig contains a generated configuration including the API Key secret.
// Treat ANTHROPIC_AUTH_TOKEN as a credential: never log, persist, or expose it.
type ApiKeyClaudeConfig struct {
	Env         ApiKeyClaudeConfigEnv `json:"env"`
	Model       string                `json:"model"`
	EffortLevel string                `json:"effortLevel"`
}

// ApiKeyClaudeConfigEnv contains environment variables for Claude Code.
type ApiKeyClaudeConfigEnv struct {
	AnthropicBaseURL            string `json:"ANTHROPIC_BASE_URL"`
	AnthropicAuthToken          string `json:"ANTHROPIC_AUTH_TOKEN"`
	AnthropicModel              string `json:"ANTHROPIC_MODEL"`
	AnthropicDefaultHaikuModel  string `json:"ANTHROPIC_DEFAULT_HAIKU_MODEL"`
	AnthropicDefaultSonnetModel string `json:"ANTHROPIC_DEFAULT_SONNET_MODEL"`
	AnthropicDefaultOpusModel   string `json:"ANTHROPIC_DEFAULT_OPUS_MODEL"`
}

// ApiKeyEnabledUpdateResponse is returned after toggling an API Key.
type ApiKeyEnabledUpdateResponse struct {
	Success bool `json:"success"`
	Enabled bool `json:"enabled"`
}

// ApiKeySwallowImagesUpdateResponse is returned after changing image forwarding behavior.
type ApiKeySwallowImagesUpdateResponse struct {
	Success       bool `json:"success"`
	SwallowImages bool `json:"swallow_images"`
}

// ApiKeyCommandsUpdateResponse is returned after changing CrewRouter command access.
type ApiKeyCommandsUpdateResponse struct {
	Success            bool `json:"success"`
	CrewRouterCommands bool `json:"crewrouter_commands"`
}

// ApiKeyModelsUpdateResponse is returned after replacing an API Key model queue.
type ApiKeyModelsUpdateResponse struct {
	Success        bool     `json:"success"`
	ModelIDs       []string `json:"modelIds"`
	CurrentModelID *string  `json:"current_model_id"`
}

// ApiKeyAvailableModel is an enabled model available to the owning user's Teams.
type ApiKeyAvailableModel struct {
	ID                     string  `json:"id"`
	Name                   string  `json:"name"`
	Provider               string  `json:"provider"`
	Series                 *string `json:"series"`
	Description            *string `json:"description"`
	Enabled                bool    `json:"enabled"`
	IconURL                *string `json:"icon_url"`
	InputPricePer1KTokens  any     `json:"input_price_per_1k_tokens"`
	OutputPricePer1KTokens any     `json:"output_price_per_1k_tokens"`
	Assigned               bool    `json:"assigned"`
	SortOrder              *int    `json:"sort_order"`
}

// ApiKeyMembersResponse is returned by GET /api/user/api-keys/:id/members.
type ApiKeyMembersResponse struct {
	IsOwner bool           `json:"is_owner"`
	Members []ApiKeyMember `json:"members"`
}

// UserKeyTag is one API Key tag returned by the user key-tags routes.
type UserKeyTag struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	SortOrder int    `json:"sort_order"`
	CreatedAt string `json:"created_at"`
}

// ModelUptimeSummaryItem is one model's aggregated availability summary.
type ModelUptimeSummaryItem struct {
	UptimePct    *float64 `json:"uptime_pct"`
	Label        string   `json:"label"`
	TotalSuccess int64    `json:"total_success"`
	TotalFail    int64    `json:"total_fail"`
	Spark        []string `json:"spark"`
}

// ModelUptimeDetailPoint is one day or 15-minute slot in a model detail response.
type ModelUptimeDetailPoint struct {
	Date    string `json:"date"`
	Status  string `json:"status"`
	Success int64  `json:"success"`
	Fail    int64  `json:"fail"`
}

// ModelUptimeDetailResponse supports daily and 15-minute detail variants.
type ModelUptimeDetailResponse struct {
	ModelID      string                   `json:"model_id"`
	UptimePct    *float64                 `json:"uptime_pct"`
	Label        string                   `json:"label"`
	TotalSuccess int64                    `json:"total_success"`
	TotalFail    int64                    `json:"total_fail"`
	Granularity  string                   `json:"granularity"`
	Hours        *int                     `json:"hours,omitempty"`
	Slots        *int                     `json:"slots,omitempty"`
	Days         []ModelUptimeDetailPoint `json:"days"`
}

// ModelUptimeResponse supports daily and 15-minute aggregate variants.
type ModelUptimeResponse struct {
	Days        int                               `json:"days"`
	Hours       *int                              `json:"hours,omitempty"`
	Slots       *int                              `json:"slots,omitempty"`
	Granularity string                            `json:"granularity"`
	Items       map[string]ModelUptimeSummaryItem `json:"items"`
}

// ProviderTag is one globally defined provider tag visible to signed-in users.
type ProviderTag struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	SortOrder int    `json:"sort_order"`
}

// UserCodeBalanceItem is one refundable redemption-code balance row.
type UserCodeBalanceItem struct {
	Amount     any    `json:"amount"`
	FeeRate    any    `json:"fee_rate"`
	Code       string `json:"code"`
	CodeAmount any    `json:"code_amount"`
	NetAmount  any    `json:"net_amount"`
}

// UserProduct is one active product returned by GET /api/user/products.
type UserProduct struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	ImageURL    *string `json:"image_url"`
	Link        *string `json:"link"`
	SortOrder   int     `json:"sort_order"`
}

// UserProviderListItem is one user-visible provider returned by GET /api/user/providers.
type UserProviderListItem struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Format    string `json:"format"`
	CreatedBy *int64 `json:"created_by"`
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
