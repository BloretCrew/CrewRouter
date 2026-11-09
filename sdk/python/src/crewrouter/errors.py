from __future__ import annotations

import json
from email.utils import parsedate_to_datetime
from typing import Any, Optional

import httpx


class CrewRouterError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        code: Optional[str] = None,
        type: Optional[str] = None,
        permission: Optional[str] = None,
        request_id: Optional[str] = None,
        retry_after: Optional[float] = None,
        raw_body: Any = None,
        headers: Optional[httpx.Headers] = None,
        protocol: str = "unknown",
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.type = type
        self.permission = permission
        self.request_id = request_id
        self.retry_after = retry_after
        self.raw_body = raw_body
        self.headers = headers
        self.protocol = protocol


class CrewRouterBadRequestError(CrewRouterError):
    pass


class CrewRouterAuthenticationError(CrewRouterError):
    pass


class CrewRouterPermissionError(CrewRouterError):
    pass


class CrewRouterNotFoundError(CrewRouterError):
    pass


class CrewRouterConflictError(CrewRouterError):
    pass


class CrewRouterRateLimitError(CrewRouterError):
    pass


class CrewRouterServerError(CrewRouterError):
    pass


class CrewRouterConnectionError(CrewRouterError):
    pass


class CrewRouterTimeoutError(CrewRouterConnectionError):
    pass


class CrewRouterAbortError(CrewRouterError):
    pass


class CrewRouterStreamError(CrewRouterError):
    pass


def parse_retry_after(headers: httpx.Headers) -> Optional[float]:
    value = headers.get("retry-after")
    if not value:
        return None
    try:
        seconds = float(value)
        return max(0.0, seconds)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
        import datetime

        now = datetime.datetime.now(datetime.timezone.utc)
        return max(0.0, (when - now).total_seconds())
    except Exception:
        return None


def request_id_from_headers(headers: httpx.Headers) -> Optional[str]:
    return headers.get("x-crewrouter-request-id") or headers.get("x-request-id")


def parse_error_payload(
    status: int, headers: httpx.Headers, text: str
) -> dict[str, Any]:
    parsed: Any = None
    if text:
        try:
            parsed = json.loads(text)
        except Exception:
            parsed = None

    if isinstance(parsed, dict):
        # Anthropic: {"type":"error","error":{...}}
        if parsed.get("type") == "error" and isinstance(parsed.get("error"), dict):
            error = parsed["error"]
            return {
                "message": str(error.get("message") or error.get("error") or f"HTTP {status}"),
                "type": error.get("type") if isinstance(error.get("type"), str) else None,
                "code": error.get("code") if isinstance(error.get("code"), str) else None,
                "permission": error.get("permission") if isinstance(error.get("permission"), str) else None,
                "protocol": "anthropic",
                "raw_body": parsed,
            }
        # OpenAI / Responses: {"error": {...}}
        if isinstance(parsed.get("error"), dict):
            error = parsed["error"]
            return {
                "message": str(error.get("message") or error.get("code") or f"HTTP {status}"),
                "type": error.get("type") if isinstance(error.get("type"), str) else None,
                "code": error.get("code") if isinstance(error.get("code"), str) else None,
                "permission": error.get("permission") if isinstance(error.get("permission"), str) else None,
                "protocol": "openai",
                "raw_body": parsed,
            }
        # Management: {"error": "message", "code": ...}
        if isinstance(parsed.get("error"), str):
            return {
                "message": parsed["error"],
                "type": parsed.get("type") if isinstance(parsed.get("type"), str) else None,
                "code": parsed.get("code") if isinstance(parsed.get("code"), str) else None,
                "permission": parsed.get("permission") if isinstance(parsed.get("permission"), str) else None,
                "protocol": "management",
                "raw_body": parsed,
            }
        if isinstance(parsed.get("message"), str):
            return {
                "message": parsed["message"],
                "type": parsed.get("type") if isinstance(parsed.get("type"), str) else None,
                "code": parsed.get("code") if isinstance(parsed.get("code"), str) else None,
                "permission": parsed.get("permission") if isinstance(parsed.get("permission"), str) else None,
                "protocol": "management",
                "raw_body": parsed,
            }

    return {
        "message": text.strip() or f"HTTP {status}",
        "type": None,
        "code": None,
        "permission": None,
        "protocol": "unknown",
        "raw_body": parsed if parsed is not None else text,
    }


_ERROR_CLASSES = {
    400: CrewRouterBadRequestError,
    413: CrewRouterBadRequestError,
    422: CrewRouterBadRequestError,
    401: CrewRouterAuthenticationError,
    403: CrewRouterPermissionError,
    404: CrewRouterNotFoundError,
    409: CrewRouterConflictError,
    429: CrewRouterRateLimitError,
}


def error_from_response(status: int, headers: httpx.Headers, text: str) -> CrewRouterError:
    parsed = parse_error_payload(status, headers, text)
    cls = _ERROR_CLASSES.get(status)
    if cls is None:
        cls = CrewRouterServerError if status >= 500 else CrewRouterError
    return cls(
        parsed["message"],
        status=status,
        code=parsed["code"],
        type=parsed["type"],
        permission=parsed["permission"],
        request_id=request_id_from_headers(headers),
        retry_after=parse_retry_after(headers),
        raw_body=parsed["raw_body"],
        headers=headers,
        protocol=parsed["protocol"],
    )
