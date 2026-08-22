# 七种 Harness 传输层请求特征、触发时机与工作模式深度研究报告

> 研究日期：2026-08-23
> 数据来源：(1) 本仓库内各 harness 完整源码的只读考古（每条结论附文件路径证据）；(2) CrewRouter 生产库 `usage_records` 表的真实流量观测。
> 前置研究：《harness-message-construction-comparison.md》（消息/Prompt 构成）、《harness-tool-call-formats.html》（工具调用格式）。本研究补齐 **HTTP 传输层**维度。

---

## 0. 关键发现摘要

1. **主对话循环全部强制流式（SSE）**：Claude Code / Codex / Grok Build / OpenCode / OpenClaw 硬编码 `stream: true`，无主循环非流式分支；Qwen Code 是唯一会显式发送 `stream: false` 的（其注释称"某些网关缺省字段时默认 SSE"）；Hermes 默认流式但保留运行时降级开关。
2. **Codex 已彻底移除 Chat Completions**：`wire_api` 枚举只剩 `responses`，配置 `wire_api = "chat"` 直接反序列化报错。网关侧不能再假设 Codex 走 `/v1/chat/completions`。
3. **自动压缩阈值趋同于 85%~90%**：Grok 默认 85%（grok-4.x 内置 80%）、Qwen 85%、Codex 默认窗口 90%、Claude Code 为「有效窗口 − 13K 缓冲」（另预留 20K 摘要输出）、OpenCode 预留 20K 缓冲、OpenClaw 预留 16384 tokens。Qwen 源码注释自证其 `AUTOCOMPACT_BUFFER = 13_000` 是「对齐 claude-code autoCompact.ts」——**harness 间互相抄参数**。
4. **后台自动 LLM 请求是重要流量来源**：标题生成（Grok 在第 3/6 回合检查点刷新后冻结；OpenCode 仅首条用户消息一次）、上下文压缩、记忆审查（Hermes/Qwen 回合后触发）、心跳与 cron（OpenClaw 默认 30 分钟心跳；Hermes gateway 每 60 秒 tick）。本站观测到 Hermes 在凌晨时段仍有稳定请求流即来源于此。
5. **身份伪装是普遍现象，UA 不可信**：Qwen Code 在代理端点伪装成 `claude-cli/<ver> (external, cli)`；Hermes 在 chatgpt.com 后端伪装 `codex_cli_rs/0.0.0 (Hermes Agent)`、在 portal.qwen.ai 伪装 `QwenCode/0.14.1`；Grok 的 web_fetch 工具用 Mozilla 风格 UA。这印证了 CrewRouter `request-source.js` 以「提示词指纹优先于 UA」的设计正确性。
6. **重试预算差异巨大**：Grok 最激进（默认 15 次、总预算约 5.5 分钟、429 足额遵守 Retry-After 至 120s）；Codex HTTP 层默认不对 429 重试（交给流式层）；Claude Code 主链路 10 次；OpenCode 会话层 5 次；Hermes/Qwen/OpenClaw 各有分层预算。网关的 429 响应头直接影响客户端行为。
7. **子代理并发上限**：Grok 单会话 32 个（可调不可禁）、OpenClaw 子代理默认 8 并发 × 深度 1、Hermes 迭代预算父 500/子代理各 50、Codex 用读写锁「并行闸门」、Qwen 仅白名单工具类型可并行。
8. **可利用的强识别头**：Codex 的 `session-id`/`thread-id`/`x-openai-subagent`（能直接区分 review/compact/memory 子请求！）、OpenClaw 的 `originator: openclaw`、OpenCode 自营通道的 `x-opencode-session/request/client`、Grok 的 `x-grok-session-id` 与 `x-compaction-at`（后者可用于统计压缩事件）。

---

## 1. 研究方法

- **源码考古**：对工作区内 7 个 harness 源码库做只读检索，覆盖 Rust（codex-rs、grok-build/crates）与 TypeScript（claude-code-source-code、opencode、qwen-code、openclaw）与 Python（hermes-agent），共 7 个并行探索任务，每条结论附文件路径证据，不确定处标注「未确认」。
- **真实流量观测**：查询生产 PostgreSQL `usage_records` 表（快照时间 2026-08-23），维度包括 request_source 分布、UA 变体、request_type、小时级节奏、请求间隔分布、模型偏好。
- DeepSeek Harness 本地无源码，仅有流量观测小节。

## 2. 横向总对比

### 2.1 身份与传输层

