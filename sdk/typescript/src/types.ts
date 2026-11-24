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
