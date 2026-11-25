from __future__ import annotations

import re
from typing import Any, Mapping, Optional, Sequence, TypedDict, Union
from urllib.parse import quote

import httpx

from ._http import AsyncHttpClient, CrewRouterResponse, HttpClient, QueryValue
from ._sse import AsyncStream, AsyncStreamRequest, Stream
from .errors import CrewRouterError
from .generated.operations import CONTRACT_VERSION, OPERATIONS

_PATH_PARAM = re.compile(r":([A-Za-z0-9_]+)")


class AdminUser(TypedDict, total=False):
    id: int
    username: str
    email: Optional[str]
    email_verified: bool
    avatar: Optional[str]
    balance: Union[float, str]
    refund_balance: Union[float, str]
    is_admin: bool
    tags: list[Any]
    rate_limit_rpm: int
    rate_limit_tpm: int
    created_at: str
    team_id: Optional[int]
    team_name: Optional[str]


class AdminUserStats(TypedDict):
    adminCount: int
    verifiedCount: int
    totalBalance: float


class AdminUsersPage(TypedDict):
    items: list[AdminUser]
    total: int
    page: int
    limit: int
    stats: AdminUserStats


AdminUsersResponse = Union[list[AdminUser], AdminUsersPage]


class ApiKeyTag(TypedDict, total=False):
    id: Union[int, str]
    name: str
    color: Optional[str]


class ApiKeyTagsResponse(TypedDict):
    tags: list[ApiKeyTag]


class ApiKeyModelQueueItem(TypedDict, total=False):
    model_id: str
    id: str
    name: str
    provider: Optional[str]
    series: Optional[str]
    icon_url: Optional[str]
    sort_order: int


class ApiKeyQueueItem(TypedDict):
    model_id: str
    id: str
    name: str
    provider: Optional[str]
    series: Optional[str]
    icon_url: Optional[str]
    sort_order: int


class ApiKeyAvailableModel(TypedDict):
    id: str
    name: str
    provider: str
    series: Optional[str]
    description: Optional[str]
    enabled: bool
    icon_url: Optional[str]
    input_price_per_1k_tokens: Optional[Union[float, str]]
    output_price_per_1k_tokens: Optional[Union[float, str]]
    assigned: bool
    sort_order: Optional[int]


class ApiKeyModelsResponse(TypedDict):
    models: list[ApiKeyAvailableModel]
    queue: list[ApiKeyQueueItem]


class ApiKeyModelsUpdateResponse(TypedDict):
    success: bool
    modelIds: list[str]
    current_model_id: Optional[str]


class ApiKeyFusionConfig(TypedDict):
    panel_models: list[str]
    judge_model_id: str
    outer_model_id: str
    fusion_enabled: bool
    fusion_synthesis_prompt_enabled: bool


class ApiKeyFusionConfigPut(TypedDict, total=False):
    panel_models: list[str]
    judge_model_id: str
    outer_model_id: str
    fusion_enabled: bool
    fusion_synthesis_prompt_enabled: bool


class ApiKeyActionSuccess(TypedDict):
    success: bool


class ApiKeyEnabledUpdateResponse(TypedDict):
    success: bool
    enabled: bool


class ApiKeySwallowImagesUpdateResponse(TypedDict):
    success: bool
    swallow_images: bool


class ApiKeyCommandsUpdateResponse(TypedDict):
    success: bool
    crewrouter_commands: bool


class ApiKeyEnabledUpdateResponse(TypedDict):
    success: bool
    enabled: bool


class ApiKeySwallowImagesUpdateResponse(TypedDict):
    success: bool
    swallow_images: bool


class ApiKeyCommandsUpdateResponse(TypedDict):
    success: bool
    crewrouter_commands: bool


class ApiKeyClaudeConfigEnv(TypedDict):
    ANTHROPIC_BASE_URL: str
    ANTHROPIC_AUTH_TOKEN: str
    ANTHROPIC_MODEL: str
    ANTHROPIC_DEFAULT_HAIKU_MODEL: str
    ANTHROPIC_DEFAULT_SONNET_MODEL: str
    ANTHROPIC_DEFAULT_OPUS_MODEL: str


class ApiKeyClaudeConfig(TypedDict):
    env: ApiKeyClaudeConfigEnv
    model: str
    effortLevel: str


class ApiKeyHarnessModel(TypedDict):
    harness: str
    model_id: str
    name: str
    provider_name: str
    label: str