| 维度 | Claude Code | Codex | Grok Build | OpenCode | Qwen Code | Hermes | OpenClaw |
|---|---|---|---|---|---|---|---|
| User-Agent | `claude-code/<ver>` | `codex_cli_rs/<ver> (<os> <osver>; <arch>) [终端信息]`，originator 可被 env 覆盖 | `grok-shell/<ver> (<os>; <arch>)`，第三方 origin 前缀 `<origin>/<ver> grok-shell/...` | `opencode/<ver>`（自营通道外还有 gitlab/copilot 变体） | `QwenCode/<ver> (<platform>; <arch>)`；代理端点伪装 `claude-cli/<ver> (external, cli)` | 直连默认 SDK UA；RouterMint/Kimi `HermesAgent/<ver>`、x.ai `Hermes-Agent/<ver>`、chatgpt.com 伪装 `codex_cli_rs/0.0.0 (Hermes Agent)` | `openclaw/<ver>` |
| 关键自定义头 | `x-app: cli`、`X-Claude-Code-Session-Id`、`anthropic-version: 2023-06-01`、十余个 beta 标志 | `originator`、`session-id`/`thread-id`、`x-client-request-id`、`x-openai-subagent`、`chatgpt-account-id`、`x-codex-*` 系列 | `x-grok-client-identifier/version/deployment-id/user-id`、每请求 `x-grok-conv-id/req-id/model-override/session-id/agent-id(/turn-idx)`、`x-compaction-at` | 自营：`x-opencode-project/session/request/client`；第三方：`x-session-affinity`、`X-Session-Id` | DashScope 四件套 `User-Agent/X-DashScope-CacheControl/X-DashScope-UserAgent/X-DashScope-AuthType`；动态 `anthropic-beta` 按体计算 | 按 base_url 分发：OpenRouter 三件套、Copilot 五件套、Qwen Portal 三件套等 | `originator: openclaw`、`version`；Gemini `x-goog-api-client`；NVIDIA `X-BILLING-INVOKE-ORIGIN` |
| 协议/端点 | Anthropic Messages（SDK 内部拼 beta 参数） | **仅 Responses API** `{base}/responses`；ChatGPT 后端 `chatgpt.com/backend-api/codex` | Chat Completions / Responses / Anthropic Messages 三选一；第一方默认 `cli-chat-proxy.grok.com/v1` | AI SDK 多协议 + 自研原生栈（anthropic-messages / openai-responses / openai-chat / gemini） | DashScope OpenAI 兼容 `/compatible-mode/v1/chat/completions`、Anthropic `/v1/messages`、Gemini | 五种 api_mode：chat_completions（默认）/anthropic_messages/bedrock_converse/codex_responses/codex_app_server | 九种 KnownApi 家族（openai-completions/responses/chatgpt-responses/anthropic-messages/bedrock/gemini 等） |
| 主循环 stream | 恒 true（绕开 BetaMessageStream 防 O(n²) 解析） | 恒 true + `store:false` + `include: reasoning.encrypted_content` | 恒 true（三后端皆流式方法，无非流式分支） | 恒 true（AI SDK 仅 streamText；原生栈硬编码） | 显式 true/false 都发（防网关缺省歧义）；压缩 sideQuery 强制 true | 默认 true，可因 provider 报错/acp/moa 降级 | 流式唯一（API 注册表只提供 stream 适配器） |
| 特殊传输 | — | Responses-over-WebSocket（426 或重试耗尽回退 HTTP）；Zstd 请求体压缩 | — | OpenAI Responses WS 变体（Codex 插件用） | — | gateway 自暴露 OpenAI 兼容入口；wake 自唤醒 POST | SSE/WebSocket/WebSocket-cached 可选 |

### 2.2 自动压缩（auto-compact）阈值对比

| Harness | 阈值逻辑 | 默认值 | 失败熔断 | 证据 |
|---|---|---|---|---|
| Claude Code | 有效窗口 − `AUTOCOMPACT_BUFFER_TOKENS`；先减摘要预留 20000 | 缓冲 13000；警告/错误缓冲各 20000 | 连续失败 3 次 | src/services/compact/autoCompact.ts:29-90 |
| Codex | `model_auto_compact_token_limit` 配置；未配置取窗口 90% | `context_window*9/10` | —（远程 compact V2 有重试上限） | protocol/src/openai_models.rs:486-497、session/context_window.rs:60-79 |
| Grok Build | 上下文窗百分比，解析链 env > 用户 per-model > 用户 session > 远程 > 默认 | 85%（grok-4.x 内置 80%）；墙钟预算 300s | 抑制状态机（turn/sticky/credit/auth 四级） | util/config/resolve/compaction.rs:40-130、default_models.json:20,59 |
| OpenCode | `limit.input − reserved` 或 `context − maxOutputTokens` | `COMPACTION_BUFFER=20000` | auto:false 可整体关闭 | session/overflow.ts:8-34 |
| Qwen Code | `min(pct×window, window−SUMMARY_RESERVE−AUTOCOMPACT_BUFFER)` | pct 85%、buffer 13000、WARN_BUFFER 20000、HARD_BUFFER 3000 | 连续失败 3 次后 NOOP | services/chatCompressionService.ts:103-142 |
| Hermes | turn 序言 preflight + 每次 API 调用前压力复查 | 辅助便宜模型总结中间轮 | — | conversation_loop.py:2548-2610 |
| OpenClaw | `contextTokens > contextWindow − reserveTokens`；溢出重试上限 3 | reserve 16384、keepRecent 20000 | MAX_OVERFLOW_COMPACTION_ATTEMPTS=3 | agent-session-compaction.ts:330-380、agent-compaction-constants.ts:16 |

### 2.3 重试策略对比

| Harness | 层级与预算 | 可重试条件 | 退避 | 证据 |
|---|---|---|---|---|
| Claude Code | 主链路 10 次；529 仅 3 次且只对前台来源；sideQuery 2 次 | 429/5xx/网络；持久 429 等限流重置时间戳 | 基准 500ms 指数 ×2，取 retry-after 较大者 | services/api/withRetry.ts:52-62、utils/sideQuery.ts:116 |
| Codex | 流断线 5 次、HTTP 请求 4 次（provider 级，上限 100）；HTTP 层默认**不重试 429** | 5xx、传输错误、401 先刷新凭据再重试；用量超限不重试 | 基准 200ms ×2 ±10% 抖动；流层优先 retry-after | model-provider-info/src/lib.rs:28-36、codex-client/src/retry.rs:9-48 |
| Grok Build | 默认 15 次（总预算约 5.5 分钟）；**429 独立通道最多等 2 次但足额遵守 Retry-After（封顶 120s）** | 429、除 CF 525/526 外全部 5xx、连接错误、流中断、空回复；400/401/403/404/408/422 立即 Fatal；`x-should-retry:false` 有否决权 | 2s 起 ×2 封顶 30s ±20% 抖动；首次传输错误重建无池 HTTP/1.1 客户端 | xai-grok-sampler/src/retry.rs:17-38,48-66,232-267 |
| OpenCode | 三层：AI SDK 主对话 0 次/title 2 次；会话层 5 次（主力）；原生 executor 2 次 | 429/500/502/503/504/524 + 文案正则；上下文溢出不重试 | 初始 2s ×2 抖动 0.25，无 retry-after 时上限 30s；优先尊重响应头 | session/retry.ts:26-96、llm/route/executor.ts:35-39 |
| Qwen Code | 七类独立预算：SDK 3 次/限流 10 次(60s 起)/无效流 transient 4 次+协议泄漏 2 次/续传 3 次/截断恢复 3 次/watchdog idle 240s 总寿命 900s | 限流 throttle、容量类 {429,503,529} 触发模型 fallback 链（≤3 次，各获全新预算） | 限流对齐 DashScope 每分钟窗，上限 5 分钟 | geminiChat.ts:3727-3830,1044-1051、retryErrorClassification.ts:295-304 |
| Hermes | 主循环内置重试/fallback 于约 3900 行驱动器；cron tick 失败按 60s×2ⁿ 退避封顶 15 分钟 | provider 报"stream 不支持"则整会话降级非流式 | — | conversation_loop.py:3035-3090、cron/scheduler_provider.py:27-46 |
| OpenClaw | 会话层默认 3 次；SDK 层重试被置 0 由 OpenClaw 统一控制；provider 可配 timeoutMs/maxRetries（上限 60s） | Retry-After 支持 IMF-fixdate/RFC850/asctime 三种格式 | 2000ms 基准指数 2s/4s/8s | settings-manager.ts:448-481、packages/ai/src/internal/retry-after.ts:33 |

