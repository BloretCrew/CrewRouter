import {
  CrewRouterAbortError,
  CrewRouterConnectionError,
  CrewRouterError,
  CrewRouterTimeoutError,
  errorFromResponse,
  isAbortError,
  parseRetryAfter,
  requestIdFromHeaders,
} from './errors.js';
import { parseSSE } from './sse.js';
import type {
  CrewRouterOptions,
  CrewRouterResponse,
  QueryValue,
  RequestOptions,
  StreamEvent,
  StreamHandle,
} from './types.js';

const DEFAULT_MANAGEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_GATEWAY_TIMEOUT_MS = 600_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_USER_AGENT = 'crewrouter-sdk-node/27.0.0-beta.1';
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new CrewRouterAbortError('Request aborted during retry backoff'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): URL {
  const target = path.startsWith('http://') || path.startsWith('https://')
    ? path
    : `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  const url = new URL(target);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function isFormBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return true;
  return false;
}

function defaultTimeoutFor(path: string): number {
  return path.startsWith('/v1/') ? DEFAULT_GATEWAY_TIMEOUT_MS : DEFAULT_MANAGEMENT_TIMEOUT_MS;
}

function decodeSignature(headers: Headers): { signature: string | null; signatureBase64: string | null } {
  const plain = headers.get('x-crewrouter-signature');
  const base64 = headers.get('x-crewrouter-signature-b64');
  let decoded: string | null = null;
  if (base64) {
    try {
      decoded = Buffer.from(base64, 'base64').toString('utf8');
    } catch {
      decoded = null;
    }
  }
  return { signature: plain || decoded, signatureBase64: base64 };
}

function retryDelayMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null && Number.isFinite(retryAfter)) return Math.max(0, retryAfter * 1000);
  const base = Math.min(8_000, 500 * 2 ** attempt);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function methodMayRetry(method: string, retryNonIdempotent: boolean): boolean {
  const upper = method.toUpperCase();
  if (['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(upper)) return true;
  return retryNonIdempotent;
}

type PreparedRequest = {
  url: URL;
  init: RequestInit;
  timeoutMs: number;
};

export class HttpClient {
  readonly baseUrl: string;
  private readonly options: CrewRouterOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CrewRouterOptions) {
    const baseUrl = options.baseUrl || process.env.CREWROUTER_BASE_URL;
    if (!baseUrl) throw new CrewRouterError('baseUrl is required (or set CREWROUTER_BASE_URL)');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.options = options;
    this.fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  }

  private prepare(options: RequestOptions): PreparedRequest {
    const headers = new Headers(this.options.headers);
    for (const [key, value] of Object.entries(options.headers || {})) headers.set(key, value);

    const apiKey = this.options.apiKey || process.env.CREWROUTER_API_KEY;
    if (this.options.oauthToken) {
      headers.set('Authorization', `Bearer ${this.options.oauthToken}`);
    } else if (apiKey) {
      if (this.options.authStyle === 'x-api-key') headers.set('x-api-key', apiKey);
      else headers.set('Authorization', `Bearer ${apiKey}`);
    }

    if (!headers.has('Accept')) {
      headers.set('Accept', options.responseType === 'stream' ? 'text/event-stream' : 'application/json');
    }
    if (!headers.has('User-Agent')) headers.set('User-Agent', this.options.userAgent || DEFAULT_USER_AGENT);
    if (this.options.signatureMode) headers.set('x-crewrouter-signature-mode', this.options.signatureMode);

    let body: BodyInit | undefined;
    if (options.body !== undefined && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
      if (isFormBody(options.body)) {
        body = options.body as BodyInit;
      } else {
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        body = JSON.stringify(options.body);
      }
    }

    return {
      url: buildUrl(this.baseUrl, options.path, options.query),
      init: {
        method: options.method.toUpperCase(),
        headers,
        body,
        redirect: 'follow',
      },
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? defaultTimeoutFor(options.path),
    };
  }

  private timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number) {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new CrewRouterTimeoutError(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      cleanup: () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      },
    };
  }

  async request<T = unknown>(options: RequestOptions): Promise<CrewRouterResponse<T>> {
    const prepared = this.prepare(options);
    const maxRetries = options.maxRetries ?? this.options.maxRetries ?? 0;
    const retryNonIdempotent = options.retryNonIdempotent ?? this.options.retryNonIdempotent ?? false;
    const canRetryMethod = methodMayRetry(options.method, retryNonIdempotent);
    const userSignal = options.signal ?? this.options.signal;

    for (let attempt = 0; ; attempt += 1) {
      const timeout = this.timeoutSignal(userSignal, prepared.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(prepared.url, { ...prepared.init, signal: timeout.signal });
      } catch (error) {
        const timedOut = timeout.timedOut();
        timeout.cleanup();
        if (isAbortError(error)) throw new CrewRouterAbortError('Request aborted', { cause: error });
        if (timedOut) {
          if (attempt < maxRetries && canRetryMethod) {
            await sleep(retryDelayMs(attempt, null), userSignal);
            continue;
          }
          throw new CrewRouterTimeoutError(`Request timed out after ${prepared.timeoutMs}ms`, { cause: error });
        }
        if (attempt < maxRetries && canRetryMethod) {
          await sleep(retryDelayMs(attempt, null), userSignal);
          continue;
        }
        throw new CrewRouterConnectionError(error instanceof Error ? error.message : String(error), { cause: error });
      }
      timeout.cleanup();

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const apiError = errorFromResponse(response.status, response.headers, text);
        if (attempt < maxRetries && canRetryMethod && RETRYABLE_STATUSES.has(response.status)) {
          await sleep(retryDelayMs(attempt, apiError.retryAfter), userSignal);
          continue;
        }
        throw apiError;
      }

      const responseType = options.responseType || 'json';
      let data: unknown;
      if (responseType === 'stream') {
        data = response.body;
      } else if (responseType === 'arrayBuffer') {
        data = await response.arrayBuffer();
      } else if (responseType === 'text') {
        data = await response.text();
      } else {
        const text = await response.text();
        if (!text) data = null;
        else {
          try {
            data = JSON.parse(text);
          } catch (error) {
            throw new CrewRouterError('Response was not valid JSON', {
              status: response.status,
              requestId: requestIdFromHeaders(response.headers),
              rawBody: text,
              headers: response.headers,
              cause: error,
            });
          }
        }
      }

      const signatures = decodeSignature(response.headers);
      return {
        data: data as T,
        raw: response,
        status: response.status,
        headers: response.headers,
        requestId: requestIdFromHeaders(response.headers),
        signature: signatures.signature,
        signatureBase64: signatures.signatureBase64,
      };
    }
  }

  stream(options: RequestOptions): StreamHandle {
    const prepared = this.prepare({ ...options, responseType: 'stream' });
    const requestController = new AbortController();
    const userSignal = options.signal ?? this.options.signal;
    const onAbort = () => requestController.abort(userSignal?.reason);
    if (userSignal) {
      if (userSignal.aborted) requestController.abort(userSignal.reason);
      else userSignal.addEventListener('abort', onAbort, { once: true });
    }

    const idleTimeoutMs = options.streamIdleTimeoutMs ?? this.options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    const headerTimeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? prepared.timeoutMs;
    const headerTimeout = this.timeoutSignal(requestController.signal, headerTimeoutMs || DEFAULT_GATEWAY_TIMEOUT_MS);
    const responsePromise = this.fetchImpl(prepared.url, { ...prepared.init, signal: headerTimeout.signal })
      .then(async (response) => {
        headerTimeout.cleanup();
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw errorFromResponse(response.status, response.headers, text);
        }
        return response;
      })
      .catch((error) => {
        headerTimeout.cleanup();
        requestController.abort(error);
        if (isAbortError(error)) throw new CrewRouterAbortError('Request aborted', { cause: error });
        if (headerTimeout.timedOut()) throw new CrewRouterTimeoutError(`Stream request timed out after ${headerTimeoutMs}ms`, { cause: error });
        if (error instanceof CrewRouterError) throw error;
        throw new CrewRouterConnectionError(error instanceof Error ? error.message : String(error), { cause: error });
      });

    return {
      response: responsePromise,
      abort(reason?: unknown) {
        requestController.abort(reason);
      },
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
        const response = await responsePromise;
        if (!response.body) throw new CrewRouterError('Streaming response has no body', { status: response.status });
        try {
          yield* parseSSE(response.body, { signal: requestController.signal, idleTimeoutMs });
        } finally {
          userSignal?.removeEventListener('abort', onAbort);
        }
      },
    };
  }

  async streamOnce(options: RequestOptions): Promise<{ response: CrewRouterResponse<ReadableStream<Uint8Array> | null>; events: AsyncIterable<StreamEvent> }> {
    const handle = this.stream(options);
    const response = await handle.response;
    return {
      response: {
        data: response.body,
        raw: response,
        status: response.status,
        headers: response.headers,
        requestId: requestIdFromHeaders(response.headers),
        signature: decodeSignature(response.headers).signature,
        signatureBase64: decodeSignature(response.headers).signatureBase64,
      },
      events: handle,
    };
  }
}
