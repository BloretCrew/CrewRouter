export type AuthStyle = 'bearer' | 'x-api-key';
export type SignatureMode = 'header' | 'content' | 'both';
export type ResponseType = 'json' | 'text' | 'arrayBuffer' | 'stream';

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean>;

export interface CrewRouterOptions {
  /** Gateway base URL, for example https://router.example.com (no /v1 suffix required). */
  baseUrl?: string;
  /** API Key (sk-...). Falls back to CREWROUTER_API_KEY. */
  apiKey?: string;
  /** OAuth access token (crh_...). Gateway/events only. */
  oauthToken?: string;
  /** How the credential is sent. Default: bearer. */
  authStyle?: AuthStyle;
  /** Extra headers applied to every request. */
  headers?: Record<string, string>;
  /** Non-streaming request timeout. Defaults: 30s management, 600s gateway. */
  timeoutMs?: number;
  /** Stream idle timeout. Default: 120s. */
  streamIdleTimeoutMs?: number;
  /** Retries after the first attempt. Default: 0 to avoid duplicate gateway billing. */
  maxRetries?: number;
  /** Allow retrying POST/PATCH. Default: false. */
  retryNonIdempotent?: boolean;
  /** Custom fetch implementation. Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Default abort signal for all requests. */
  signal?: AbortSignal;
  /** Requested response signature behavior. */
  signatureMode?: SignatureMode;
  /** User-Agent appended to SDK requests. */
  userAgent?: string;
}

export interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  responseType?: ResponseType;
  maxRetries?: number;
  retryNonIdempotent?: boolean;
}

export interface CallOptions {
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  responseType?: ResponseType;
  maxRetries?: number;
  retryNonIdempotent?: boolean;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  [key: string]: unknown;
}

