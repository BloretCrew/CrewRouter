from __future__ import annotations

import base64
import random
import time
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence, Union

import httpx

from ._sse import AsyncStream, Stream
from .errors import (
    CrewRouterAbortError,
    CrewRouterConnectionError,
    CrewRouterError,
    CrewRouterTimeoutError,
    error_from_response,
    parse_retry_after,
    request_id_from_headers,
)

QueryValue = Union[str, int, float, bool, None, Sequence[Union[str, int, float, bool]]]

RETRYABLE_STATUSES = {408, 429, 500, 502, 503, 504}
DEFAULT_MANAGEMENT_TIMEOUT = 30.0
DEFAULT_GATEWAY_TIMEOUT = 600.0
DEFAULT_STREAM_IDLE_TIMEOUT = 120.0
DEFAULT_USER_AGENT = "crewrouter-sdk-python/27.0.0-beta.2"


@dataclass
class CrewRouterResponse:
    data: Any
    raw: httpx.Response
    status: int
    headers: httpx.Headers
    request_id: Optional[str]
    signature: Optional[str]
    signature_base64: Optional[str]


def default_timeout_for(path: str) -> float:
    return DEFAULT_GATEWAY_TIMEOUT if path.startswith("/v1/") else DEFAULT_MANAGEMENT_TIMEOUT


def _signature(headers: httpx.Headers) -> tuple[Optional[str], Optional[str]]:
    plain = headers.get("x-crewrouter-signature")
    encoded = headers.get("x-crewrouter-signature-b64")
    decoded: Optional[str] = None
    if encoded:
        try:
            decoded = base64.b64decode(encoded).decode("utf-8")
        except Exception:
            decoded = None
    return plain or decoded, encoded


def _method_may_retry(method: str, retry_non_idempotent: bool) -> bool:
    upper = method.upper()
    if upper in {"GET", "HEAD", "PUT", "DELETE", "OPTIONS"}:
        return True
    return retry_non_idempotent


def _retry_delay(attempt: int, retry_after: Optional[float]) -> float:
    if retry_after is not None:
        return max(0.0, retry_after)
    base = min(8.0, 0.5 * (2 ** attempt))
    return base * random.uniform(0.75, 1.25)


def _query_params(query: Optional[Mapping[str, QueryValue]]) -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = []
    for key, value in (query or {}).items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            for item in value:
                items.append((key, str(item)))
        else:
            items.append((key, str(value)))
    return items


def _error_text(response: httpx.Response) -> str:
    try:
        return response.content.decode("utf-8", errors="replace")
    except Exception:
        return ""


def _parse_response(response: httpx.Response, response_type: str) -> CrewRouterResponse:
    request_id = request_id_from_headers(response.headers)
    signature, signature_b64 = _signature(response.headers)
    if response_type == "stream":
        data: Any = response
    elif response_type in {"content", "arrayBuffer", "bytes"}:
        data = response.content
    elif response_type == "text":
        data = response.text
    else:
        text = response.text
        if not text:
            data = None
        else:
            try:
                import json

                data = json.loads(text)
            except Exception as exc:
                raise CrewRouterError(
                    "Response was not valid JSON",
                    status=response.status_code,
                    request_id=request_id,
                    raw_body=text,
                    headers=response.headers,
                ) from exc
    return CrewRouterResponse(
        data=data,
        raw=response,
        status=response.status_code,
        headers=response.headers,
        request_id=request_id,
        signature=signature,
        signature_base64=signature_b64,
    )


class _BaseHttp:
    def __init__(
        self,
        *,
        base_url: Optional[str],
        api_key: Optional[str],
        oauth_token: Optional[str],
        auth_style: str,
        headers: Optional[Mapping[str, str]],
        timeout: Optional[float],
        max_retries: int,
        retry_non_idempotent: bool,
        signature_mode: Optional[str],
        user_agent: Optional[str],
    ) -> None:
        import os

        self.base_url = (base_url or os.environ.get("CREWROUTER_BASE_URL") or "").rstrip("/")
        if not self.base_url:
            raise CrewRouterError("base_url is required (or set CREWROUTER_BASE_URL)")
        self.api_key = api_key or os.environ.get("CREWROUTER_API_KEY")
        self.oauth_token = oauth_token
        self.auth_style = auth_style
        self.extra_headers = dict(headers or {})
        self.timeout = timeout
        self.max_retries = max(0, int(max_retries))
        self.retry_non_idempotent = retry_non_idempotent
        self.signature_mode = signature_mode
        self.user_agent = user_agent or DEFAULT_USER_AGENT

    def _headers(self, extra: Optional[Mapping[str, str]] = None) -> dict[str, str]:
        headers = {"User-Agent": self.user_agent}
        headers.update(self.extra_headers)
        headers.update(extra or {})
        if self.oauth_token:
            headers["Authorization"] = f"Bearer {self.oauth_token}"
        elif self.api_key:
            if self.auth_style == "x-api-key":
                headers["x-api-key"] = self.api_key
            else:
                headers["Authorization"] = f"Bearer {self.api_key}"
        if self.signature_mode:
            headers["x-crewrouter-signature-mode"] = self.signature_mode
        return headers

    def _request_kwargs(
        self,
        *,
        query: Optional[Mapping[str, QueryValue]],
        body: Any,
        headers: Optional[Mapping[str, str]],
        files: Any,
        data: Any,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "params": _query_params(query),
            "headers": self._headers(headers),
        }
        if files is not None:
            kwargs["files"] = files
            if data is not None:
                kwargs["data"] = data
        elif data is not None:
            kwargs["data"] = data
        elif body is not None:
            kwargs["json"] = body
        return kwargs


