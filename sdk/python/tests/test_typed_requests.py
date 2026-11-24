from __future__ import annotations

import unittest
from typing import get_type_hints

from crewrouter import (
    AnthropicMessagesRequest,
    ChatCompletionRequest,
    ChatMessage,
    OpenAIResponsesRequest,
)
from crewrouter.client import _AsyncCompletions, _Completions


class TypedRequestTests(unittest.TestCase):
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
