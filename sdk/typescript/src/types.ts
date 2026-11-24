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

export interface ApiKeyModelQueueItem {
  model_id: string;
  name?: string | null;
  provider?: string | null;
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

export interface TeamQuotaRule {
  rule_type: string;
  limit_value?: number | string;
  duration_hours?: number;
  current?: number;
  [key: string]: unknown;
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