### 2.4 并发 / 子代理限制对比

| Harness | 机制与上限 | 证据 |
|---|---|---|
| Claude Code | 子代理经 Task 工具派发（本研究未深挖并发上限） | — |
| Codex | `parallel_tool_calls=true`（正常回合恒置）；执行侧读写锁「并行闸门」：可并行工具拿读锁共存、不可并行拿写锁独占；MCP server 可声明支持并行 | core/tools/parallel.rs:43-67,149-157 |
| Grok Build | 单会话默认 **32 个** subagent，env 可调但 0 会被钳到 1（"可调不可禁用"）；超限默认排队，可配 fail | xai-grok-tools/.../task/admission.rs:6-63 |
| OpenCode | 提示词鼓励单消息多 tool use 并行派发；请求体带 `parallel_tool_calls:true`；未见显式并发数限制代码 | tool/task.txt:11、test fixture:27 |
| Qwen Code | 并发白名单 `{Read, Search, Fetch}` + 只读 shell 正则判定（fail-closed）；连续安全项合并为并行批保持顺序 | tools/tools.ts:1028-1037、coreToolScheduler.ts:1255-1322 |
| Hermes | 迭代预算 parent 500 次、每个 subagent 50 次 | agent/iteration_budget.py:1-29 |
| OpenClaw | agent 级 `min(16,max(8,CPU))`；子代理 maxConcurrent=8、maxChildrenPerAgent=5、maxSpawnDepth=1；命令泳道默认每 lane 并发 1 | config/agent-limits.ts:9-39、process/command-queue.ts:110-125 |

### 2.5 后台自动 LLM 请求矩阵（✓=存在）

| 自动请求类型 | CC | Codex | Grok | OC | Qwen | Hermes | OpenClaw |
|---|---|---|---|---|---|---|---|
| 会话标题生成 | 未确认（客户端侧未发现） | ✗（客户端无，服务端存疑） | ✓ 首块内容即生成；第 3/6 回合刷新后冻结 | ✓ 首条用户消息一次（small 模型） | ✓ ≥2 条历史后（fast 模型，不重试） | ✓ 两阶段：本地派生+小模型升级（cron/subagent 平台豁免） | — |
| 自动压缩 | ✓ 查询循环 micro→auto | ✓ 四触发点（回合前/中/换模哈希变/降档）+远程 `/responses/compact` | ✓ 四处（采样前预检/工具溢出预检/换小窗口/错误驱动）+两遍压缩后台 pass-1 | ✓ 每轮 isOverflow 检查+独立压缩 agent | ✓ sendMessageStream 内门控 sideQuery | ✓ preflight+API 前 pressure check | ✓ 每轮响应后阈值检查+溢出 compact-and-retry |
| 记忆/技能审查 | — | ✓ memory_consolidation → `/memories/trace_summarize`（unary） | — | — | ✓ autoSkill 按工具调用计数、记忆 extract/dream 每用户回合一次 | ✓ 每回合后 spawn_background_review（独立会话） | — |
| 心跳/cron 定时 | — | ✗ | — | — | — | ✓ gateway 每 60s tick 到期 job 走 run_conversation | ✓ 默认 30m 心跳（HEARTBEAT_OK 空转不投递）+ cron 泳道隔离 turn |
| 启动预热 | — | ✓ WS 连接预建 `generate=false`（非推理请求） | — | — | — | — | — |
| 后台任务完成唤醒 | — | — | ✓ admission 门控的完成唤醒 | ✓ 注入 synthetic 用户消息 fork 新一轮 | — | ✓ completion_queue 排水自动触发新 turn | — |
| 配额/订阅查询 | — | — | ✓ billing ext 按需 + pager 订阅轮询 | — | — | — | ✓ 用量拉取 UA 变体 |

---

## 3. 各 Harness 详细报告

### 3.1 Claude Code

