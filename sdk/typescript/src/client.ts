import { CrewRouterError } from './errors.js';
import { OPERATIONS, type CrewRouterOperation, type OperationId } from './generated/operations.js';
import { HttpClient } from './http.js';
import type {
  AnthropicMessagesRequest,
  ApiKeyClaudeConfig,
  ApiKeyDailyUsageItem,
  ApiKeyListItem,
  ApiKeyMembersResponse,
  ApiKeyModelsResponse,
  ApiKeyModelsUpdateResponse,
  ApiKeyQuotaWarning,
  ApiKeySchedule,
  CallOptions,
  ChatCompletionRequest,
  CrewRouterOptions,
  CrewRouterResponse,
  CurrentModelResponse,
  DailyUsageItem,
  UserBalance,
  UserKeyTag,
  UserModelListItem,
  UserProviderListItem,
  UserProduct,
  ProviderTag,
  UserCodeBalanceItem,
  UserUsageLogsResponse,
  ModelUptimeResponse,
  ModelUptimeDetailResponse,
  RequestOptions,
  StreamHandle,
  StreamOptions,
  OpenAIResponsesRequest,
  QueryValue,
} from './types.js';

type JsonObject = Record<string, unknown>;

function mergePathParams(options: CallOptions | undefined, extra: Record<string, string | number>): CallOptions {
  return { ...options, pathParams: { ...(options?.pathParams || {}), ...extra } };
}

function streamOptions(options: StreamOptions | undefined): Pick<RequestOptions, 'signal' | 'timeoutMs' | 'streamIdleTimeoutMs'> {
  return {
    signal: options?.signal,
    timeoutMs: options?.timeoutMs,
    streamIdleTimeoutMs: options?.idleTimeoutMs,
  };
}

export interface ApiKeyCreateInput extends JsonObject {
  name?: string;
  expiresIn?: number;
  customModelName?: string;
  permissions?: string[];
}

export class CrewRouter {
  readonly http: HttpClient;

  constructor(options: CrewRouterOptions = {}) {
    this.http = new HttpClient(options);
  }

  /** Raw HTTP escape hatch; no operation metadata required. */
  request<T = unknown>(options: RequestOptions): Promise<CrewRouterResponse<T>> {
    return this.http.request<T>(options);
  }

  /** Low-level alias kept for parity with other SDKs. */
  raw<T = unknown>(options: RequestOptions): Promise<CrewRouterResponse<T>> {
    return this.http.request<T>(options);
  }

  /** The generated operation catalog. */
  get operations(): Record<string, CrewRouterOperation> {
    return OPERATIONS;
  }

  operation(id: OperationId | string): CrewRouterOperation {
    const operation = OPERATIONS[id];
    if (!operation) throw new CrewRouterError(`Unknown operation: ${id}`);
    return operation;
  }

