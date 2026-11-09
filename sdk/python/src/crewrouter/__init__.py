"""CrewRouter Python SDK.

Synchronous and asynchronous clients for the CrewRouter OpenAI/Anthropic
compatible gateway and management API.
"""

from ._http import CrewRouterResponse
from ._sse import AsyncStream, AsyncStreamRequest, Stream, StreamEvent
from .client import AsyncCrewRouter, CrewRouter
from .errors import (
    CrewRouterAbortError,
    CrewRouterAuthenticationError,
    CrewRouterBadRequestError,
    CrewRouterConflictError,
    CrewRouterConnectionError,
    CrewRouterError,
    CrewRouterNotFoundError,
    CrewRouterPermissionError,
    CrewRouterRateLimitError,
    CrewRouterServerError,
    CrewRouterStreamError,
    CrewRouterTimeoutError,
)
from .generated.operations import CONTRACT_VERSION, OPERATIONS, OPERATION_LIST

__version__ = "0.1.0"

__all__ = [
    "CrewRouter",
    "AsyncCrewRouter",
    "CrewRouterResponse",
    "Stream",
    "AsyncStream",
    "AsyncStreamRequest",
    "StreamEvent",
    "CONTRACT_VERSION",
    "OPERATIONS",
    "OPERATION_LIST",
    "CrewRouterError",
    "CrewRouterBadRequestError",
    "CrewRouterAuthenticationError",
    "CrewRouterPermissionError",
    "CrewRouterNotFoundError",
    "CrewRouterConflictError",
    "CrewRouterRateLimitError",
    "CrewRouterServerError",
    "CrewRouterConnectionError",
    "CrewRouterTimeoutError",
    "CrewRouterAbortError",
    "CrewRouterStreamError",
]