**传输特征**
- UA：`claude-code/${MACRO.VERSION}`（src/utils/userAgent.ts:9），BigQuery 导出与预检复用。
- 头：`x-app: 'cli'`、`X-Claude-Code-Session-Id`、`x-claude-remote-container-id/-session-id`、可选 `x-client-app`、`x-anthropic-additional-protection`（src/services/api/client.ts:106–118）；`anthropic-version: '2023-06-01'`。
- **beta 标志全集**（src/constants/betas.ts:3–32）：核心 `claude-code-20250219`、`interleaved-thinking-2025-05-14`、`context-1m-2025-08-07`、`context-management-2025-06-27`、`structured-outputs-2025-12-15`、`web-search-2025-03-05`、工具搜索按供应商区分（`advanced-tool-use-2025-11-20` / `tool-search-tool-2025-10-19`）、`effort-2025-11-24`、`task-budgets-2026-03-13`、`prompt-caching-scope-2026-01-05`、`fast-mode-2026-02-01`、`redact-thinking-2026-02-12`、`token-efficient-tools-2026-03-28`；条件启用 `summarize-connector-text-2026-03-13`、`afk-mode-2026-01-31`、`advisor-tool-2026-03-01`；内部员工专用 `cli-internal-2026-02-09`；teleport 另用 `ccr-byoc-2025-07-29`。Bedrock/Vertex 有白名单子集（betas.ts:38–50）。
- 主对话固定流式：`client.beta.messages.create({ ...params, stream: true })`，刻意绕开 BetaMessageStream 避免 O(n²) JSON 解析（src/services/api/claude.ts:1820–1824）。端点 `?beta=true` 参数由 @anthropic-ai/sdk 内部拼接，src 内未命中。

**请求时机与工作模式**
- autoCompact：有效窗口先减摘要预留 20000 tokens，再减缓冲 13000 触发；警告/错误缓冲各 20000；连续失败熔断 3 次；可用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 覆盖（autoCompact.ts:29–90）；查询循环中先 microcompact 再 autocompact（src/query.ts:396–414）。
- 重试：主链路 10 次、基准 500ms 指数退避取 retry-after 较大者；529 仅前台重试 3 次，后台任务立即放弃（withRetry.ts:52–62）。

### 3.2 Codex

**传输特征**
- UA：`{originator}/{CARGO_PKG_VERSION} ({os} {osver}; {arch}) {终端信息}`，默认 originator `codex_cli_rs`，可被 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 覆盖；MCP 客户端可加后缀（如 VS Code 注入 `codex_vscode/…`）（login/src/auth/default_client.rs:40-41,164-187）。
- 头全集：进程级 `originator`、可选 `x-openai-internal-codex-residency: us`；业务头 `session-id`/`thread-id`、`x-client-request-id`、**`x-openai-subagent`（review/compact/memory_consolidation/collab_spawn——网关可直接区分子请求类型）**、兼容投影头 `x-codex-installation-id/window-id/turn-metadata/parent-thread-id`、粘性路由 `x-codex-turn-state`、`x-codex-beta-features`、WS 握手 `OpenAI-Beta: responses_websockets=2026-02-06`、路由提示 `x-codex-routing-hint: model=...;tier=...`、`x-responsesapi-include-timing-metrics`、记忆会话专用 `x-openai-memgen-request: true`、attestation 头（core/src/client.rs:143-166,615-650,1010-1035,1976-1994；codex-api/src/requests/headers.rs:5-31）。认证三件套 authorization + originator + `chatgpt-account-id`。
- 端点：仅 Responses API。ChatGPT 登录态 base `https://chatgpt.com/backend-api/codex`，API Key 模式 `https://api.openai.com/v1`；主采样 `POST {base}/responses`（SSE）、远程压缩 `{base}/responses/compact`（unary）、记忆总结 `{base}/memories/trace_summarize`（unary）（model-provider-info/src/lib.rs:40,57-91,296-310；core/src/client.rs:161-166）。`wire_api = "chat"` 已被移除，配置即报错。
- 请求体恒 `stream:true, store:false` + `include:["reasoning.encrypted_content"]` + `tool_choice:"auto"`；ChatGPT 后端启用 Zstd 请求体压缩（core/src/client.rs:946-961,1432-1440）。
- 参数默认：reasoning effort 默认 Medium（Ultra 映射为 Max）；verbosity 仅模型支持时发送，默认 Medium；`prompt_cache_key` 会话级生成。

**请求时机与工作模式**
- 主循环：RegularTask::run → run_turn 循环「采样→工具→needs_follow_up」直到无 pending 输入。
- 自动压缩四触发点：回合前 token 达限 / 回合中采样后达限 / 换模型且 compaction 哈希变化 / 降档到更小窗口模型；另有用户 `/compact` 与远程 compact V2（session/turn.rs:420-498,1014-1169）。
- resume 差分重建：environment_context 以基线快照做 diff，**未变化的段不重复注入**，变化才重建（context_manager/history.rs:129-150、context/world_state/mod.rs:386-433）。
- 启动预热：后台预建 WS 连接发 `generate=false` 的 response.create，非推理请求（session_startup_prewarm.rs:25-100）。
- 并行工具：流式输出项完成即封装 future 不阻塞后续事件；读写锁并行闸门控制执行并发（stream_events_utils.rs:289-327）。
- token 预算：每次响应累计 usage，采样后算 ContextWindowTokenStatus（含 BodyAfterPrefix 口径，扣除压缩前缀基线）；预算低于阈值注入提醒片段，归零且有兜底 prompt 时注入兜底压缩提示（session/context_window.rs:9-90、token_budget.rs:69-121）。

### 3.3 Grok Build

