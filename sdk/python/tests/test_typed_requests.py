from __future__ import annotations

import unittest
from typing import get_type_hints

from crewrouter import (
    AnthropicMessagesRequest,
    ApiKeyListItem,
    DailyUsageItem,
    UserBalance,
    ChatCompletionRequest,
    ChatMessage,
    OpenAIResponsesRequest,
)
from crewrouter.client import _AsyncCompletions, _Completions


class TypedRequestTests(unittest.TestCase):
    def test_management_response_types_allow_real_wire_shapes(self) -> None:
        key: ApiKeyListItem = {
            "id": 7,
            "name": "CI",
            "key_value": None,
            "permissions": ["keys.read"],
            "tags": [],
            "model_queue": [],
        }
        usage: DailyUsageItem = {
            "date": "2026-01-01",
            "total_tokens": "12",
            "total_cost": "0.25",
            "total_requests": "2",
        }
        balance: UserBalance = {
            "balance": 10.0,
            "refund_balance": 8.0,
            "rate_limit_rpm": 60,
            "rate_limit_tpm": 1000,
            "group": None,
        }
        self.assertIsNone(key["key_value"])
        self.assertEqual(usage["total_tokens"], "12")
        self.assertIsNone(balance["group"])

    def test_gateway_request_types_are_exported(self) -> None:
        message: ChatMessage = {"role": "user", "content": "hello"}
        chat: ChatCompletionRequest = {"messages": [message], "stream": True}
        anthropic: AnthropicMessagesRequest = {"messages": [message], "max_tokens": 20}
        responses: OpenAIResponsesRequest = {"input": "hello"}

        self.assertTrue(chat["stream"])
        self.assertEqual(anthropic["max_tokens"], 20)
        self.assertEqual(responses["input"], "hello")

    def test_sync_and_async_gateway_helpers_expose_typed_request_union(self) -> None:
        expected = {"ChatCompletionRequest", "AnthropicMessagesRequest", "OpenAIResponsesRequest"}
        for method in (_Completions.create, _Completions.stream, _AsyncCompletions.create, _AsyncCompletions.stream):
            annotation = get_type_hints(method).get("body")
            args = getattr(annotation, "__args__", ())
            names = {getattr(item, "__name__", "") for item in args}
            self.assertEqual(names, expected)


if __name__ == "__main__":
    unittest.main()