class HttpClient(_BaseHttp):
    def __init__(self, *, transport: Optional[httpx.BaseTransport] = None, client: Optional[httpx.Client] = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            self._client = httpx.Client(transport=transport, timeout=DEFAULT_MANAGEMENT_TIMEOUT)
            self._owns_client = True

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "HttpClient":
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
        retries = self.max_retries if max_retries is None else max(0, int(max_retries))
        allow_non_idempotent = self.retry_non_idempotent if retry_non_idempotent is None else retry_non_idempotent
        can_retry_method = _method_may_retry(method, allow_non_idempotent)
        request_timeout = timeout if timeout is not None else (self.timeout if self.timeout is not None else default_timeout_for(path))
        url = f"{self.base_url}/{path.lstrip('/')}"
        kwargs = self._request_kwargs(query=query, body=body, headers=headers, files=files, data=data)

        for attempt in range(retries + 1):
            try:
                response = self._client.request(method, url, timeout=request_timeout, **kwargs)
            except httpx.TimeoutException as exc:
                if attempt < retries and can_retry_method:
                    time.sleep(_retry_delay(attempt, None))
                    continue
                raise CrewRouterTimeoutError(f"Request timed out after {request_timeout}s") from exc
            except httpx.HTTPError as exc:
                if attempt < retries and can_retry_method:
                    time.sleep(_retry_delay(attempt, None))
                    continue
                raise CrewRouterConnectionError(str(exc)) from exc

            if response.status_code >= 400:
                api_error = error_from_response(response.status_code, response.headers, _error_text(response))
                response.close()
                if attempt < retries and can_retry_method and response.status_code in RETRYABLE_STATUSES:
                    time.sleep(_retry_delay(attempt, api_error.retry_after))
                    continue
                raise api_error

            return _parse_response(response, response_type)

        raise CrewRouterError("Retry loop exhausted")

    def stream(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, QueryValue]] = None,
        body: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        files: Any = None,
        data: Any = None,
        idle_timeout: Optional[float] = None,
    ) -> Stream:
        url = f"{self.base_url}/{path.lstrip('/')}"
        kwargs = self._request_kwargs(query=query, body=body, headers=headers, files=files, data=data)
        timeout = idle_timeout if idle_timeout is not None else DEFAULT_STREAM_IDLE_TIMEOUT
        request = self._client.build_request(method, url, timeout=timeout, **kwargs)
        response = self._client.send(request, stream=True)
        if response.status_code >= 400:
            text = _error_text(response)
            error = error_from_response(response.status_code, response.headers, text)
            response.close()
            raise error
        return Stream(response)


class AsyncHttpClient(_BaseHttp):
    def __init__(self, *, transport: Optional[httpx.AsyncBaseTransport] = None, client: Optional[httpx.AsyncClient] = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            self._client = httpx.AsyncClient(transport=transport, timeout=DEFAULT_MANAGEMENT_TIMEOUT)
            self._owns_client = True

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> "AsyncHttpClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.aclose()

    async def request(
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
        import asyncio

        retries = self.max_retries if max_retries is None else max(0, int(max_retries))
        allow_non_idempotent = self.retry_non_idempotent if retry_non_idempotent is None else retry_non_idempotent
        can_retry_method = _method_may_retry(method, allow_non_idempotent)
        request_timeout = timeout if timeout is not None else (self.timeout if self.timeout is not None else default_timeout_for(path))
        url = f"{self.base_url}/{path.lstrip('/')}"
        kwargs = self._request_kwargs(query=query, body=body, headers=headers, files=files, data=data)

        for attempt in range(retries + 1):
            try:
                response = await self._client.request(method, url, timeout=request_timeout, **kwargs)
            except httpx.TimeoutException as exc:
                if attempt < retries and can_retry_method:
                    await asyncio.sleep(_retry_delay(attempt, None))
                    continue
                raise CrewRouterTimeoutError(f"Request timed out after {request_timeout}s") from exc
            except httpx.HTTPError as exc:
                if attempt < retries and can_retry_method:
                    await asyncio.sleep(_retry_delay(attempt, None))
                    continue
                raise CrewRouterConnectionError(str(exc)) from exc

            if response.status_code >= 400:
                api_error = error_from_response(response.status_code, response.headers, _error_text(response))
                await response.aclose()
                if attempt < retries and can_retry_method and response.status_code in RETRYABLE_STATUSES:
                    await asyncio.sleep(_retry_delay(attempt, api_error.retry_after))
                    continue
                raise api_error

            return _parse_response(response, response_type)

        raise CrewRouterError("Retry loop exhausted")

    async def stream(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, QueryValue]] = None,
        body: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        files: Any = None,
        data: Any = None,
        idle_timeout: Optional[float] = None,
    ) -> AsyncStream:
        url = f"{self.base_url}/{path.lstrip('/')}"
        kwargs = self._request_kwargs(query=query, body=body, headers=headers, files=files, data=data)
        timeout = idle_timeout if idle_timeout is not None else DEFAULT_STREAM_IDLE_TIMEOUT
        request = self._client.build_request(method, url, timeout=timeout, **kwargs)
        response = await self._client.send(request, stream=True)
        if response.status_code >= 400:
            text = _error_text(response)
            error = error_from_response(response.status_code, response.headers, text)
            await response.aclose()
            raise error
        return AsyncStream(response)
