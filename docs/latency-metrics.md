# 延迟、吞吐与上游限流指标

CrewRouter 在网关层记录每次 API 调用的延迟、生成速度和上游限流状态，并在用户控制台与管理后台的“延迟与吞吐”标签中按时间段、模型和供应商聚合。

## 指标口径

所有时间以服务端收到请求的时刻为起点（请求体解析前），以实际写出下游响应为终点。

| 指标 | 字段 | 计算 | 适用 |
| --- | --- | --- | --- |
| 首字延迟 TTFT | `ttft_ms` | 第一个非空生成增量（content / reasoning / tool 参数）就绪时间 − 请求到达时间 | 流式 |
| 上游首字节 | `upstream_first_byte_ms` | 首次收到上游响应体 chunk − 本次上游 attempt 开始时间 | 流式；非流式回退到响应头时间 |
| 生成耗时 | `generation_ms` | 最后一个生成增量 − 第一个生成增量 | 流式 |
| TPOT / ITL | `tpot_ms` | `generation_ms / (completion_tokens - 1)` | 流式且输出 Token > 1 |
| 输出速度 | `output_tps` | `completion_tokens / (generation_ms / 1000)` | 流式且生成耗时 > 0 |
| 端到端耗时 | `e2e_ms` | 响应结束 − 请求到达 | 全部 |
| 上游处理时间 | `upstream_processing_ms` | 上游 `openai-processing-ms` | 上游返回该头时 |
| 服务层级 | `service_tier` | 上游响应体 `service_tier`，回退到请求值；Anthropic `speed: "fast"` 记为 `fast` | 全部 |
| 限流快照 | `rate_limit` | `x-ratelimit-*`、`anthropic-ratelimit-*`、`anthropic-fast-*`、`retry-after` 原始值 | 上游返回限流头时 |
| 流式标记 | `is_stream` | 请求是否使用 `stream: true` | 全部 |

`latency_ms` 保留原语义（从代理调用开始到写入用量记录），新的端到端口径使用 `e2e_ms`。两者可能不同，页面分别展示为“记录延迟（服务端）”和“端到端延迟”。

## 采集行为

- 请求起点在全局 body parser 之前设置，因此 `e2e_ms` 包含请求体上传和解析时间。
- 模型队列或 Key 回退时，只记录最终成功 attempt 的 TTFT、首字节、生成耗时和限流头；`e2e_ms` 包含失败 attempt 的耗时。
- 非流式请求只记录 `e2e_ms`、`upstream_processing_ms`、`rate_limit`、`service_tier`，TTFT / TPOT / TPS 为空。
- 上游未返回 usage 时，不根据字符数伪造 Token；TPOT 和 TPS 为空。
- Fusion 与 Playground 使用请求级端到端计时，记录 `is_stream` 与 `e2e_ms`，其余指标为空。
- 上游限流头只转发白名单前缀到下游响应；`set-cookie` 等头不会转发，值会过滤 CRLF 并限制长度。

## 统计接口

### 用户

`GET /api/user/stats/latency?days=7` 或 `?start=YYYY-MM-DD&end=YYYY-MM-DD`

可选过滤：`model_id`、`provider_id`、`request_source`、`is_stream=1|0`。

### 管理后台

`GET /api/admin/stats/latency?days=7`，参数相同，返回全实例数据。

### 返回结构

- `window`：实际查询区间、是否因 90 天上限被裁剪。
- `coverage`：总请求数、已采集数、覆盖率。
- `summary`：TTFT / E2E / TPOT / 输出速度 / 上游处理时间的 P50/P75/P95/P99，缓存命中率，以及 ≥50 / ≥80 / ≥90 / ≥100 tokens/s 的请求占比。
- `byModel`、`byProvider`：按模型和供应商的请求数、已采集数、TTFT 百分位、TPS P50、E2E P95、缓存命中率。
- `daily`：每日 TTFT P50/P95、E2E P95、输出 TPS P50。
- `rateLimits`：每个供应商最近一条带限流头的记录。

百分位使用 PostgreSQL `percentile_cont`（线性插值）。统计只覆盖 `usage_records` 的明细保留窗口，最多查询 90 天；更早的 `usage_agg` 聚合表没有延迟字段。

## 性能与限制

- 查询使用独立连接执行 `SET LOCAL statement_timeout = 20000`，超时返回 503，页面提示缩小时间范围。
- 统计结果在进程内缓存 60 秒，避免管理后台轮询重复执行百分位查询。
- 不新增索引；现有 `usage_records(created_at)` 与 `(user_id, created_at)` 索引用于时间过滤。若生产环境仍慢，可单独评估并发创建覆盖索引。
- 历史记录没有这些字段，页面用覆盖率说明；覆盖率 0% 时不会显示伪造的 0ms。
- 服务端计时不包含客户端到 CrewRouter 的网络时间；上游限流头的语义由各供应商定义，页面按原始值展示。
