# CrewRouter Architecture

> Crant AI Studio — Multi-Model LLM API Gateway & Platform

## Overview

CrewRouter is an Express.js-based API gateway that provides a unified OpenAI-compatible API to access multiple upstream AI providers (OpenAI, Anthropic, DeepSeek, etc.). It includes user management, billing, rate limiting, team-based model access control, and a "Fusion" multi-model consensus system.

**Tech Stack:**
- **Runtime**: Node.js (>=16)
- **Framework**: Express.js 4
- **Database**: PostgreSQL (via `pg` driver)
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Port**: 20003 (configurable in `config.json`)

---

## Directory Structure

```
CrewRouter/
├── config.json                 # Central configuration (port, DB, OAuth, providers)
├── package.json                # Dependencies and scripts
├── server/                     # Backend
│   ├── index.js                # Entry point, migrations, middleware, route mounting
│   ├── models/
│   │   └── database.js         # PostgreSQL connection pool
│   ├── middleware/
│   │   └── auth.js             # requireAuth, requireAdmin middleware
│   ├── routes/                 # 13 route modules
│   │   ├── auth.js             # Login, logout, change password
│   │   ├── api.js              # Core proxy: /v1/chat/completions
│   │   ├── admin.js            # Admin CRUD for users, models, providers
│   │   ├── user.js             # User dashboard, API keys, balance
│   │   ├── teams.js            # Team management
│   │   ├── setup.js            # OOBE first-run wizard
│   │   ├── playground.js       # Interactive chat playground
│   │   ├── conversations.js    # Chat history CRUD
│   │   ├── feishu.js           # Feishu/Lark OAuth
│   │   ├── oauth.js            # GitHub OAuth
│   │   ├── two-factor.js       # TOTP 2FA
│   │   ├── passkey.js          # WebAuthn/FIDO2
│   │   └── balance-alert.js    # Balance alert settings
│   ├── providers/              # Provider adapter pattern
│   │   ├── base.js             # Abstract adapter
│   │   ├── openai.js           # OpenAI adapter
│   │   ├── anthropic.js        # Anthropic adapter
│   │   ├── index.js            # Adapter factory/registry
│   │   └── transforms/         # Format conversion (OpenAI ↔ Anthropic)
│   ├── fusion/                 # Multi-model consensus engine
│   │   ├── index.js            # Pipeline orchestrator
│   │   ├── panel-runner.js     # Parallel model execution
│   │   ├── judge-analyzer.js   # Output analysis
│   │   └── synthesizer.js      # Final response generation
│   ├── utils/
│   │   ├── billing.js          # Cost calculation with multipliers
│   │   ├── balance.js          # Transactional balance deduction
│   │   ├── token-normalize.js  # Normalize token formats (OpenAI/Anthropic/Gemini)
│   │   ├── api-signature.js    # Template-based response signature injection
│   │   ├── quota-data.js       # Buffered hourly usage aggregation
│   │   ├── sandbox.js          # Safe JS execution (vm module)
│   │   ├── url-validator.js    # SSRF protection
│   │   ├── error-mapper.js     # Error format conversion
│   │   ├── email.js            # SMTP email via Feishu
│   │   ├── balance-alert.js    # Alert notifications
│   │   └── PassKey.js          # WebAuthn implementation
│   ├── key-refresher.js        # Dynamic API key refresh via sandboxed scripts
│   ├── proxy-pool.js           # HTTP/SOCKS5 proxy pool with 429 cooldown
│   ├── provider-lookup.js      # Provider auto-discovery from models.dev
│   └── scripts/
│       └── init-db.js          # Database initialization
├── public/                     # Static frontend
│   ├── pages/                  # HTML pages (8 total)
│   ├── js/                     # Client-side JavaScript
│   └── css/                    # Stylesheets
├── docs/                       # Documentation
├── log/                        # Runtime logs
└── scripts/                    # Utility scripts
```

---

