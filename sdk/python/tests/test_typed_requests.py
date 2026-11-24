from __future__ import annotations

import unittest
from typing import get_type_hints

from crewrouter import (
    AnthropicMessagesRequest,
    ApiKeyListItem,
    ApiKeyModelsResponse,
    ApiKeyAvailableModel,
    ApiKeyModelQueueItem,
    ApiKeyQueueItem,
    ApiKeyDailyUsageItem,
    ApiKeyMembersResponse,
    ApiKeyQuotaWarning,
    ApiKeySchedule,
    CurrentModelResponse,
    UserCurrentModel,
    DailyUsageItem,
    UserBalance,
    UserCodeBalanceItem,
    UserModelListItem,
    UserProviderListItem,
    UserProduct,
    UserKeyTag,
    UserUsageLog,
    UserUsageLogsResponse,
    ModelUptimeDailyResponse,
    ModelUptimeSlotResponse,
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
        key_usage: ApiKeyDailyUsageItem = {
            "date": "2026-01-01",
            "model_id": "m1",
            "model_name": None,
            "tokens": "12",
            "cost": "0.1",
            "requests": "2",
        }
        model: UserModelListItem = {
            "id": "model-1",
            "upstream_model_id": "upstream-1",
            "name": "Model One",
            "alias": None,
            "provider": "p1",
            "provider_name": "Provider",
            "input_price_per_1k_tokens": "0.01",
            "output_price_per_1k_tokens": 0.02,
            "output_kind": "chat",
        }
        self.assertIsNone(key["key_value"])
        self.assertEqual(usage["total_tokens"], "12")
        self.assertIsNone(balance["group"])
        provider: UserProviderListItem = {
            "id": "shared-provider",
            "name": "Shared",
            "format": "openai",
            "created_by": None,
        }
        self.assertIsNone(model["alias"])
        self.assertIsNone(provider["created_by"])
        key_tag: UserKeyTag = {
            "id": 3,
            "name": "prod",
            "color": "#00aa00",
            "sort_order": 1,
            "created_at": "2026-01-01T00:00:00.000Z",
        }
        self.assertIsNone(key_usage["model_name"])
        members: ApiKeyMembersResponse = {
            "is_owner": True,
            "members": [{"id": 9, "username": "member", "email": "member@example.test", "created_at": "2026-01-01T00:00:00.000Z"}],
        }
        self.assertEqual(key_tag["sort_order"], 1)
        quota_warning: ApiKeyQuotaWarning = {"quota_warning_enabled": True}
        schedule: ApiKeySchedule = {
            "schedule_enabled": False,
            "schedule_on_time": None,
            "schedule_off_time": None,
            "schedule_days": [0, 1, 2, 3, 4, 5, 6],
            "schedule_timezone": "Asia/Shanghai",
        }
        self.assertEqual(members["members"][0]["username"], "member")
        self.assertTrue(quota_warning["quota_warning_enabled"])
        current_model: CurrentModelResponse = {"currentModel": None}
        selected_model: UserCurrentModel = {"id": "m1", "name": "Model", "provider": "p1"}
        self.assertIsNone(schedule["schedule_on_time"])
        self.assertIsNone(current_model["currentModel"])
        usage_log: UserUsageLog = {
            "id": 1, "user_id": 7, "model_id": None, "api_key_id": 3,
            "tokens_used": "12", "prompt_tokens": "10", "completion_tokens": "2", "cached_tokens": "0",
            "provider_id": None, "request_type": "chat", "request_source": "unknown", "user_agent": None,
            "latency_ms": "25", "ip_address": None, "cost": "0.01", "created_at": "2026-01-01T00:00:00Z",
            "key_prefix": "sk-test", "key_name": "CI", "series": None, "model_name": "Model",
            "upstream_model_id": None, "requested_model": None, "resolved_model": None,
            "response_model": None, "provider_name": None,
        }
        usage_logs: UserUsageLogsResponse = {"total": 1, "page": 1, "logs": [usage_log]}
        available_model: ApiKeyAvailableModel = {
            "id": "m1", "name": "Model", "provider": "p1", "series": "s1",
            "description": None, "enabled": True, "icon_url": None,
            "input_price_per_1k_tokens": "0.01", "output_price_per_1k_tokens": 0.02,
            "assigned": True, "sort_order": 0,
        }
        queue_item: ApiKeyModelQueueItem = {
            "model_id": "m1", "id": "m1", "name": "Model", "provider": "p1",
            "series": "s1", "icon_url": None, "sort_order": 0,
        }
        key_models: ApiKeyModelsResponse = {"models": [available_model], "queue": [queue_item]}
        self.assertEqual(selected_model["id"], "m1")
        self.assertEqual(usage_logs["logs"][0]["tokens_used"], "12")
        product: UserProduct = {"id": 1, "name": "Product", "description": None, "image_url": None, "link": None, "sort_order": 0}
        self.assertEqual(key_models["queue"][0]["sort_order"], 0)
        code_balance: UserCodeBalanceItem = {
            "amount": "2.5", "fee_rate": "0.1", "code": "redeem-1",
            "code_amount": "3", "net_amount": "2.2727",
        }
        self.assertIsNone(product["description"])
        uptime_daily: ModelUptimeDailyResponse = {"days": 7, "granularity": "day", "items": {}}
        uptime_slots: ModelUptimeSlotResponse = {"days": 1, "hours": 24, "slots": 96, "granularity": "15m", "items": {}}
        self.assertEqual(code_balance["net_amount"], "2.2727")
        self.assertEqual(uptime_daily["granularity"], "day")
        self.assertEqual(uptime_slots["granularity"], "15m")

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
