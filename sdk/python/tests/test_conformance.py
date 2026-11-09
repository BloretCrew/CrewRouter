from __future__ import annotations

import json
import unittest
from pathlib import Path

import httpx

from crewrouter import CrewRouter, CrewRouterRateLimitError

CASES_PATH = Path(__file__).resolve().parents[3] / "sdk/contract/conformance/cases.json"
CASES = json.loads(CASES_PATH.read_text(encoding="utf-8"))


def client_for(handler, **kwargs) -> CrewRouter:
    return CrewRouter(
        base_url="http://test",
        api_key="sk-test",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


class ConformanceTests(unittest.TestCase):
    def test_transport_fixtures(self) -> None:
        for fixture in CASES["transport"]:
            seen = {}

            def handler(request: httpx.Request) -> httpx.Response:
                seen["method"] = request.method
                seen["path"] = request.url.path
                seen["query"] = str(request.url.query, "utf-8")
                seen["authorization"] = request.headers.get("authorization")
                seen["x_api_key"] = request.headers.get("x-api-key")
                seen["content_type"] = request.headers.get("content-type")
                seen["body"] = json.loads(request.content) if request.content else None
                return httpx.Response(
                    fixture["response"]["status"],
                    json=fixture["response"].get("json"),
                    headers=fixture["response"].get("headers", {}),
                )

            with client_for(handler, auth_style=fixture["authStyle"]) as client:
                response = client.request(
                    fixture["method"],
                    fixture["path"],
                    query=fixture.get("query"),
                    body=fixture.get("body"),
                )

            expect = fixture["expect"]
            self.assertEqual(seen["method"], fixture["method"], fixture["name"])
            self.assertEqual(seen["path"], expect["path"], fixture["name"])
            self.assertEqual(seen["query"], expect.get("query", ""), fixture["name"])
            if expect.get("authorization"):
                self.assertEqual(seen["authorization"], expect["authorization"], fixture["name"])
            if expect.get("xApiKey"):
                self.assertEqual(seen["x_api_key"], expect["xApiKey"], fixture["name"])
                self.assertIsNone(seen["authorization"], fixture["name"])
            if expect.get("contentType"):
                self.assertTrue(seen["content_type"].startswith(expect["contentType"]), fixture["name"])
            if expect.get("body"):
                self.assertEqual(seen["body"], expect["body"], fixture["name"])
            if fixture["response"].get("json") is not None:
                self.assertEqual(response.data, fixture["response"]["json"], fixture["name"])
            if expect.get("requestId"):
                self.assertEqual(response.request_id, expect["requestId"], fixture["name"])
            if expect.get("signature"):
                self.assertEqual(response.signature, expect["signature"], fixture["name"])

    def test_error_fixtures(self) -> None:
        for fixture in CASES["errors"]:
            def handler(request: httpx.Request) -> httpx.Response:
                return httpx.Response(
                    fixture["status"],
                    json=fixture["body"],
                    headers=fixture.get("headers", {}),
                )

            with client_for(handler) as client:
                with self.assertRaises(Exception) as raised:
                    client.request("GET", "/fixture")
            error = raised.exception
            expect = fixture["expect"]
            self.assertEqual(error.status, expect["status"], fixture["name"])
            if expect.get("code"):
                self.assertEqual(error.code, expect["code"], fixture["name"])
            if expect.get("type"):
                self.assertEqual(error.type, expect["type"], fixture["name"])
            if expect.get("permission"):
                self.assertEqual(error.permission, expect["permission"], fixture["name"])
            if expect.get("message"):
                self.assertEqual(str(error), expect["message"], fixture["name"])
            if expect.get("protocol"):
                self.assertEqual(error.protocol, expect["protocol"], fixture["name"])
            if expect.get("requestId"):
                self.assertEqual(error.request_id, expect["requestId"], fixture["name"])

    def test_sse_fixtures(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content="".join(CASES["sse"]["chunks"]).encode("utf-8"),
            )

        with client_for(handler) as client:
            with client.gateway.chat.completions.stream({"messages": []}) as stream:
                events = [
                    {"event": event.event or "", "data": event.data, "done": event.done}
                    for event in stream
                ]
        self.assertEqual(events, CASES["sse"]["expect"])

    def test_retry_fixtures(self) -> None:
        for fixture in CASES["retry"]:
            attempts = {"count": 0}

            def handler(request: httpx.Request) -> httpx.Response:
                response = fixture["responses"][min(attempts["count"], len(fixture["responses"]) - 1)]
                attempts["count"] += 1
                return httpx.Response(
                    response["status"],
                    json=response.get("json"),
                    headers=response.get("headers", {}),
                )

            with client_for(handler, max_retries=fixture["maxRetries"]) as client:
                if fixture["expect"].get("status"):
                    response = client.request(
                        fixture["method"],
                        fixture["path"],
                        body=fixture.get("body"),
                    )
                    self.assertEqual(response.status, fixture["expect"]["status"], fixture["name"])
                else:
                    with self.assertRaises(CrewRouterRateLimitError) as raised:
                        client.request(
                            fixture["method"],
                            fixture["path"],
                            body=fixture.get("body"),
                        )
                    self.assertEqual(raised.exception.status, fixture["expect"]["errorStatus"], fixture["name"])
            self.assertEqual(attempts["count"], fixture["expect"]["attempts"], fixture["name"])


if __name__ == "__main__":
    unittest.main()
