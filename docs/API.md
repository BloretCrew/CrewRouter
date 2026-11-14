# CrewRouter HTTP API

CrewRouter exposes an OpenAI/Anthropic/Gemini-compatible gateway plus a management API.

## Machine-readable contract

- OpenAPI 3.1: [`docs/api/openapi.json`](./api/openapi.json)
- Generated endpoint table: [`docs/api/reference.md`](./api/reference.md)
- SDK contract source: [`sdk/contract/operations.json`](../sdk/contract/operations.json)

The OpenAPI document is generated from the Express routers and the API key
permission catalog. Untyped management responses are marked
`x-crewrouter-schema-status: untyped`; the SDK does not fabricate schemas.

## Gateway endpoints

| Method | Path | Protocol |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/responses` | OpenAI Responses |
| GET | `/v1/models` | OpenAI Models (virtual list per key) |
| POST | `/v1beta/models/{model}:generateContent` | Google Gemini generateContent |
| POST | `/v1beta/models/{model}:streamGenerateContent?alt=sse` | Google Gemini streaming |
| POST | `/v1beta/models/{model}:countTokens` | Google Gemini token counting |
| GET | `/v1beta/models` | Google Gemini model list |
| POST | `/v1beta/interactions` | Google Gemini Interactions API |
| GET/DELETE | `/v1beta/interactions/{id}` | Interactions retrieval/deletion |
| POST | `/v1beta/interactions/{id}/cancel` | Interactions cancellation |

The Gemini endpoints are also available under `/v1` (for example
`/v1/models/{model}:generateContent` and `/v1/interactions`). The same
OpenAI/Anthropic/Responses handlers are mounted at `/api/chat/completions`,
`/api/messages`, `/api/responses` and `/api/models`.

Gemini clients authenticate with `x-goog-api-key: sk-...` or `?key=sk-...`
(query keys are accepted only on Gemini routes). Interactions state is stored
locally per gateway user so `previous_interaction_id` works regardless of which
upstream provider serves the turn.

See [docs/sdk/gateway.md](./sdk/gateway.md) for model routing, streaming,
signatures, limits and Fusion.

## Authentication

```http
Authorization: Bearer sk-...
```

```http
x-api-key: sk-...
```

```http
x-goog-api-key: sk-...
```

OAuth access tokens (`crh_...`) are Bearer tokens accepted only on gateway and
client-event endpoints. Browser sessions use the `connect.sid` cookie.

See [docs/api-key-permissions.md](./api-key-permissions.md) and
[docs/sdk/authentication.md](./sdk/authentication.md).

## Management API

The management API covers users, API keys, models, providers, teams, usage,
billing, notifications, plugins, OAuth clients, audit logs and settings. Every
route is listed in the generated reference with its required permission and auth
modes.

- Non-session routes are callable with an API key that has the required
  permission.
- `admin.*` permissions additionally require `users.is_admin = true`.
- Session-only routes (`/auth/*`, `/api/2fa/*`, `/api/passkey/*`, `/api/setup/*`,
  `/api/admin/update/*`, `/oauth/authorize*`, `/oauth/authorizations*`,
  `/api/user/model-trace/*`) never accept API keys.

### Reply signatures

Signatures are optional display footers, not cryptographic signatures or access policies.
User defaults are off. A Key can inherit the owner's switch (`null`), explicitly enable it
(`true`), or disable it (`false`). The Key template independently overrides the user's
when non-empty; `null` or blank inherits the user template. An empty effective template
produces no signature and never falls back to the suggested template.

- `GET /api/user/signature`: `{ enabled, template, defaults: { template, variables } }`.
- `PUT /api/user/signature`: complete body `{ "enabled": false, "template": "" }`.
- `GET /api/user/api-keys/{id}/signature`: `{ enabled, template, inherited, effective }`.
- `PUT /api/user/api-keys/{id}/signature`: complete body
  `{ "enabled": null, "template": null }` restores both defaults.

Both PUT fields are required. Templates are trimmed and limited to 2000 UTF-16 code
units; invalid types, missing fields or conflicting legacy fields return 400 without
changing settings. The user endpoint requires `account.profile.read/write`; Key endpoints
require `keys.read/write` and ownership/shared-Key management access. Shared Keys inherit
the owner's defaults, not the managing member's defaults.

For one compatibility release, Key responses also include `key_signature_*` and
`user_signature_*`; Key writes accept `signature_enabled/signature_template` and
`key_signature_*`. Legacy `PUT /api/user/settings` remains a partial update for
`api_signature_enabled/api_signature_template`. New clients should use `/signature`.

`X-CrewRouter-Signature-Mode` controls delivery, not whether the signature is enabled:
`header` sends headers only, `content` only appends to existing text, and `both` does both.
Streaming has no late response headers; `header` therefore leaves the body untouched and
returns no signature. Structured JSON, tool-only and empty outputs never receive a footer.
Signature text is excluded from recorded model output and token-based billing.

Existing stored templates are preserved. An existing enabled setting with an empty
template now produces no footer. Resetting the template does not enable the switch.
OpenCode Go footer warnings are no longer appended when signatures are off or empty.

## Errors

Gateway errors follow the client protocol:

```json
{ "error": { "type": "invalid_request_error", "message": "..." } }
```

```json
{ "type": "error", "error": { "type": "invalid_request_error", "message": "..." } }
```

Gemini generateContent and Interactions errors use the Google envelope:

```json
{ "error": { "code": 400, "message": "...", "status": "INVALID_ARGUMENT" } }
```

Interactions non-stream errors use `{ "error": { "code": "invalid_request", "message": "..." } }`;
streaming errors arrive as `event: error` with `event_type: "error"`.

Management errors use `{ "error": "message", "code": "permission_denied", "permission": "keys.read" }`
and similar shapes. Every response includes `X-CrewRouter-Request-Id`.

## SDKs

| Language | Package | Documentation |
| --- | --- | --- |
| Node/TypeScript | `crewrouter-sdk` | [docs/sdk/README.md](./sdk/README.md) |
| Python | `crewrouter-sdk` | [docs/sdk/quickstart-python.md](./sdk/quickstart-python.md) |
| Go | `sdk/go` module | [docs/sdk/quickstart-go.md](./sdk/quickstart-go.md) |

## Existing OpenAI/Anthropic SDKs

You do not need the CrewRouter SDK to use the gateway. Point an existing client at
the instance:

```python
from openai import OpenAI
client = OpenAI(base_url="https://your-host/v1", api_key="sk-...")
```

```python
from anthropic import Anthropic
client = Anthropic(base_url="https://your-host", api_key="sk-...")
```

See [docs/integration-guide.md](./integration-guide.md).

## Blora Agent 管理与倍率草案

Manage 模式仅管理员可用。只读工具立即执行；写工具先创建 `agent_approvals` 草案，管理员允许后才在事务中落库。

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/agent/manage/threads` | 管理对话列表 |
| GET | `/api/agent/manage/threads/{id}` | 消息、附件元数据与待审批预览 |
| POST | `/api/agent/manage/runs` | 发起一轮管理对话（SSE）；可带 `attachment_ids` |
| POST | `/api/agent/manage/approvals/{id}` | 允许/拒绝待审批工具调用（SSE） |
| POST | `/api/agent/manage/attachments` | multipart 上传附件（最多 5 个，字段 `files`） |
| POST | `/api/agent/manage/attachments/url` | 抓取链接并保存为附件 |
| GET/DELETE | `/api/agent/manage/attachments/{id}` | 读取元数据 / 删除未绑定或当前对话的附件 |
| GET | `/api/agent/manage/attachments/{id}/content` | 读取图片附件（仅图片） |
| GET/PUT | `/api/admin/agent-web` | 联网搜索与链接抓取设置（密钥脱敏） |
| POST | `/api/admin/agent-web/test` | 用测试查询词验证搜索服务 |

附件支持图片（PNG/JPEG/WebP/GIF）、文本（txt/md/csv/json/yaml/log）、PDF、DOCX、XLSX；旧版 `.doc`/`.xls` 与扫描版 PDF 不支持。图片 ≤4 MiB，文档 ≤8 MiB，单次总计 ≤20 MiB，每对话最多 50 个。文档正文保存在 `agent_attachments.extracted_text`，通过 `read_attachment` 分页读取；图片按视觉内容发送，不写入消息文本。

### 倍率草案

`preview_multiplier_batch` 只读地解析模型引用并重算倍率，返回可直接交给 `batch_set_model_multipliers` 的 `write_args`。服务端按以下公式重算，模型提供的 `new_multiplier` 偏差超过 0.0001 会被拒绝：

```text
new_multiplier = 上游每百万 Token 价格 × 加价系数 × 汇率
```

- 1 积分 = 1,000,000 加权 Token；实例积分按人民币口径折算。
- 只修改 `models.model_multiplier`，不修改 `completion_multiplier` 或计费公式。
- 单次最多 100 项；同一草案中任一模型倍率在审批前发生变化（`stale_multiplier`），整批回滚并返回 409。
- 审批成功后写入 `admin.model_batch` 审计日志。

链接抓取只允许 http/https 的 80/443 端口，复用固定 DNS 与逐跳校验，拒绝私网、元数据和 HTTPS 降级；网页/搜索/文档内容统一标记为不可信资料。详见 [Blora Agent 资料驱动倍率调整](./blora-agent-pricing.md)。