**传输特征**
- UA：`grok-shell/<version> (<os>; <arch>)`；第三方 origin 前缀 `<origin>/<ver> grok-shell/<ver> (...)`（如本站观测到的 `grok-pager/1.0.5 grok-shell/1.0.5 (linux; x86_64)`）；OS 映射 macos/windows、arm64→aarch64（xai-grok-sampler/src/client.rs:42-43,470-534）。web_fetch 工具对外用 Mozilla 风格 UA `Mozilla/5.0 (compatible; grok-agent/1.0; +https://x.ai)`（tools/.../web_fetch/config.rs:12）。
- 客户端级头：Content-Type、Bearer/x-api-key 二选一、`x-grok-client-version`、可选 `x-grok-deployment-id/user-id`、`x-grok-client-identifier`（回退 "grok-shell"）、UA（client.rs:567-676）。
- **每请求头**：总发 `x-grok-conv-id/req-id/model-override/session-id/agent-id`，有值才发 `x-grok-turn-idx/deployment-id/user-id`（client.rs:49-79）。
- 条件头：`x-grok-doom-loop-check`（死循环检测 opt-in）、**`x-compaction-at`（= context_window × 阈值%，可用于网关侧统计压缩事件）**与 `x-compactions-remaining`（sampling-types/src/types.rs:715-757）。
- 响应侧读取：`Retry-After`（解析上限 120s）、`x-should-retry`、`x-grok-context-window`、`x-grok-max-completion-tokens`、`x-models-etag`（client.rs:228-278）。
- 三后端协议皆强制流式；Chat Completions 包装强制 `"stream":true` + `stream_options.include_usage:true` + `Accept: text/event-stream`（client.rs:285-298,1028-1054）。
- 采样参数 temperature/top_p/max_tokens 默认不发送（None 跳过序列化）；唯一硬编码：Anthropic 后端 max_tokens 缺省 128000；Responses 后端恒 `store=false` + 追加加密推理内容（config.rs:140-160、client.rs:46,1207-1221,1576）。
- 第一方推理默认走 `https://cli-chat-proxy.grok.com/v1`；`xai_api_base_url` 绝不回退给 OAuth 推理（shell/src/agent/config.rs:50,299-311,541-545）。

**请求时机与工作模式**
- 主循环 agentic loop 每轮：安全点操作（排空 interjection/技能提醒/monitor 事件、token 刷新、auto-compact 预检）→ build_request → 采样 → tool_calls 则执行后 continue；无工具调用则回合结束（turn.rs:2139-2358,2590）。
- 死循环保护：同一工具相同参数连续 8 次 nudge、12 次强制终止；另有 max_turns 上限（turn.rs:2143-2226,2896-2960）。
- 标题：首块内容即生成（输入截 8000 字节、标题上限 80 字节）；真实用户回合到达第 3、6 回合两个检查点各刷新一次后冻结；单次 45s 超时；`/rename` 冻结、`--auto` 重开（session/summary.rs:55-90、title_refresh.rs:15-70）。
- 压缩四处触发 + 两遍压缩的 pass-1 在主循环安全点异步跑（单飞行槽防并发），墙钟预算 300s（compaction.rs:1845-1937、compaction_config.rs:110-150）。
- Goal 子代理：planner 在 `/goal` 创建/resume 时各一次（fail-CLOSED 会暂停 goal）；summarizer 在 classifier 判定 Achieved 后立即运行（fail-OPEN）；strategist 在 NotAchieved 且失败 streak 达 N 整数倍时触发（fail-OPEN），N=max(1, classifier_cap/2)（goal_planner.rs:456-524、goal_support.rs:1433-1650、config.rs:2856-2884）。
- 配额：billing ext 按需拉取 credits；pager 驱动订阅轮询；未见周期性额度轮询证据。
- 超时：per-chunk 空闲超时 300s（采样器）/ shell 层默认 600s（下限 clamp 10s）；TCP 连接 10s；HTTP/2 keepalive ping 15s/5s，idle 连接池 90s 驱逐每 host 最多 2 条（request_task.rs:37-41、mvp_agent/mod.rs:1351-1363、shared_http.rs:70-96）。
- 重试：见 §2.3；首次传输类重试会重建无池 HTTP/1.1 客户端逃离被毒化的 H2 连接池；413/图像错误剥离内联图片重试一轮。
- resume：从磁盘加载 summary+完整 chat_history+plan+rewind points 等；不向客户端重放 transcript（noReplay）；系统提示词保留原始版本不重建（session_setup.rs:795-808,1120-1180、mvp_agent/mod.rs:1187,1220）。

### 3.4 OpenCode

**传输特征**
- UA：`opencode/${InstallationVersion}`（session/llm/request.ts:19,188-201）；GitLab/Copilot/Codex 插件等有扩展变体。
- 头：自营 Zen 通道发 `x-opencode-project/session/request/client`；第三方 provider 发 `x-session-affinity` + `X-Session-Id`（会话亲和），有父会话加 `x-parent-session-id`；叠加 models.dev 的 model.headers 与 chat.headers 插件钩子（request.ts:131-203）。注意 `x-opencode-directory/workspace` 是本地 server API 头，不发往 LLM。
- 认证与协议头：Anthropic 路由 `x-api-key` + 固定 `anthropic-version: 2023-06-01`，默认追加 beta `interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14`（llm/src/providers/anthropic.ts:17、provider.ts:176-184）；OpenAI Bearer；OpenRouter 类附 `HTTP-Referer: https://opencode.ai/`、`X-Title: opencode`。
- 双运行时：默认 Vercel AI SDK streamText；`experimentalNativeLlm` 开关走自研 @opencode-ai/llm 原生栈（anthropic-messages / openai-responses / openai-chat / gemini 四协议，端点各自硬编码），不支持时回退 ai-sdk（session/llm.ts:227-325、native-request.ts:152-179）。
- 全流式：AI SDK 只有 streamText 无 generateText；原生栈协议层硬编码 `stream:true`；另有 Responses-over-WebSocket 变体（Codex 插件经 WS 使用）。
- 参数：temperature/topP 默认 undefined 不发送（仅 glm/kimi/minimax 等给推荐值）；`maxOutputTokens = min(model.limit.output, 32000)`；title agent 固定 temperature 0.5。实测 fixture 显示 zen/gpt-5.2-codex 发送 `max_output_tokens:32000, store:false, temperature:1.0, parallel_tool_calls:true`。