## Core Architecture

### Request Flow

```
Client Request
    │
    ▼
┌─────────────────┐
│  Express Server  │ (server/index.js)
│  Port 20003      │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌────────┐
│ Static │ │  API   │
│ Files  │ │ Routes │
└────────┘ └────┬───┘
                │
    ┌───────────┼───────────┐
    │           │           │
    ▼           ▼           ▼
┌───────┐  ┌───────┐  ┌───────────┐
│ Auth  │  │ Admin │  │  /v1/chat │
│Routes │  │Routes │  │/completions│
└───────┘  └───────┘  └─────┬─────┘
                             │
                    ┌────────┴────────┐
                    │   API Key       │
                    │   Validation    │
                    └────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │   Model         │
                    │   Resolution    │
                    └────────┬────────┘
                             │
                ┌────────────┼────────────┐
                │            │            │
                ▼            ▼            ▼
          ┌──────────┐ ┌──────────┐ ┌──────────┐
          │  OpenAI  │ │Anthropic │ │  Other   │
          │ Provider │ │ Provider │ │ Providers│
          └──────────┘ └──────────┘ └──────────┘
```

### Database Schema

Key tables (auto-migrated at startup via `server/index.js`):

| Table | Purpose |
|-------|---------|
| `users` | User accounts, balance, OAuth bindings, 2FA, passkeys |
| `models` | AI model registry with pricing and provider mapping |
| `providers` | Provider configurations (URL, keys, format, proxy) |
| `api_keys` | User API keys with per-key model binding (`current_model_id` = queue head) |
| `api_key_models` | Ordered model queue per key (`sort_order`); failover top-to-bottom on retryable upstream errors |
| `api_key_harness_models` | Optional single-model override per coding harness (`claude_code`, `codex`, …); missing row → default queue |
| `teams` / `user_teams` / `team_models` | Team-based model access control |
| `user_groups` / `user_group_rules` | Quota rules by user group |
| `usage_records` | Per-request usage tracking |
| `quota_data` | Hourly aggregated usage statistics |
| `conversations` / `conversation_messages` | Playground chat history |
| `fusion_configs` / `fusion_usage_records` | Multi-model consensus system |
| `redemption_codes` / `user_code_balances` | Billing/redemption codes |

---

## Authentication

Three authentication mechanisms:

1. **Session-based** (primary for web UI): Express-session stored in PostgreSQL via `connect-pg-simple`. 30-day cookie TTL.

2. **API Key** (for programmatic access): Validated in `api.js:validateApiKey()`. Supports:
   - `X-API-Key` header
   - `Authorization: Bearer` header
   - `?api_key=` query parameter
   - 60-second in-memory cache

3. **OAuth**: Feishu/Lark (`server/routes/feishu.js`) and GitHub (`server/routes/oauth.js`)

Additional security: TOTP 2FA (`speakeasy`), WebAuthn/PassKeys (`@simplewebauthn/server`), bcrypt password hashing.

---

## Provider Adapter System

Located in `server/providers/`:

```
BaseAdapter (abstract)
    ├── getApiFormat()     → 'openai' | 'anthropic'
    ├── transformRequest() → format-specific request
    ├── transformResponse()→ format-specific response
    ├── buildUrl()         → provider endpoint URL
    ├── buildHeaders()     → auth headers
    └── validateUrl()      → SSRF protection

OpenAIAdapter    → OpenAI Chat Completions format
AnthropicAdapter → Anthropic Messages format (with thinking support)

Transforms:
    openai-to-anthropic.js
    anthropic-to-openai.js
```

---

## Key Services

### Billing (`server/utils/billing.js`)
Cost calculation with multipliers:
```
cost = model_multiplier × (inputCost + outputCost × completion_multiplier)
```
Cache hit discount: 10% off cached tokens.

### Balance (`server/utils/billing.js`)
Transactional deduction with `FOR UPDATE` row locking:
- Priority: regular balance → refundable code balances (by fee_rate descending)
- Pre-consume/settle pattern for request-level billing