class AvailableHarness(TypedDict):
    id: str
    label: str


class ApiKeyHarnessModelsResponse(TypedDict):
    harness_models: list[ApiKeyHarnessModel]
    available_harnesses: list[AvailableHarness]


class RequestModelBinding(TypedDict):
    request_model_name: str
    harness: Optional[str]
    model_id: str
    name: str
    provider_name: str


class RequestModelBindingTarget(TypedDict, total=False):
    id: str
    name: str
    alias: Optional[str]
    upstream_model_id: Optional[str]


class ApiKeyRequestModelBindingsResponse(TypedDict):
    bindings: list[RequestModelBinding]
    models: list[RequestModelBindingTarget]
    available_harnesses: list[AvailableHarness]


class ApiKeyListItem(TypedDict, total=False):
    id: Union[int, str]
    name: str
    key_group: str
    key_prefix: Optional[str]
    key_value: Optional[str]
    permissions: list[str]
    current_model_id: Optional[str]
    current_model_name: Optional[str]
    current_model_provider_name: Optional[str]
    current_model_test_ok: Optional[bool]
    current_model_test_latency_ms: Optional[int]
    current_model_test_tokens_per_second: Optional[float]
    current_model_test_tested_at: Optional[str]
    custom_model_name: str
    is_system: bool
    signature_enabled: bool
    signature_template: str
    api_signature_enabled: bool
    api_signature_template: str
    quota_warning_enabled: bool
    swallow_images: bool
    crewrouter_commands: bool
    schedule_enabled: bool
    schedule_on_time: Optional[str]
    schedule_off_time: Optional[str]
    schedule_days: list[int]
    schedule_timezone: Optional[str]
    enabled: bool
    expires_at: Optional[str]
    total_tokens: Union[int, str]
    total_cost: Union[float, str]
    total_requests: Union[int, str]
    tags: list[ApiKeyTag]
    model_queue: list[ApiKeyModelQueueItem]
    members: list[dict[str, Any]]
    member_count: int
    is_owner: bool
    is_co_key: bool


class ApiKeyDailyUsageItem(TypedDict):
    date: str
    model_id: str
    model_name: Optional[str]
    tokens: Union[int, str]
    cost: Union[float, str]
    requests: Union[int, str]


class DailyUsageItem(TypedDict, total=False):
    date: str
    total_tokens: Union[int, str]
    total_cost: Union[float, str]
    total_requests: Union[int, str]


class UserBalance(TypedDict):
    balance: float
    refund_balance: float
    rate_limit_rpm: int
    rate_limit_tpm: int
    group: Optional[dict[str, Any]]


class UserProviderListItem(TypedDict):
    id: str
    name: str
    format: str
    created_by: Optional[int]


class UserProduct(TypedDict):
    id: int
    name: str
    description: Optional[str]
    image_url: Optional[str]
    link: Optional[str]
    sort_order: int


class UserCodeBalanceItem(TypedDict):
    amount: Union[float, str]
    fee_rate: Union[float, str]
    code: str
    code_amount: Union[float, str]
    net_amount: Union[float, str]


class ProviderTag(TypedDict):
    id: int
    name: str
    color: str
    sort_order: int


class ApiKeyMember(TypedDict):
    id: int
    username: str
    email: str
    created_at: str


class ApiKeyMembersResponse(TypedDict):
    is_owner: bool
    members: list[ApiKeyMember]


class ApiKeyQuotaWarning(TypedDict):
    quota_warning_enabled: bool


class ApiKeySchedule(TypedDict):
    schedule_enabled: bool
    schedule_on_time: Optional[str]
    schedule_off_time: Optional[str]
    schedule_days: list[int]
    schedule_timezone: str


class UserCurrentModel(TypedDict, total=False):
    id: str
    name: str
    provider: str
    series: Optional[str]
    description: Optional[str]


class CurrentModelResponse(TypedDict):
    currentModel: Optional[UserCurrentModel]