export interface AnthropicMessagesRequest {
  model?: string;
  max_tokens: number;
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAIResponsesRequest {
  model?: string;
  input: string | Array<Record<string, unknown>>;
  stream?: boolean;
  [key: string]: unknown;
}

export interface ApiKeyTag {
  id: number | string;
  name: string;
  color?: string | null;
}

export interface ApiKeyTagsResponse {
  tags: ApiKeyTag[];
}

export interface ApiKeyModelQueueItem {
  model_id: string;
  id: string;
  name: string;
  provider: string | null;
  series: string | null;
  icon_url: string | null;
  sort_order: number;
}

export interface ApiKeyAvailableModel {
  id: string;
  name: string;
  provider: string;
  series: string | null;
  description: string | null;
  enabled: boolean;
  icon_url: string | null;
  input_price_per_1k_tokens: number | string | null;
  output_price_per_1k_tokens: number | string | null;
  assigned: boolean;
  sort_order: number | null;
}

export interface ApiKeyModelsResponse {
  models: ApiKeyAvailableModel[];
  queue: ApiKeyModelQueueItem[];
}

export interface ApiKeyModelsUpdateResponse {
  success: true;
  modelIds: string[];
  current_model_id: string | null;
}

export interface ApiKeyHarnessModel {
  harness: string;
  model_id: string;
  name: string;
  provider_name: string;
  label: string;
}

export interface AvailableHarness {
  id: string;
  label: string;
}

export interface ApiKeyHarnessModelsResponse {
  harness_models: ApiKeyHarnessModel[];
  available_harnesses: AvailableHarness[];
}

export interface RequestModelBinding {
  request_model_name: string;
  harness: string | null;
  model_id: string;
  name: string;
  provider_name: string;
}

export interface RequestModelBindingTarget {
  id: string;
  name: string;
  alias: string | null;
  upstream_model_id: string | null;
}

export interface ApiKeyRequestModelBindingsResponse {
  bindings: RequestModelBinding[];
  models: RequestModelBindingTarget[];
  available_harnesses: AvailableHarness[];
}

export interface ApiKeyFusionConfig {
  panel_models: string[];
  judge_model_id: string;
  outer_model_id: string;
  fusion_enabled: boolean;
  fusion_synthesis_prompt_enabled: boolean;
}

export interface ApiKeyFusionConfigPut {
  panel_models: string[];
  judge_model_id?: string;
  outer_model_id?: string;
  fusion_enabled?: boolean;
  fusion_synthesis_prompt_enabled?: boolean;
}

export interface ApiKeyActionSuccess {
  success: true;
}

export interface ApiKeyEnabledUpdateResponse {
  success: true;
  enabled: boolean;
}

export interface ApiKeySwallowImagesUpdateResponse {
  success: true;
  swallow_images: boolean;
}

export interface ApiKeyCommandsUpdateResponse {
  success: true;
  crewrouter_commands: boolean;
}

export interface ApiKeyClaudeConfig {
  env: {
    ANTHROPIC_BASE_URL: string;
    /** Contains the API Key secret; never log or expose it. */
    ANTHROPIC_AUTH_TOKEN: string;
    ANTHROPIC_MODEL: string;
    ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
    ANTHROPIC_DEFAULT_SONNET_MODEL: string;
    ANTHROPIC_DEFAULT_OPUS_MODEL: string;
  };
  model: string;
  effortLevel: string;
}

export interface ApiKeyListItem {
  id: number | string;
  name: string;
  key_group?: string;
  key_prefix?: string | null;
  key_value: string | null;
  permissions: string[];
  current_model_id?: string | null;
  current_model_name?: string | null;
  current_model_provider_name?: string | null;
  current_model_test_ok?: boolean | null;
  current_model_test_latency_ms?: number | null;
  current_model_test_tokens_per_second?: number | null;
  current_model_test_tested_at?: string | null;
  custom_model_name?: string;
  is_system?: boolean;
  signature_enabled?: boolean;
  signature_template?: string;
  api_signature_enabled?: boolean;
  api_signature_template?: string;
  quota_warning_enabled?: boolean;
  swallow_images?: boolean;
  crewrouter_commands?: boolean;
  schedule_enabled?: boolean;
  schedule_on_time?: string | null;
  schedule_off_time?: string | null;
  schedule_days?: number[];
  schedule_timezone?: string | null;
  enabled: boolean;
  expires_at?: string | null;
  created_at?: string | null;
  last_used_at?: string | null;
  total_tokens?: number | string;
  total_cost?: number | string;
  total_requests?: number | string;
  tags: ApiKeyTag[];
  model_queue: ApiKeyModelQueueItem[];
  harness_models?: Array<Record<string, unknown>>;
  request_model_bindings?: Array<Record<string, unknown>>;
  owner?: { id: number | string; username: string; email?: string | null };
  members?: Array<{ id: number | string; username: string; email?: string | null }>;
  member_count?: number;
  is_owner?: boolean;
  is_co_key?: boolean;
}

export interface DailyUsageItem {
  date: string;
  total_tokens: number | string;
  total_cost: number | string;
  total_requests: number | string;
}

export interface UserProviderListItem {
  id: string;
  name: string;
  format: 'openai' | 'anthropic' | 'responses' | 'gemini';
  created_by: number | null;
}

export interface AdminUser {
  id: number;
  username: string;
  email: string | null;
  email_verified: boolean;
  avatar: string | null;
  balance: number | string;
  refund_balance: number | string;
  is_admin: boolean;
  tags: unknown[];
  rate_limit_rpm: number;
  rate_limit_tpm: number;
  created_at: string;
  team_id: number | null;
  team_name: string | null;
}

export interface AdminUserStats {
  adminCount: number;
  verifiedCount: number;
  totalBalance: number;
}

export interface AdminUsersPage {
  items: AdminUser[];
  total: number;
  page: number;
  limit: number;
  stats: AdminUserStats;
}

export interface AdminProviderTag {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  created_at?: string;
}

export interface AdminProviderTagUpdateResponse {
  id: number;
  name: string;
  color: string;
  sort_order: number;
}

export interface TeamModelListItem {
  mapping_id: number | null;
  enabled: boolean;
  model_id: string;
  name: string;
  provider: string | null;
  series: string | null;
  description: string | null;
  input_price_per_1k_tokens: number | string | null;
  output_price_per_1k_tokens: number | string | null;
  icon_url: string | null;
  upstream_model_id: string | null;
  alias: string | null;
  model_multiplier: number | string;
  test_ok: boolean | null;
  test_latency_ms: number | string | null;
  test_tokens_per_second: number | string | null;
  test_error: string | null;
  test_tested_at: string | null;
  provider_id: string | null;
  provider_name: string | null;
  provider_enabled: boolean | null;
}

export interface TeamQuotaRule {
  id?: string;
  rule_type: string;
  rule_value?: number | string;
  limit_value?: number | string;
  duration_hours?: number;
  current?: number | string;
  description?: string;
  [key: string]: unknown;
}

export interface TeamRuleDeleteResponse {
  success: true;
}

export interface TeamMember {
  id: number;
  username: string;
  email: string | null;
  avatar: string | null;
  created_at: string;
}

export interface AdminStatsFilterOption {
  id: number | string;
  name: string;
}

export interface AdminStatsFiltersResponse {
  users: AdminStatsFilterOption[];
  teams: AdminStatsFilterOption[];
  models: AdminStatsFilterOption[];
  providers: AdminStatsFilterOption[];
  sources: AdminStatsFilterOption[];
  projects: AdminStatsFilterOption[];
}

export interface AdminUsageLog extends UserUsageLog {
  custom_instruction_count: number;
  username: string | null;
}

export interface AdminUsageLogsResponse {
  total: number;
  page: number;
  logs: AdminUsageLog[];
}

export interface AdminProduct {
  id: number;
  name: string;
  description: string | null;
  price: number | string;
  image_url: string | null;
  link: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type AdminUsersResponse = AdminUser[] | AdminUsersPage;

export interface UserProduct {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  link: string | null;
  sort_order: number;
}

export interface UserCodeBalanceItem {
  amount: number | string;
  fee_rate: number | string;
  code: string;
  code_amount: number | string;
  net_amount: number | string;
}

export interface ProviderTag {
  id: number;
  name: string;
  color: string;
  sort_order: number;
}

export interface ModelUptimeSummaryItem {
  uptime_pct: number | null;
  label: string;
  total_success: number;
  total_fail: number;
  spark: Array<'none' | 'ok' | 'degraded' | 'outage'>;
}

export interface ModelUptimeDailyResponse {
  days: number;
  granularity: 'day';
  items: Record<string, ModelUptimeSummaryItem>;
}

export interface ModelUptimeSlotResponse {
  days: 1;
  hours: 24;
  slots: number;
  granularity: '15m';
  items: Record<string, ModelUptimeSummaryItem>;
}

export type ModelUptimeResponse = ModelUptimeDailyResponse | ModelUptimeSlotResponse;

export interface ModelUptimeDetailPoint {
  date: string;
  status: 'none' | 'ok' | 'degraded' | 'outage';
  success: number;
  fail: number;
}

export interface ModelUptimeDailyDetail {
  model_id: string;
  uptime_pct: number | null;
  label: string;
  total_success: number;
  total_fail: number;
  granularity: 'day';
  days: ModelUptimeDetailPoint[];
}

export interface ModelUptimeSlotDetail {
  model_id: string;
  uptime_pct: number | null;
  label: string;
  total_success: number;
  total_fail: number;
  granularity: '15m';
  hours: 24;
  slots: number;
  days: ModelUptimeDetailPoint[];
}

export type ModelUptimeDetailResponse = ModelUptimeDailyDetail | ModelUptimeSlotDetail;

export interface ApiKeyMember {
  id: number;
  username: string;
  email: string;
  created_at: string;
}

export interface ApiKeyMembersResponse {
  is_owner: boolean;
  members: ApiKeyMember[];
}

export interface ApiKeyQuotaWarning {
  quota_warning_enabled: boolean;
}

export interface ApiKeySchedule {
  schedule_enabled: boolean;
  schedule_on_time: string | null;
  schedule_off_time: string | null;
  schedule_days: number[];
  schedule_timezone: string;
}

export interface CurrentModel {
  id: string;
  name: string;
  provider: string;
  series?: string | null;
  description?: string | null;
}

export interface CurrentModelResponse {
  currentModel: CurrentModel | null;
}

export interface UserUsageLog {
  id: number;
  user_id: number;
  model_id: string | null;
  api_key_id: number | null;
  tokens_used: number | string | null;
  prompt_tokens: number | string | null;
  completion_tokens: number | string | null;
  cached_tokens: number | string | null;
  provider_id: string | null;
  request_type: string | null;
  request_source: string;
  user_agent: string | null;
  latency_ms: number | string | null;
  ip_address: string | null;
  cost: number | string | null;
  created_at: string;
  key_prefix: string | null;
  key_name: string | null;
  series: string | null;
  model_name: string | null;
  upstream_model_id: string | null;
  requested_model: string | null;
  resolved_model: string | null;
  response_model: string | null;
  provider_name: string | null;
  [key: string]: unknown;
}

export interface UserUsageLogsResponse {
  total: number;
  page: number;
  logs: UserUsageLog[];
}

export interface UserUsageLogDetail extends UserUsageLog {
  is_stream: boolean | null;
  ttft_ms: number | string | null;
  upstream_first_byte_ms: number | string | null;
  generation_ms: number | string | null;
  tpot_ms: number | string | null;
  output_tps: number | string | null;
  e2e_ms: number | string | null;
  upstream_processing_ms: number | string | null;
  service_tier: string | null;
  rate_limit: unknown;
  messages: unknown;
  response: unknown;
}

export interface UserUsageLogDetailResponse {
  log: UserUsageLogDetail;
}

export interface StatsFilterOption {
  id: string;
  name: string;
}

export interface StatsFilterTeam {
  id: number;
  name: string;
}

export interface UserStatsFiltersResponse {
  sources: StatsFilterOption[];
  models: StatsFilterOption[];
  providers: StatsFilterOption[];
  teams: StatsFilterTeam[];
}

export interface UserKeyTag {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
}

export interface ApiKeyDailyUsageItem {
  date: string;
  model_id: string;
  model_name: string | null;
  tokens: number | string;
  cost: number | string;
  requests: number | string;
}

export interface UserModelInfo {
  model_id: string;
  name: string;
  alias: string | null;
  series: string | null;
  description: string | null;
  input_price_per_1k_tokens: number | string | null;
  output_price_per_1k_tokens: number | string | null;
  cached_output_price_per_1k_tokens: number | string | null;
  reference_input_price_per_1k_tokens: number | string | null;
  reference_output_price_per_1k_tokens: number | string | null;
  rate_limit_rpm: number | null;
  rate_limit_tpm: number | string | null;
  icon_url: string | null;
  series_icon_url: string | null;
  created_by: number | null;
  enabled: boolean;
  billing_mode: string | null;
  model_multiplier: number | string | null;
  completion_multiplier: number | string | null;
  thinking_model_id: string | null;
  non_thinking_model_id: string | null;
  upstream_model_id: string;
  provider_id: string;
  provider_name: string;
  test_ok: boolean | null;
  test_latency_ms: number | string | null;
  test_tokens_per_second: number | string | null;
  test_total_tokens: number | string;
  test_error: string | null;
  test_tested_at: string | null;
}

export interface UserModelListItem {
  id: string;
  upstream_model_id: string;
  name: string;
  alias: string | null;
  provider: string;
  provider_name: string;
  input_price_per_1k_tokens: number | string | null;
  output_price_per_1k_tokens: number | string | null;
  output_kind: string;
}

export interface UserBalance {
  balance: number;
  refund_balance: number;
  rate_limit_rpm: number;
  rate_limit_tpm: number;
  group: null | {
    id: number | string;
    name: string;
    description?: string | null;
    rules: TeamQuotaRule[];
  };
}

export interface CrewRouterResponse<T = unknown> {
  data: T;
  raw: Response;
  status: number;
  headers: Headers;
  requestId: string | null;
  signature: string | null;
  signatureBase64: string | null;
}

export interface StreamEvent {
  /** SSE event: field, or null when the stream used only data: lines. */
  event: string | null;
  /** Raw data payload joined from all data: lines. */
  data: string;
  /** JSON.parse(data) when possible, otherwise the raw string. */
  parsed: unknown;
  /** Whether data is the OpenAI [DONE] sentinel. */
  done: boolean;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Timeout for receiving response headers; defaults to the normal gateway timeout. */
  timeoutMs?: number;
  /** Maximum wait between stream chunks. */
  idleTimeoutMs?: number;
}

export interface StreamHandle<T = StreamEvent> extends AsyncIterable<T> {
  /** Abort the underlying request and parser. */
  abort(reason?: unknown): void;
  /** The HTTP response once headers are available. */
  readonly response: Promise<Response>;
}

export interface CrewRouterErrorOptions {
  status?: number;
  code?: string | null;
  type?: string | null;
  permission?: string | null;
  requestId?: string | null;
  retryAfter?: number | null;
  rawBody?: unknown;
  headers?: Headers;
  protocol?: 'openai' | 'anthropic' | 'management' | 'unknown';
  cause?: unknown;
}