### Token Normalization (`server/utils/token-normalize.js`)
Normalizes usage from OpenAI, Anthropic, and Gemini formats into:
```javascript
{ promptTokens, completionTokens, cachedTokens }
```

### API Signature (`server/utils/api-signature.js`)
Template-based **response signature injection** (optional product feature).

**Dual-channel delivery (Phase 1):**

1. **HTTP headers** (non-stream, when headers not yet sent):  
   - `X-CrewRouter-Signature` — plain text if safe (no CR/LF, ≤2048 chars)  
   - otherwise `X-CrewRouter-Signature-B64` — base64(utf8)  
   - Exposed via `Access-Control-Expose-Headers` for browser clients  
2. **Body content** (default for chat UX): append to OpenAI `message.content`, Anthropic text blocks, or Responses `output_text` / stream deltas  

**Smart skip of content append** (signature still goes to headers when possible):

- tool-only responses (`tool_calls` / Anthropic `tool_use` with no text)
- `response_format` / `text.format` of `json_object` or `json_schema`
- Responses API with only `function_call` items
- Client request header `X-CrewRouter-Signature-Mode: header` forces header-only (no content rewrite); `content` / `both` (default) keep chat behavior

**Streaming note:** after SSE `flushHeaders`, late response headers cannot be set; stream path relies on smart skip of content only.

Supported placeholders include:
`{model}`, `{tokens}`, `{cache_hit}`, `{provider}`, `{cost}`, `{username}`, `{key_name}`, `{balance}`, `{quota_info}`, etc.

**Design note (intentional):** content rewrite remains the default for human-readable footers. Strict clients can disable signature on the key, use mode `header`, or read the custom headers and ignore body footers.

### Quota Data (`server/utils/quota-data.js`)
In-memory buffered aggregation, flushed to `quota_data` table every 60 seconds.

### Sandbox (`server/utils/sandbox.js`)
Safe JavaScript execution using Node.js `vm` module. Used for:
- Provider key refresh scripts
- Quota extractors

### Key Refresher (`server/key-refresher.js`)
Dynamic API key refresh for providers with `key_mode: 'script'`:
- Executes sandboxed scripts to fetch new keys
- Caches with TTL
- Auto-refreshes on expiry

### Proxy Pool (`server/proxy-pool.js`)
HTTP/SOCKS5 proxy pool per provider:
- Smart selection excludes recently 429'd proxies (60s cooldown)
- Automatic retry on rate limit

---

## Fusion System (Multi-Model Consensus)

Three-stage pipeline in `server/fusion/`:

```
┌─────────────┐
│   Panel     │  Run N models in parallel
│   Runner    │  on same prompt
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Judge     │  Analyze outputs for
│   Analyzer  │  consensus/contradictions
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Synthesizer │  Generate final response
│             │  based on judge analysis
└─────────────┘
```

- Supports both OpenAI and Anthropic streaming formats
- Configurable per API key or via named presets (`fusion_configs` table)

---

## Frontend Architecture

Pure vanilla HTML/CSS/JavaScript (no framework):

| Page | Purpose |
|------|---------|
| `/` | Login (username/password + OAuth) |
| `/console` | User dashboard: models, API keys, usage, balance |
| `/admin` | Admin panel: user/model/provider/team management |
| `/playground` | Interactive AI chat playground |
| `/setup` | OOBE first-run wizard |
| `/purchase` | Store/products page |
| `/feishu-bind` | Feishu account binding |

---

## API Endpoints

### Core Proxy
- `POST /v1/chat/completions` — OpenAI-compatible chat completions
- `POST /v1/messages` — Anthropic-compatible Messages API
- `POST /v1/responses` — OpenAI Responses API (with conversion when upstream is chat/messages)
- `GET /v1/models` — Virtual model list for the current API key (see “Intentional Deviations”)
- `POST /api/chat/completions` (and `/api/messages`, `/api/responses`) — Same handlers under `/api`