**请求时机与工作模式**
- 主循环 SessionPrompt.runLoop while(true)：取消息→找最新用户消息→上条 assistant 已 finish 且无工具调用则退出→否则 process() 内 llm.stream() 发请求→工具调用同 step 执行回填→循环；结束后 compaction.prune（prompt.ts:1080-1336）。
- 标题生成：主循环第 1 步 fork 后台，仅根会话+默认标题+首条真实用户消息时一次；small 模型选择链 cfg.small_model → 插件钩子 → gemini-flash/gpt-nano/claude-haiku 家族优先级；retries:2 无工具。
- auto-compact：每轮检查 isOverflow（token ≥ 可用上限即触发，COMPACTION_BUFFER=20000，auto:false 可关）；压缩用隐藏 compaction agent 发独立 LLM 请求生成结构化摘要（overflow.ts:8-34、compaction.ts:358-440）。
- 注意：summary.summarize **不是 LLM 请求**，只是 git 快照 diff 统计写盘。
- 项目复制命名：HTTP handler 用 small 模型生成 2–3 词名称。
- 后台任务完成回调：注入 synthetic 用户消息立即 fork 新一轮 prompt → 父会话新请求（tool/task.ts:228-264）。
- share 会向 opncd.ai 发非 LLM HTTPS 同步（事件驱动 1 秒批量 flush；share:"auto" 建会话即自动分享）；export 纯本地无网络。
- 重试三层见 §2.3；未发现运行时跨模型 fallback（仅 native→ai-sdk 运行时回退与小模型兜底链）——标注部分未确认。
- Permission 挂起语义：权限询问 Deferred 挂起当前 fiber，待决期间不发出下一次 LLM 请求（流暂停不取消）；拒绝则本轮结束返回 stop；同一工具连续重复 3 次（DOOM_LOOP_THRESHOLD）强制发起 doom_loop 权限询问。

### 3.5 Qwen Code

