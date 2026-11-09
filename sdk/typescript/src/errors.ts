import type { CrewRouterErrorOptions } from './types.js';

export class CrewRouterError extends Error {
  readonly status?: number;
  readonly code: string | null;
  readonly type: string | null;
  readonly permission: string | null;
  readonly requestId: string | null;
  readonly retryAfter: number | null;
  readonly rawBody: unknown;
  readonly headers?: Headers;
  readonly protocol: 'openai' | 'anthropic' | 'management' | 'unknown';

  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CrewRouterError';
    this.status = options.status;
    this.code = options.code ?? null;
    this.type = options.type ?? null;
    this.permission = options.permission ?? null;
    this.requestId = options.requestId ?? null;
    this.retryAfter = options.retryAfter ?? null;
    this.rawBody = options.rawBody;
    this.headers = options.headers;
    this.protocol = options.protocol ?? 'unknown';
  }
}

export class CrewRouterBadRequestError extends CrewRouterError {
  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, options);
    this.name = 'CrewRouterBadRequestError';
  }
}

export class CrewRouterAuthenticationError extends CrewRouterError {
  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, options);
    this.name = 'CrewRouterAuthenticationError';
  }
}

export class CrewRouterPermissionError extends CrewRouterError {
  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, options);
    this.name = 'CrewRouterPermissionError';
  }
}

export class CrewRouterNotFoundError extends CrewRouterError {
  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, options);
    this.name = 'CrewRouterNotFoundError';
  }
}

export class CrewRouterConflictError extends CrewRouterError {
  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, options);
    this.name = 'CrewRouterConflictError';
  }
}

export class CrewRouterRateLimitError extends CrewRouterError {
  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, options);
    this.name = 'CrewRouterRateLimitError';
  }
}

export class CrewRouterServerError extends CrewRouterError {
  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, options);
    this.name = 'CrewRouterServerError';
  }
}

export class CrewRouterConnectionError extends CrewRouterError {
  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, { ...options, protocol: 'unknown' });
    this.name = 'CrewRouterConnectionError';
  }
}

export class CrewRouterTimeoutError extends CrewRouterConnectionError {
  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, options);
    this.name = 'CrewRouterTimeoutError';
  }
}

export class CrewRouterAbortError extends CrewRouterError {
  constructor(message = 'Request aborted', options: CrewRouterErrorOptions = {}) {
    super(message, { ...options, protocol: 'unknown' });
    this.name = 'CrewRouterAbortError';
  }
}

export class CrewRouterStreamError extends CrewRouterError {
  constructor(message: string, options: CrewRouterErrorOptions = {}) {
    super(message, options);
    this.name = 'CrewRouterStreamError';
  }
}

export type ParsedErrorPayload = {
  message: string;
  type: string | null;
  code: string | null;
  permission: string | null;
  protocol: 'openai' | 'anthropic' | 'management' | 'unknown';
  rawBody: unknown;
};

function tryJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseRetryAfter(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
  return null;
}

export function requestIdFromHeaders(headers: Headers): string | null {
  return headers.get('x-crewrouter-request-id') || headers.get('x-request-id') || null;
}

export function parseErrorPayload(status: number, headers: Headers, text: string): ParsedErrorPayload {
  const parsed = tryJson(text);
  const record = asRecord(parsed);

  // Anthropic: { type: "error", error: { type, message } }
  if (record && record.type === 'error' && asRecord(record.error)) {
    const error = record.error as Record<string, unknown>;
    return {
      message: String(error.message ?? error.error ?? `HTTP ${status}`),
      type: typeof error.type === 'string' ? error.type : null,
      code: typeof error.code === 'string' ? error.code : null,
      permission: typeof error.permission === 'string' ? error.permission : null,
      protocol: 'anthropic',
      rawBody: parsed,
    };
  }

  // OpenAI / Responses: { error: { type, code, message } }
  if (record && asRecord(record.error)) {
    const error = record.error as Record<string, unknown>;
    return {
      message: String(error.message ?? error.code ?? `HTTP ${status}`),
      type: typeof error.type === 'string' ? error.type : null,
      code: typeof error.code === 'string' ? error.code : null,
      permission: typeof error.permission === 'string' ? error.permission : null,
      protocol: 'openai',
      rawBody: parsed,
    };
  }

  // Management API: { error: "message", code, permission }
  if (record && typeof record.error === 'string') {
    return {
      message: record.error,
      type: typeof record.type === 'string' ? record.type : null,
      code: typeof record.code === 'string' ? record.code : null,
      permission: typeof record.permission === 'string' ? record.permission : null,
      protocol: 'management',
      rawBody: parsed,
    };
  }

  if (record && typeof record.message === 'string') {
    return {
      message: record.message,
      type: typeof record.type === 'string' ? record.type : null,
      code: typeof record.code === 'string' ? record.code : null,
      permission: typeof record.permission === 'string' ? record.permission : null,
      protocol: 'management',
      rawBody: parsed,
    };
  }

  return {
    message: text.trim() || headers.get('status-text') || `HTTP ${status}`,
    type: null,
    code: null,
    permission: null,
    protocol: 'unknown',
    rawBody: parsed ?? text,
  };
}

export function errorFromResponse(status: number, headers: Headers, text: string): CrewRouterError {
  const parsed = parseErrorPayload(status, headers, text);
  const options: CrewRouterErrorOptions = {
    status,
    code: parsed.code,
    type: parsed.type,
    permission: parsed.permission,
    requestId: requestIdFromHeaders(headers),
    retryAfter: parseRetryAfter(headers),
    rawBody: parsed.rawBody,
    headers,
    protocol: parsed.protocol,
  };
  if (status === 400 || status === 413 || status === 422) return new CrewRouterBadRequestError(parsed.message, options);
  if (status === 401) return new CrewRouterAuthenticationError(parsed.message, options);
  if (status === 403) return new CrewRouterPermissionError(parsed.message, options);
  if (status === 404) return new CrewRouterNotFoundError(parsed.message, options);
  if (status === 409) return new CrewRouterConflictError(parsed.message, options);
  if (status === 429) return new CrewRouterRateLimitError(parsed.message, options);
  if (status >= 500) return new CrewRouterServerError(parsed.message, options);
  return new CrewRouterError(parsed.message, options);
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && ((error as { name?: string }).name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR'));
}