class UserUsageLog(TypedDict, total=False):
    id: int
    user_id: int
    model_id: Optional[str]
    api_key_id: Optional[int]
    tokens_used: Optional[Union[int, str]]
    prompt_tokens: Optional[Union[int, str]]
    completion_tokens: Optional[Union[int, str]]
    cached_tokens: Optional[Union[int, str]]
    provider_id: Optional[str]
    request_type: Optional[str]
    request_source: str
    user_agent: Optional[str]
    latency_ms: Optional[Union[float, str]]
    ip_address: Optional[str]
    cost: Optional[Union[float, str]]
    created_at: str
    key_prefix: Optional[str]
    key_name: Optional[str]
    series: Optional[str]
    model_name: Optional[str]
    upstream_model_id: Optional[str]
    requested_model: Optional[str]
    resolved_model: Optional[str]
    response_model: Optional[str]
    provider_name: Optional[str]


class UserUsageLogsResponse(TypedDict):
    total: int
    page: int
    logs: list[UserUsageLog]


class ModelUptimeSummaryItem(TypedDict):
    uptime_pct: Optional[float]
    label: str
    total_success: int
    total_fail: int
    spark: list[str]


class ModelUptimeDailyResponse(TypedDict):
    days: int
    granularity: str
    items: dict[str, ModelUptimeSummaryItem]


class ModelUptimeSlotResponse(TypedDict):
    days: int
    hours: int
    slots: int
    granularity: str
    items: dict[str, ModelUptimeSummaryItem]


ModelUptimeResponse = Union[ModelUptimeDailyResponse, ModelUptimeSlotResponse]


class ModelUptimeDetailPoint(TypedDict):
    date: str
    status: str
    success: int
    fail: int


class ModelUptimeDailyDetail(TypedDict):
    model_id: str
    uptime_pct: Optional[float]
    label: str
    total_success: int
    total_fail: int
    granularity: str
    days: list[ModelUptimeDetailPoint]


class ModelUptimeSlotDetail(TypedDict):
    model_id: str
    uptime_pct: Optional[float]
    label: str
    total_success: int
    total_fail: int
    granularity: str
    hours: int
    slots: int
    days: list[ModelUptimeDetailPoint]


ModelUptimeDetailResponse = Union[ModelUptimeDailyDetail, ModelUptimeSlotDetail]


class UserKeyTag(TypedDict):
    id: int
    name: str
    color: str
    sort_order: int
    created_at: str


class UserModelListItem(TypedDict):
    id: str
    upstream_model_id: str
    name: str
    alias: Optional[str]
    provider: str
    provider_name: str
    input_price_per_1k_tokens: Optional[Union[float, str]]
    output_price_per_1k_tokens: Optional[Union[float, str]]
    output_kind: str


class _ChatMessageRequired(TypedDict):
    role: str


class ChatMessage(_ChatMessageRequired, total=False):
    content: Any
    name: str
    tool_call_id: str


class _ChatCompletionRequired(TypedDict):
    messages: list[ChatMessage]


class ChatCompletionRequest(_ChatCompletionRequired, total=False):
    model: str
    stream: bool
    temperature: float
    max_tokens: int


class _AnthropicMessagesRequired(TypedDict):
    max_tokens: int
    messages: list[ChatMessage]


class AnthropicMessagesRequest(_AnthropicMessagesRequired, total=False):
    model: str
    stream: bool
    system: str
    temperature: float


class _OpenAIResponsesRequired(TypedDict):
    input: Union[str, list[dict[str, Any]]]


class OpenAIResponsesRequest(_OpenAIResponsesRequired, total=False):
    model: str
    stream: bool
    instructions: str
    temperature: float


def _operation(operation_id: str) -> dict[str, Any]:
    operation = OPERATIONS.get(operation_id)
    if operation is None:
        raise CrewRouterError(f"Unknown operation: {operation_id}")
    if operation.get("sdkStatus") == "excluded" and operation.get("exclusion") == "session_only":
        raise CrewRouterError(
            f'Operation "{operation_id}" is session-only and cannot be called with an API Key.',
            status=403,
            code="session_required",
        )
    if operation.get("sdkStatus") == "excluded" and operation.get("exclusion") == "alias":
        raise CrewRouterError(f'Operation "{operation_id}" is an alias; use its canonical operation.')
    return operation


def _path(operation: dict[str, Any], path_params: Optional[Mapping[str, Any]]) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        value = (path_params or {}).get(name)
        if value is None:
            raise CrewRouterError(f'Missing path parameter "{name}" for operation "{operation["operationId"]}"')
        return quote(str(value), safe="")

    return _PATH_PARAM.sub(replace, operation["path"])