**传输特征**
- UA：OpenAI 兼容默认 `QwenCode/<ver> (<platform>; <arch>)`；DashScope 另发 `X-DashScope-UserAgent` 副本（值相同）；Gemini/Anthropic/WebFetch 同格式。
- DashScope 四件套头 + 请求体 metadata `{sessionId, promptId, channel?}`（dashscope.ts:272-279,638-648）。
- Anthropic 动态 beta 头按体计算去重合并：thinking→`interleaved-thinking-2025-05-14`；output_config→`effort-2025-11-24`；global cache scope→`prompt-caching-scope-2026-01-05`；ttl 1h→`extended-cache-ttl-2025-04-11`（anthropicContentGenerator.ts:518-582）。构造期排除用户自定义 anthropic-beta 防双份。
- **伪装机制**：`isAnthropicNativeBaseUrl` 仅 api.anthropic.com 及子域为原生；其余代理端点 `useProxyIdentity=true` → UA 改 `claude-cli/<ver> (external, cli)` + `x-app: cli` + Bearer 认证（满足代理 Team 按客户端限量的规则）；直连官方时刻意用真实 QwenCode UA 防止配额误记（anthropicContentGenerator.ts:236-253,306-346,494-508）。
- 端点：DashScope 兼容模式默认 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`；Anthropic SDK `/v1/messages`。
- stream：显式 true/false 都发送（防网关缺省歧义）；压缩 sideQuery 强制 true（非流式长推理会被 BFF proxy_read_timeout 以 504 杀死）。

**请求时机与工作模式**
- 主循环：单次提交最多递归 MAX_TURNS=100 轮；每轮结束若无 pending 工具调用先做 next-speaker 检查——只发最后一条 curated 消息+CHECK_PROMPT（不克隆全史）；最后一条是 functionResponse 直接判 model 免请求；判 model 则以 "Please continue." 续跑（client.ts:4073-4120、nextSpeakerChecker.ts:52-110）。
- sideQuery 统一通道：promptId 固定 `side-query:<purpose>`；默认 fast 模型；includeThoughts false。标题 purpose=session-title（≥2 条历史后、temp 0.2、maxOutputTokens 100、maxAttempts 1 不重试）；压缩 purpose=chat-compression；insight 分析是用户 `/insight` 主动命令非自动。
- git snapshot：仅会话开始构建 system prompt 时执行一次并缓存，自述 "frozen in time"，之后不再刷新（gitUtils.ts:225-295、client.ts:1153-1161）。
- 自动记忆任务：autoSkill 按 AUTO_SKILL_THRESHOLD 工具调用计数在 UserQuery 与 ToolResult 回合触发；记忆 extract/dream 仅 UserQuery 回合（每用户回合一次）（client.ts:2047-2160）。
- token 估算全本地（char/4 保守下界 + CJK 密集内容乘 1.5 安全系数），只用于提前触发压缩绝不用于跳过（tokenEstimation.ts:17-108）。
- thinking 路由：qwen3.8-max 关思考发 `reasoning_effort:'none'` 并删 enable_thinking/thinking_budget；老 qwen hybrid 发 `enable_thinking:false`；thinkingMandatory 模型永不下发禁用形（pipeline.ts:1119-1175）。
- 重试七类预算与 fallback 链见 §2.3/§2.4；模型 fallback 仅容量类 {429,503,529} 且重试耗尽后触发，最多 3 次各获全新预算；unattended 持久重试模式下禁用。

### 3.6 Hermes Agent

**传输特征**
- UA 分发（按 base_url 主机）：直连默认 SDK UA `OpenAI/Python 2.x`；RouterMint/Kimi `HermesAgent/<ver>`；x.ai `Hermes-Agent/<ver>`；chatgpt.com 后端伪装 `codex_cli_rs/0.0.0 (Hermes Agent)` 过 Cloudflare；portal.qwen.ai 伪装 `QwenCode/<ver> (<os>; <arch>)`；模型目录探测 `hermes-cli/<ver>`（run_agent.py:296-344,302-307,6318-6371、auxiliary_client.py:1160-1249、tools/xai_http.py:95-111）。本站观测其主流量 UA 正是 `OpenAI/Python 2.24.0`——**UA 完全无产品特征，只能靠提示词指纹识别**。
- 头：OpenRouter 三件套 + 可选缓存头；NVIDIA `X-BILLING-INVOKE-ORIGIN: HermesAgent`；Codex 路径注入 `session_id`、`x-client-request-id`、甚至 `x-grok-conv-id` extra headers（transports/codex.py:692-736）；Copilot 五件套（Editor-Version/Copilot-Integration-Id/Openai-Intent/x-initiator/视觉 Copilot-Vision-Request）；Anthropic beta `interleaved-thinking-2025-05-14`+`fine-grained-tool-streaming-2025-05-14`，MiniMax 端点剔除。
- api_mode 五种：chat_completions（默认）/ anthropic_messages / bedrock_converse / codex_responses / codex_app_server（stdio 子进程非 HTTP）；双线路由：同 portal 上 `anthropic/*` 模型自动落 `/v1/messages` 其余走 chat completions（transports/__init__.py、chat_completion_helpers.py:2606-2628）。
- stream 默认 true（90s stale-stream 检测 + 60s 读超时健康检查收益）；例外降级场景四种；辅助调用（标题/压缩）默认非流式。

**请求时机与工作模式**
- 主循环 run_conversation 约 3900 行单 turn 驱动器：工具结果持久化后追加 role:"tool" 回到下一轮 API 调用；迭代预算父 500/子代理各 50。触发源三种：CLI 输入、gateway 各平台消息、API server `/v1/chat/completions` POST（带 X-Hermes-Session-Id 续接）。
- 标题两阶段：本地派生零请求 → 小模型升级一次（thinking 关、输出约束 JSON），daemon 线程 fire-and-forget；cron/subagent 平台豁免（不为无人阅读的会话付费）（title_generator.py:1-15、turn_context.py:179-213）。
- 压缩：preflight + 每次 API 前 pressure check；post-response 门控依赖 last_prompt_tokens 会滞后于刚追加的大工具结果（源码注释自认）。
- trajectory_compressor 是离线批处理脚本非运行时组件（OpenRouter gemini-flash、temp 0.3、50 并发摘要）。
- cron：gateway 每 60 秒 tick，到期 job 才构造 AIAgent 走 LLM；no_agent 脚本型 job 跳过；fd 耗尽指数退避封顶 15 分钟。**这解释了本站观测的 Hermes 凌晨持续流量与小时级峰值**。
- 后台记忆审查：每回合结束 spawn_background_review 重放对话快照问"该保存什么技能/记忆"，与主对话及 prompt cache 隔离；cron 以 skip_background_review 抑制。
- 后台任务唤醒：terminal(background=true) 退出事件进 completion_queue，CLI/gateway 在每回合后排水自动触发新 turn。
- wake 自唤醒：scale-to-zero 场景 gateway 向自身 API server POST chat/completions（stream:false）续原会话，429 时退避重试（gateway/wake.py:100-150）。
- resume 不发任何请求：仅装载历史与恢复 cwd/model/provider，等用户下一条消息才触发首个请求。

### 3.7 OpenClaw

**传输特征**
- UA：`openclaw/<version>`（provider-attribution.ts:147,159-161）；变体：用量拉取 `openclaw/dev`、Cloudflare 裸 `openclaw`、媒体下载 `OpenClaw-Gateway/1.0`、链接理解 `OpenClaw-LinkUnderstanding/1.0`、GitHub API `OpenClaw-Control-UI`。
- 归因头：OpenAI/xAI 原生路由 `originator: openclaw` + `version` + UA 三件套（注释自证"Verified against the Codex wire contract"）；Gemini `x-goog-api-client`；NVIDIA billing origin；OpenRouter referer/title/categories。自定义代理端点被识别为 proxy-like 时隐藏归因被扣发（provider-attribution.ts:520-560）；Anthropic/Groq/Mistral/Together 归因默认关闭。
- 九种 KnownApi 家族；SDK @anthropic-ai/sdk@0.115.0 + openai@6.49.0；流式唯一（API 注册表只提供 stream/streamSimple 适配器；completions 参数硬编码 stream:true）；WS 传输可选 sse/websocket/websocket-cached/auto。
- Anthropic 支持服务端压缩：payload 注入 `context_management.edits[compact_20260112]` 按 input_tokens 触发（anthropic-payload-policy.ts:350-357）。

**请求时机与工作模式**
- 记忆压缩：每轮 assistant 响应后检查 `contextTokens > contextWindow − reserveTokens(16384)`；错误响应无 usage 用估算兜底；溢出 compact-and-retry 上限 3 次；压缩总结本身是独立 LLM 请求（compaction-safeguard.ts:989,1116-1156）。
- 心跳：默认 30 分钟（DEFAULT_HEARTBEAT_EVERY="30m"），实现为系统 cron monitor job；timer 到点 requestHeartbeat 唤醒，合并/忙重试/activeHours 守卫在 runner；空转回复 HEARTBEAT_OK 不投递用户；scratch 为空直接跳过 API 调用（heartbeat.ts:13-100、heartbeat-monitor.ts:47-77）。
- cron 到期 job 执行隔离 agent turn（CommandLane.Cron 泳道独立会话）；channel 消息经 dispatchInboundMessage → runReplyAgent。
- 子代理 sessions_spawn 四重准入：maxSpawnDepth/maxChildrenPerAgent/swarm 组预算（child-admission.ts:76-104）。
- session reset：none（默认）/daily（默认凌晨 4 点）/idle（按最后交互 + idleMinutes；未配置 idleMinutes 默认 0 即不过期——需显式配置）。
- 模型 fallback：agents.defaults.model.fallbacks 有序列表，fallback 不被 allowlist 过滤（"explicit user intent"）；failover 后注入本地生成的交接简报（handoff-summarizer.ts:16-40）。
- 并行限制见 §2.4；重试见 §2.3。

### 3.8 DeepSeek Harness（仅流量观测，本地无源码）

- UA：`deepseek-harness/<ver> (+https://github.com/deepseek-ai/deepseek-harness)`，版本迭代快（观测到 0.1.0-rc.6/rc.7、0.1.1-rc.1）。
- 提示词指纹："You are an AI agent powered by DeepSeek Harness"、结构块 harness:identity。
- 本站 4843 条记录全部为 chat 类型；模型偏好集中（mimo-v2.5 占 55%）；流量呈明显工作时段脉冲（22 点档 209 条/小时的爆发形态），未见凌晨心跳型流量。

---

## 4. 本站真实流量观测（生产库快照 2026-08-23）

### 4.1 来源分布与 UA 变体

| request_source | 请求数 | UA 变体数 | 主要 UA（按量） |
|---|---|---|---|
| grok | 45,739 | 20 | 空 UA 占 54%；`grok-pager/<v> grok-shell/<v> (<os>; <arch>)` 与裸 `grok-shell/<v> (...)`，版本 0.2.117→1.0.5 |
| unknown | 15,921 | 6 | 空 UA、`axios/1.13.2`(350)、`AsyncOpenAI/Python 2.24.0`(69)、Chrome/Electron(Claude Desktop, 2) |
| hermes | 11,143 | 1 | **全部为 `OpenAI/Python 2.24.0`**——零产品特征，印证提示词指纹必要性 |
| deepseek_harness | 4,843 | 3 | `deepseek-harness/0.1.x (+github链接)` |
| claude_code | 1,259 | 0 | 全部空 UA |
| opencode | 269 | 1 | `opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` |
| openclaw | 140 | 0 | 空 UA |

要点：**约 47% 的请求 UA 为空**，UA 维度在真实流量中覆盖率极低；opencode 的完整 UA 三段式（产品/SDK/运行时）与源码一致。

### 4.2 请求类型与模型偏好

- request_type 几乎全为 `chat`；fusion 仅 claude_code(35)/unknown(256)/opencode(12)/openclaw(2)；`crewrouter_command` 是本站自有命令通道（grok 29 条最多）。
- 模型偏好（近 30 天 Top）：claude_code→deepseek-v4-flash(798)；deepseek_harness→mimo-v2.5(2645)；grok→deepseek-v4-flash(8846)+gpt-5.6-sol/terra/luna 各 3500-4700；hermes→stealth/ox-alpha(1413)+deepseek-v4-flash(1338)。

### 4.3 请求时机节奏

- 小时级：Hermes 在 06:00-08:00 时段仍有 43-132 请求/小时的稳定流量，与源码发现的「gateway 每 60s cron tick + 回合后记忆审查」吻合。
- 间隔分布（Hermes，14 天）：**<300 秒桶占绝对主导（4742 次，工具循环连发），次峰在 ~3600-3900 秒（105 次，小时级定时任务）**——双模式特征明显，可作为网关侧「后台任务流量」识别启发式。
- 分钟聚集：2026-08-23 Hermes 流量集中在 07:14-07:20（单分钟最高 17 条），呈定时批量唤醒形态。

## 5. 身份伪装与识别启示（对 request-source.js 的建议）

1. **UA 完全不可靠的实证**：hermes 主流量 UA 为 OpenAI SDK 默认值；Qwen 主动伪装 claude-cli；Hermes 伪装 codex_cli_rs/QwenCode。现有「强专用 Header > 显式声明 > 提示词指纹 > originator > UA」优先级正确，建议保持。
2. **可新增的高价值识别头**：
   - Codex：`session-id`/`thread-id` + `x-openai-subagent`（还能区分 review/compact/memory_consolidation 子请求类型，可入库做请求分类统计）
   - Grok：`x-compaction-at`/`x-compactions-remaining` 头出现即可判定「该请求处于压缩临界」，可单独打点
   - OpenCode 第三方通道：`x-session-affinity` 头目前未纳入识别规则
   - Qwen DashScope 路径：`X-DashScope-UserAgent` 副本头
   - OpenClaw：`originator: openclaw` 已有规则，另有 `version` 头可提取版本号入库
3. **伪装纠正规则已有实证支撑**：request-source.js 中「Qwen 在代理路径伪装 claude-cli 但带 You are Qwen Code 可纠正」与源码行为完全一致（anthropicContentGenerator.ts:494-508）；Hermes↔OpenClaw SOUL 模板互斥仲裁逻辑亦与双方源码相符。
4. **后台流量识别**：Grok 标题生成请求无特殊头标记（仅输入截 8000 字节+输出限 80 字节的小请求形态）；Codex compact 子请求带 `x-openai-subagent: compact` 可精确统计压缩成本。网关可考虑对这类小请求做成本归并展示。
5. **stream 行为差异的网关影响**：Qwen 会显式发 stream:false——CrewRouter providers 层若强制改写流式需注意保留该字段语义；Codex/Grok 的 `store:false` 与加密推理内容 include 需原样透传否则上游可能报错。

## 6. 未确认事项汇总

| 事项 | 状态 |
|---|---|
| Claude Code 端点 `?beta=true` 参数拼接位置 | 由 @anthropic-ai/sdk 内部处理，src 未命中 |
| Claude Code 是否有客户端侧标题生成 | 未发现 |
| Codex 服务端标题生成 | 客户端不存在，服务端存疑 |
| Codex 定时任务驱动请求 | core 范围未发现 |
| Grok 除 billing/subscription 外周期性额度轮询 | 未确认 |
| Grok x-compaction-at 最终写头代码行 | 通过类型定义+e2e 测试确认语义，未逐行追到写头处 |
| OpenCode 运行时跨模型 fallback | 全文检索无命中，标注部分未确认 |
| OpenCode 单 step 工具并发度上限 | 无显式限制代码 |
| Hermes trajectory_compressor 是否被运行时 hook 触发 | 未见运行时调用点 |
| OpenClaw 心跳唤醒总线内部守卫参数 | 读到定义处未逐行核实 |

---

*报告完。证据路径均相对各 harness 源码库根目录；流量数据来自 CrewRouter 生产库 usage_records 表。*

