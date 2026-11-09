from __future__ import annotations

import asyncio
import json
import unittest
from typing import Any

import httpx

from crewrouter import (
    AsyncCrewRouter,
    CrewRouter,
    CrewRouterPermissionError,
    CrewRouterRateLimitError,
)


def make_client(handler, **kwargs: Any) -> CrewRouter:
    return CrewRouter(
        base_url="http://test",
        api_key="sk-test",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


def make_async_client(handler, **kwargs: Any) -> AsyncCrewRouter:
    return AsyncCrewRouter(
        base_url="http://test",
        api_key="sk-test",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


class SyncClientTests(unittest.TestCase):
    def test_gateway_chat_sends_auth_json_and_reads_metadata(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["method"] = request.method
            seen["path"] = request.url.path
            seen["auth"] = request.headers.get("authorization")
            seen["body"] = json.loads(request.content.decode())
            return httpx.Response(
                200,
                json={"id": "chatcmpl-1", "choices": []},
                headers={
                    "x-crewrouter-request-id": "req-123",
                    "x-crewrouter-signature": "signed",
                },
            )

        with make_client(handler) as client:
            response = client.gateway.chat.completions.create(
                {"model": "claude-fable-5", "messages": []}
            )

        self.assertEqual(response.status, 200)
        self.assertEqual(response.data, {"id": "chatcmpl-1", "choices": []})
        self.assertEqual(response.request_id, "req-123")
        self.assertEqual(response.signature, "signed")
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["path"], "/v1/chat/completions")
        self.assertEqual(seen["auth"], "Bearer sk-test")
        self.assertEqual(seen["body"], {"model": "claude-fable-5", "messages": []})

    def test_x_api_key_auth_style(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["x-api-key"] = request.headers.get("x-api-key")
            seen["authorization"] = request.headers.get("authorization")
            return httpx.Response(200, json={"object": "list", "data": []})

        with make_client(handler, auth_style="x-api-key") as client:
            client.gateway.models.list()

        self.assertEqual(seen["x-api-key"], "sk-test")
        self.assertIsNone(seen["authorization"])

    def test_call_substitutes_path_params_and_query(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["path"] = request.url.path
            seen["query"] = str(request.url.query, "utf-8")
            return httpx.Response(200, json={"data": []})

        with make_client(handler) as client:
            client.call(
                "user.apiKeys.byId.models.list",
                path_params={"id": 42},
                query={"days": 7, "tag": ["a", "b"], "skip": None},
            )

        self.assertEqual(seen["path"], "/api/user/api-keys/42/models")
        self.assertEqual(seen["query"], "days=7&tag=a&tag=b")

    def test_management_error_exposes_code_and_permission(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                403,
                json={
                    "error": "API Key 没有该权限: keys.read",
                    "code": "permission_denied",
                    "permission": "keys.read",
                },
            )

        with make_client(handler) as client:
            with self.assertRaises(CrewRouterPermissionError) as raised:
                client.keys.list()

        error = raised.exception
        self.assertEqual(error.status, 403)
        self.assertEqual(error.code, "permission_denied")
        self.assertEqual(error.permission, "keys.read")
        self.assertEqual(error.protocol, "management")

    def test_sse_stream_handles_events_and_done(self) -> None:
        payload = (
            'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'
            ": keep-alive\n\n"
            'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n'
            "data: [DONE]\n\n"
        )

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=payload.encode("utf-8"),
            )

        with make_client(handler) as client:
            with client.gateway.chat.completions.stream({"messages": []}) as stream:
                events = list(stream)

        self.assertEqual(len(events), 3)
        self.assertEqual(events[0].parsed, {"choices": [{"delta": {"content": "你好"}}]})
        self.assertFalse(events[0].done)
        self.assertEqual(events[1].event, "message_delta")
        self.assertTrue(events[2].done)

    def test_get_retries_429_and_post_does_not_by_default(self) -> None:
        attempts = {"get": 0, "post": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            key = "get" if request.method == "GET" else "post"
            attempts[key] += 1
            return httpx.Response(429, json={"error": "slow down"}, headers={"retry-after": "0"})

        with make_client(handler, max_retries=2) as client:
            with self.assertRaises(CrewRouterRateLimitError):
                client.gateway.chat.completions.create({"messages": []})
            with self.assertRaises(CrewRouterRateLimitError):
                client.gateway.models.list()

        self.assertEqual(attempts["post"], 1)
        self.assertEqual(attempts["get"], 3)

    def test_session_only_operation_is_rejected_before_request(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("request should not be sent")

        with make_client(handler) as client:
            with self.assertRaisesRegex(Exception, "session-only"):
                client.call("2fa.status.list")


class AsyncClientTests(unittest.TestCase):
    def test_async_gateway_and_stream(self) -> None:
        payload = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["path"] = request.url.path
            if request.url.path == "/v1/chat/completions":
                return httpx.Response(
                    200,
                    headers={"content-type": "text/event-stream"},
                    content=payload.encode("utf-8"),
                )
            return httpx.Response(200, json={"object": "list", "data": []})

        async def run() -> None:
            async with make_async_client(handler) as client:
                models = await client.gateway.models.list()
                self.assertEqual(models.status, 200)
                async with client.gateway.chat.completions.stream({"messages": []}) as stream:
                    events = [event async for event in stream]
                self.assertEqual(events[0].parsed, {"choices": [{"delta": {"content": "ok"}}]})
                self.assertTrue(events[1].done)

        asyncio.run(run())
        self.assertEqual(seen["path"], "/v1/chat/completions")


if __name__ == "__main__":
    unittest.main()