  /**
   * Call any generated operation by id.
   *
   * Session-only operations are present in the catalog for documentation but
   * cannot be called with an API Key; they throw before making a request.
   */
  async call<T = unknown>(id: OperationId | string, options: CallOptions = {}): Promise<CrewRouterResponse<T>> {
    const operation = this.operation(id);
    if (operation.sdkStatus === 'excluded' && operation.exclusion === 'session_only') {
      throw new CrewRouterError(
        `Operation "${id}" is session-only and cannot be called with an API Key. Use the browser console or a session client.`,
        { status: 403, code: 'session_required' },
      );
    }
    if (operation.sdkStatus === 'excluded' && operation.exclusion === 'alias') {
      throw new CrewRouterError(`Operation "${id}" is an alias; use its canonical operation instead.`);
    }

    const path = operation.path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
      const value = options.pathParams?.[name];
      if (value === undefined || value === null) {
        throw new CrewRouterError(`Missing path parameter "${name}" for operation "${id}"`);
      }
      return encodeURIComponent(String(value));
    });

    return this.http.request<T>({
      method: operation.method,
      path,
      query: options.query,
      body: options.body,
      headers: options.headers,
      signal: options.signal,
      responseType: options.responseType,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      retryNonIdempotent: options.retryNonIdempotent,
    });
  }

  // ---------------------------------------------------------------------------
  // Gateway (OpenAI / Anthropic / Responses)
  // ---------------------------------------------------------------------------

  readonly gateway = {
    chat: {
      completions: {
        create: <T = unknown>(body: ChatCompletionRequest, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
          this.call<T>('gateway.chat.completions.create', { ...options, body }),
        stream: (body: ChatCompletionRequest, options?: StreamOptions): StreamHandle =>
          this.http.stream({ method: 'POST', path: '/v1/chat/completions', body, ...streamOptions(options) }),
      },
    },
    messages: {
      create: <T = unknown>(body: AnthropicMessagesRequest, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
        this.call<T>('gateway.messages.create', { ...options, body }),
      stream: (body: AnthropicMessagesRequest, options?: StreamOptions): StreamHandle =>
        this.http.stream({ method: 'POST', path: '/v1/messages', body, ...streamOptions(options) }),
    },
    responses: {
      create: <T = unknown>(body: OpenAIResponsesRequest, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
        this.call<T>('gateway.responses.create', { ...options, body }),
      stream: (body: OpenAIResponsesRequest, options?: StreamOptions): StreamHandle =>
        this.http.stream({ method: 'POST', path: '/v1/responses', body, ...streamOptions(options) }),
    },
    models: {
      list: <T = unknown>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
        this.call<T>('gateway.models.list', options),
    },
  };

  // ---------------------------------------------------------------------------
  // Core management convenience wrappers. Everything else is reachable through
  // call(operationId, ...) using the generated catalog.
  // ---------------------------------------------------------------------------

  readonly keys = {
    list: <T = ApiKeyListItem[]>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.list', options),
    create: <T = unknown>(body: ApiKeyCreateInput, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.create', { ...options, body }),
    update: <T = unknown>(id: string | number, body: JsonObject, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.byId.update', mergePathParams({ ...options, body }, { id })),
    delete: <T = unknown>(id: string | number, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.byId.delete', mergePathParams(options, { id })),
    getModels: <T = ApiKeyModelsResponse>(id: string | number, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.byId.models.list', mergePathParams(options, { id })),
    setModels: <T = ApiKeyModelsUpdateResponse>(id: string | number, body: JsonObject, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.byId.models.update', mergePathParams({ ...options, body }, { id })),
    getConfig: <T = ApiKeyClaudeConfig>(id: string | number, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.byId.config.list', mergePathParams(options, { id })),
    getUsage: <T = ApiKeyDailyUsageItem[]>(id: string | number, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.byId.usage.list', mergePathParams(options, { id })),
    getMembers: <T = ApiKeyMembersResponse>(id: string | number, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.byId.members.list', mergePathParams(options, { id })),
    getQuotaWarning: <T = ApiKeyQuotaWarning>(id: string | number, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.byId.quotaWarning.list', mergePathParams(options, { id })),
    setQuotaWarning: <T = ApiKeyQuotaWarning>(id: string | number, body: ApiKeyQuotaWarning, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.byId.quotaWarning.update', mergePathParams({ ...options, body }, { id })),
    getSchedule: <T = ApiKeySchedule>(id: string | number, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.apiKeys.byId.schedule.list', mergePathParams(options, { id })),
  };

  readonly usage = {
    get: <T = DailyUsageItem[]>(query?: Record<string, string | number | boolean | null | undefined | Array<string | number | boolean>>, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.usage.list', { ...options, query }),
    logs: <T = UserUsageLogsResponse>(query?: Record<string, string | number | boolean | null | undefined | Array<string | number | boolean>>, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.usageLogs.list', { ...options, query }),
  };

  readonly balance = {
    get: <T = UserBalance>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.balance.list', options),
  };

  readonly models = {
    list: <T = UserModelListItem[]>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.models.list', options),
  };

  readonly currentModel = {
    get: <T = CurrentModelResponse>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.currentModel.list', options),
    set: <T = unknown>(body: JsonObject, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.currentModel.update', { ...options, body }),
  };

  readonly modelUptime = {
    get: <T = ModelUptimeResponse>(query?: Record<string, QueryValue>, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.models.uptime.list', { ...options, query }),
    getDetail: <T = ModelUptimeDetailResponse>(id: string, query?: Record<string, QueryValue>, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.models.byId.uptime.list', { ...options, pathParams: { ...(options?.pathParams || {}), id }, query }),
  };

  readonly providers = {
    list: <T = UserProviderListItem[]>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.providers.list', options),
  };

  readonly products = {
    list: <T = UserProduct[]>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.products.list', options),
  };

  readonly codeBalances = {
    list: <T = UserCodeBalanceItem[]>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.codeBalances.list', options),
  };

  readonly providerTags = {
    list: <T = ProviderTag[]>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.providerTags.list', options),
  };

  readonly keyTags = {
    list: <T = UserKeyTag[]>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.keyTags.list', options),
    create: <T = UserKeyTag>(body: JsonObject, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.keyTags.create', { ...options, body }),
    update: <T = UserKeyTag>(id: string | number, body: JsonObject, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
      this.call<T>('user.keyTags.byId.update', mergePathParams({ ...options, body }, { id })),
  };

  readonly admin = {
    users: {
      list: <T = unknown>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
        this.call<T>('admin.users.list', options),
    },
    models: {
      list: <T = unknown>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
        this.call<T>('admin.models.list', options),
    },
    providers: {
      list: <T = unknown>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
        this.call<T>('admin.providers.list', options),
      get: <T = unknown>(id: string | number, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
        this.call<T>('admin.providers.byId.get', mergePathParams(options, { id })),
      refreshKey: <T = unknown>(id: string | number, options?: CallOptions): Promise<CrewRouterResponse<T>> =>
        this.call<T>('admin.providers.byId.refreshKey', mergePathParams(options, { id })),
    },
    teams: {
      list: <T = unknown>(options?: CallOptions): Promise<CrewRouterResponse<T>> =>
        this.call<T>('admin.teams.list', options),
    },
  };
}