class CrewRouter:
    """Synchronous CrewRouter client."""

    contract_version = CONTRACT_VERSION

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        oauth_token: Optional[str] = None,
        auth_style: str = "bearer",
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
        max_retries: int = 0,
        retry_non_idempotent: bool = False,
        signature_mode: Optional[str] = None,
        user_agent: Optional[str] = None,
        transport: Optional[httpx.BaseTransport] = None,
        client: Optional[httpx.Client] = None,
    ) -> None:
        self.http = HttpClient(
            base_url=base_url,
            api_key=api_key,
            oauth_token=oauth_token,
            auth_style=auth_style,
            headers=headers,
            timeout=timeout,
            max_retries=max_retries,
            retry_non_idempotent=retry_non_idempotent,
            signature_mode=signature_mode,
            user_agent=user_agent,
            transport=transport,
            client=client,
        )
        self.gateway = _Gateway(self)
        self.keys = _Keys(self)
        self.usage = _Usage(self)
        self.balance = _Balance(self)
        self.models = _Models(self)
        self.providers = _Providers(self)
        self.admin = _Admin(self)

    @property
    def operations(self) -> dict[str, dict[str, Any]]:
        return OPERATIONS

    def operation(self, operation_id: str) -> dict[str, Any]:
        return _operation(operation_id)

    def close(self) -> None:
        self.http.close()

    def __enter__(self) -> "CrewRouter":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, QueryValue]] = None,
        body: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        files: Any = None,
        data: Any = None,
        response_type: str = "json",
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        retry_non_idempotent: Optional[bool] = None,
    ) -> CrewRouterResponse:
        return self.http.request(
            method,
            path,
            query=query,
            body=body,
            headers=headers,
            files=files,
            data=data,
            response_type=response_type,
            timeout=timeout,
            max_retries=max_retries,
            retry_non_idempotent=retry_non_idempotent,
        )

    def call(
        self,
        operation_id: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, QueryValue]] = None,
        body: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        files: Any = None,
        data: Any = None,
        response_type: str = "json",
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        retry_non_idempotent: Optional[bool] = None,
    ) -> CrewRouterResponse:
        operation = _operation(operation_id)
        return self.http.request(
            operation["method"],
            _path(operation, path_params),
            query=query,
            body=body,
            headers=headers,
            files=files,
            data=data,
            response_type=response_type,
            timeout=timeout,
            max_retries=max_retries,
            retry_non_idempotent=retry_non_idempotent,
        )