### Auth
- `POST /auth/login` — Username/password login
- `POST /auth/login/2fa` — TOTP 2FA verification
- `GET /auth/logout` — Session destroy
- `GET /auth/me` — Current user info

### User
- `GET/POST/PUT/DELETE /api/user/keys` — API key CRUD
- `GET /api/user/models` — Available models
- `GET /api/user/usage` — Usage statistics
- `GET /api/user/balance` — Balance info

### Admin
- `GET/PUT /api/admin/users` — User management
- `GET/POST/PUT/DELETE /api/admin/models` — Model CRUD
- `GET/POST/PUT/DELETE /api/admin/providers` — Provider CRUD
- `GET /api/admin/stats` — System statistics

### Playground
- `POST /api/playground/chat` — Direct model testing
- `GET/POST/DELETE /api/conversations` — Chat history

---

## External Integrations

| Service | Purpose |
|---------|---------|
| Feishu/Lark | OAuth login, enterprise tenant isolation |
| GitHub | OAuth login, account binding |
| models.dev | Provider auto-discovery index |
| img.bloret.net | Image hosting for avatars |
| SMTP (Feishu) | Email notifications |

---

## Key Architectural Patterns

1. **Auto-migration at startup**: ~30 migration functions create/alter tables on boot — no separate migration tooling needed.

2. **Unified OpenAI-compatible API**: Upstream providers are proxied through `/v1/chat/completions`, `/v1/messages`, and `/v1/responses` with format conversion where needed.

3. **Per-key model routing** (intentional product design): Each API key has a `current_model_id` (plus optional ordered queue in `api_key_models`). The gateway **ignores** the request body's `model` field and routes to the model bound on that key (except special names like `fusion`). Clients still may send `model` for SDK compatibility; it does not select the upstream model.

   **Per-harness override** (optional): Table `api_key_harness_models` stores a single model per coding harness (`claude_code`, `codex`, `grok`, `opencode`, `qwen_code`, `hermes`, `openclaw`, `deepseek_harness`). On each request the gateway first detects the client via `request-source.js` (headers / prompt fingerprint / UA). If the source is a known harness and that key has an override row, routing uses **only** that model; otherwise it falls back to the key’s default queue. `unknown` always uses the default binding.

4. **Team-based model access**: Users belong to Teams; Teams have model lists; users can only access their Teams' models.

5. **Dual balance system**: Regular balance + refundable code balances with priority-based deduction.

6. **Buffered usage recording**: In-memory aggregation flushed every 60 seconds for performance.

7. **SSE streaming with backpressure**: Full backpressure handling with drain events, client disconnect detection, and proxy retry on 429.

8. **Dynamic key refresh**: Providers can use sandboxed JavaScript scripts to refresh API keys periodically.

---

## Intentional Deviations from Upstream “Standard” APIs

These behaviors look non-standard vs pure OpenAI/Anthropic docs but are **deliberate product design**, not bugs. Do not “fix” them without a product decision.

| Behavior | What clients see | Why |
|----------|------------------|-----|
| **Body `model` ignored** | Routing uses API key’s `current_model_id` / queue, or per-harness override when the client is recognized | Per-key lock-in; avoids users bypassing billing/ACL by inventing model IDs in the request |
| **`GET /v1/models` virtual list** | Returns the key’s display/custom model name + optional `fusion`, not full admin catalog | Public surface stays simple; real catalog is in console (`/api/user/models` / admin) |
| **Optional response signature** | Dual-channel: response headers + optional content append; smart-skip for tools/JSON | Branding / usage footer without breaking structured/tool outputs; see API Signature section |

Error shapes and cross-format conversion (tools, images, streaming `finish_reason`, etc.) should still track OpenAI/Anthropic conventions where possible; the rows above are the exceptions.