class AsyncCrewRouter:
    """Asynchronous CrewRouter client."""

    contract_version = CONTRACT_VERSION

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        oauth_token: Optional[str] = None,
        auth_style: str = "bearer",
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
        max_retries: int = 0,
        retry_non_idempotent: bool = False,
        signature_mode: Optional[str] = None,
        user_agent: Optional[str] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.http = AsyncHttpClient(
            base_url=base_url,
            api_key=api_key,
            oauth_token=oauth_token,
            auth_style=auth_style,
            headers=headers,
            timeout=timeout,
            max_retries=max_retries,
            retry_non_idempotent=retry_non_idempotent,
            signature_mode=signature_mode,
            user_agent=user_agent,
            transport=transport,
            client=client,
        )
        self.gateway = _AsyncGateway(self)
        self.keys = _AsyncKeys(self)
        self.usage = _AsyncUsage(self)
        self.balance = _AsyncBalance(self)
        self.models = _AsyncModels(self)
        self.providers = _AsyncProviders(self)
        self.admin = _AsyncAdmin(self)

    @property
    def operations(self) -> dict[str, dict[str, Any]]:
        return OPERATIONS

    def operation(self, operation_id: str) -> dict[str, Any]:
        return _operation(operation_id)

    async def aclose(self) -> None:
        await self.http.aclose()

    async def __aenter__(self) -> "AsyncCrewRouter":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.aclose()

    async def request(self, method: str, path: str, **kwargs: Any) -> CrewRouterResponse:
        return await self.http.request(method, path, **kwargs)

    async def call(self, operation_id: str, *, path_params: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> CrewRouterResponse:
        operation = _operation(operation_id)
        return await self.http.request(operation["method"], _path(operation, path_params), **kwargs)


# ---------------------------------------------------------------------------
# Sync resources
# ---------------------------------------------------------------------------


class _Completions:
    def __init__(self, client: CrewRouter, path: str) -> None:
        self._client = client
        self._path = path

    def create(
        self,
        body: Union[ChatCompletionRequest, AnthropicMessagesRequest, OpenAIResponsesRequest],
        **kwargs: Any,
    ) -> CrewRouterResponse:
        operation_id = {
            "/v1/chat/completions": "gateway.chat.completions.create",
            "/v1/messages": "gateway.messages.create",
            "/v1/responses": "gateway.responses.create",
        }[self._path]
        return self._client.call(operation_id, body=body, **kwargs)

    def stream(self, body: Union[ChatCompletionRequest, AnthropicMessagesRequest, OpenAIResponsesRequest], *, idle_timeout: Optional[float] = None, headers: Optional[Mapping[str, str]] = None) -> Stream:
        return self._client.http.stream("POST", self._path, body=body, idle_timeout=idle_timeout, headers=headers)


class _ModelsGateway:
    def __init__(self, client: CrewRouter) -> None:
        self._client = client

    def list(self, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("gateway.models.list", **kwargs)


class _Gateway:
    def __init__(self, client: CrewRouter) -> None:
        self.chat = type("Chat", (), {})()
        self.chat.completions = _Completions(client, "/v1/chat/completions")
        self.messages = _Completions(client, "/v1/messages")
        self.responses = _Completions(client, "/v1/responses")
        self.models = _ModelsGateway(client)


class _Keys:
    def __init__(self, client: CrewRouter) -> None:
        self._client = client

    def list(self, **kwargs: Any) -> CrewRouterResponse:
        """List API keys visible to the current identity.

        ``key_value`` is null unless this credential has ``keys.secret`` and
        the row is owned by the authenticated user.
        """
        return self._client.call("user.apiKeys.list", **kwargs)


    def create(self, body: Mapping[str, Any], **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("user.apiKeys.create", body=body, **kwargs)

    def update(self, key_id: Any, body: Mapping[str, Any], **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("user.apiKeys.byId.update", path_params={"id": key_id}, body=body, **kwargs)

    def delete(self, key_id: Any, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("user.apiKeys.byId.delete", path_params={"id": key_id}, **kwargs)

    def get_models(self, key_id: Any, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("user.apiKeys.byId.models.list", path_params={"id": key_id}, **kwargs)

    def set_models(self, key_id: Any, body: Mapping[str, Any], **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("user.apiKeys.byId.models.update", path_params={"id": key_id}, body=body, **kwargs)

    def get_config(self, key_id: Any, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("user.apiKeys.byId.config.list", path_params={"id": key_id}, **kwargs)


class _Usage:
    def __init__(self, client: CrewRouter) -> None:
        self._client = client

    def get(self, query: Optional[Mapping[str, QueryValue]] = None, **kwargs: Any) -> CrewRouterResponse:
        """Return recent daily usage rows as an unwrapped JSON array."""
        return self._client.call("user.usage.list", query=query, **kwargs)


class _Balance:
    def __init__(self, client: CrewRouter) -> None:
        self._client = client

    def get(self, **kwargs: Any) -> CrewRouterResponse:
        """Return balance, rate limits, refund balance and optional team quota."""
        return self._client.call("user.balance.list", **kwargs)


class _Models:
    def __init__(self, client: CrewRouter) -> None:
        self._client = client

    def list(self, **kwargs: Any) -> CrewRouterResponse:
        """List models visible to the user's enabled Teams."""
        return self._client.call("user.models.list", **kwargs)


class _Providers:
    def __init__(self, client: CrewRouter) -> None:
        self._client = client

    def list(self, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("user.providers.list", **kwargs)


class _AdminUsers:
    def __init__(self, client: CrewRouter) -> None:
        self._client = client

    def list(self, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("admin.users.list", **kwargs)


class _AdminModels:
    def __init__(self, client: CrewRouter) -> None:
        self._client = client

    def list(self, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("admin.models.list", **kwargs)


class _AdminProviders:
    def __init__(self, client: CrewRouter) -> None:
        self._client = client

    def list(self, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("admin.providers.list", **kwargs)

    def get(self, provider_id: Any, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("admin.providers.byId.get", path_params={"id": provider_id}, **kwargs)

    def refresh_key(self, provider_id: Any, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("admin.providers.byId.refreshKey", path_params={"id": provider_id}, **kwargs)


class _AdminTeams:
    def __init__(self, client: CrewRouter) -> None:
        self._client = client

    def list(self, **kwargs: Any) -> CrewRouterResponse:
        return self._client.call("admin.teams.list", **kwargs)


class _Admin:
    def __init__(self, client: CrewRouter) -> None:
        self.users = _AdminUsers(client)
        self.models = _AdminModels(client)
        self.providers = _AdminProviders(client)
        self.teams = _AdminTeams(client)


# ---------------------------------------------------------------------------
# Async resources
# ---------------------------------------------------------------------------


class _AsyncCompletions:
    def __init__(self, client: AsyncCrewRouter, path: str) -> None:
        self._client = client
        self._path = path

    async def create(
        self,
        body: Union[ChatCompletionRequest, AnthropicMessagesRequest, OpenAIResponsesRequest],
        **kwargs: Any,
    ) -> CrewRouterResponse:
        operation_id = {
            "/v1/chat/completions": "gateway.chat.completions.create",
            "/v1/messages": "gateway.messages.create",
            "/v1/responses": "gateway.responses.create",
        }[self._path]
        return await self._client.call(operation_id, body=body, **kwargs)

    def stream(self, body: Union[ChatCompletionRequest, AnthropicMessagesRequest, OpenAIResponsesRequest], *, idle_timeout: Optional[float] = None, headers: Optional[Mapping[str, str]] = None) -> AsyncStreamRequest:
        return AsyncStreamRequest(
            self._client.http.stream(
                "POST",
                self._path,
                body=body,
                idle_timeout=idle_timeout,
                headers=headers,
            )
        )


class _AsyncModelsGateway:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self._client = client

    async def list(self, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("gateway.models.list", **kwargs)


class _AsyncGateway:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self.chat = type("Chat", (), {})()
        self.chat.completions = _AsyncCompletions(client, "/v1/chat/completions")
        self.messages = _AsyncCompletions(client, "/v1/messages")
        self.responses = _AsyncCompletions(client, "/v1/responses")
        self.models = _AsyncModelsGateway(client)


class _AsyncKeys:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self._client = client

    async def list(self, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.apiKeys.list", **kwargs)

    async def create(self, body: Mapping[str, Any], **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.apiKeys.create", body=body, **kwargs)

    async def update(self, key_id: Any, body: Mapping[str, Any], **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.apiKeys.byId.update", path_params={"id": key_id}, body=body, **kwargs)

    async def delete(self, key_id: Any, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.apiKeys.byId.delete", path_params={"id": key_id}, **kwargs)

    async def get_models(self, key_id: Any, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.apiKeys.byId.models.list", path_params={"id": key_id}, **kwargs)

    async def set_models(self, key_id: Any, body: Mapping[str, Any], **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.apiKeys.byId.models.update", path_params={"id": key_id}, body=body, **kwargs)

    async def get_config(self, key_id: Any, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.apiKeys.byId.config.list", path_params={"id": key_id}, **kwargs)


class _AsyncUsage:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self._client = client

    async def get(self, query: Optional[Mapping[str, QueryValue]] = None, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.usage.list", query=query, **kwargs)


class _AsyncBalance:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self._client = client

    async def get(self, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.balance.list", **kwargs)


class _AsyncModels:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self._client = client

    async def list(self, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.models.list", **kwargs)


class _AsyncProviders:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self._client = client

    async def list(self, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("user.providers.list", **kwargs)


class _AsyncAdminUsers:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self._client = client

    async def list(self, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("admin.users.list", **kwargs)


class _AsyncAdminModels:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self._client = client

    async def list(self, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("admin.models.list", **kwargs)


class _AsyncAdminProviders:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self._client = client

    async def list(self, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("admin.providers.list", **kwargs)

    async def get(self, provider_id: Any, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("admin.providers.byId.get", path_params={"id": provider_id}, **kwargs)

    async def refresh_key(self, provider_id: Any, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("admin.providers.byId.refreshKey", path_params={"id": provider_id}, **kwargs)


class _AsyncAdminTeams:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self._client = client

    async def list(self, **kwargs: Any) -> CrewRouterResponse:
        return await self._client.call("admin.teams.list", **kwargs)


class _AsyncAdmin:
    def __init__(self, client: AsyncCrewRouter) -> None:
        self.users = _AsyncAdminUsers(client)
        self.models = _AsyncAdminModels(client)
        self.providers = _AsyncAdminProviders(client)
        self.teams = _AsyncAdminTeams(client)
