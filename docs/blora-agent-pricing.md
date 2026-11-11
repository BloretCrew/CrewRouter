# Blora Agent 资料驱动倍率调整

## 适用范围

管理员在控制台「Blora Agent → Manage」中上传资料（图片、文本、PDF、DOCX、XLSX）、粘贴链接或启用联网搜索，并要求 Agent 按上游价格调整一个、多个或全部供应商的模型请求倍率。

写操作必须经过审批：Agent 先调用 `preview_multiplier_batch` 生成草案，管理员在审批卡上确认后，`batch_set_model_multipliers` 才在单个事务中落库。拒绝不会修改任何模型。

## 计费与换算

CrewRouter 的倍率计费公式（`server/utils/billing.js`）保持为：

```text
weighted_tokens = (非图片输入 + 图片输入 × image_ratio + 缓存输入 × 0.1 + 输出) × model_multiplier
points = weighted_tokens / 1,000,000
```

因此：

```text
new_multiplier = 上游每百万 Token 价格 × 加价系数 × 汇率
```

- 1 积分 = 1,000,000 加权 Token。
- 实例积分按人民币口径折算；资料为 USD 等外币时必须由管理员提供汇率。
- 单倍率无法同时精确表达输入价、输出价和缓存价。Agent 必须让管理员选择 `basis`（`input`/`output`/`single`），并在预览中标记 `output_price_mismatch`、`cache_price_mismatch` 等风险。
- 只修改 `model_multiplier`，不修改 `completion_multiplier`；后者当前不参与计费。

## 草案结构

`preview_multiplier_batch` 返回：

- `changes`：每项的当前倍率、服务端重算的新倍率、来源价、币种、汇率、加价系数、风险标记。
- `write_args`：可直接传给 `batch_set_model_multipliers` 的参数。
- `unmatched`：找不到或存在多个候选的模型，不猜测。
- `errors`：缺价格、缺币种、缺汇率、缺计价单位、倍率越界等。
- `summary`：变更、未变、过期、未匹配和无效项计数。

`batch_set_model_multipliers` 会再次校验：

- 1–100 项，模型 id 唯一。
- 新倍率 `0.0001–10000`，四舍五入到 4 位。
- 服务端重算结果与提交值偏差不超过 0.0001。
- 事务内按 id 排序加锁，逐项比对 `expected_current_multiplier`；任一不一致则整批回滚并返回 `stale_multiplier`（HTTP 409）。

## 资料限制

| 类型 | 限制 |
| --- | --- |
| 图片 | PNG/JPEG/WebP/GIF，单张 ≤4 MiB，每条消息最多 5 个附件 |
| 文本 | txt/md/csv/json/yaml/yml/log，UTF-8 或 GB18030 |
| PDF | 文本型，最多 100 页；扫描版会提示改用图片 |
| DOCX | `.docx`；旧版 `.doc` 不支持 |
| XLSX | `.xlsx`/CSV，最多 20 个工作表、5000 行、200 列 |
| 链接 | http/https，80/443，最多 5 次重定向，8 MiB，12 秒超时 |
| 总量 | 单次 ≤20 MiB，每对话最多 50 个附件 |

提取文本单附件上限 120,000 字符；超出后截断，Agent 可通过 `read_attachment` 分页读取。图片只物化到本轮最后一条用户消息，历史图片不会在后续运行中自动重发。

## 安全

- 链接抓取复用 `pinnedFetchValidated`：固定 DNS、逐跳校验、拒绝私网/元数据地址、拒绝 HTTPS 降级、跨 origin 剥离凭据。
- 网页、搜索结果和文档正文统一标记 `trust: "untrusted"`；system prompt 明确禁止把资料当指令。
- 搜索服务 API Key 在通用设置接口和专用接口中都会脱敏；通用 `PUT /api/admin/settings` 拒绝写入 `agent_web`。
- 所有写操作仍需管理员审批，参数在服务端重算与校验。
- 审批成功后写 `admin.model_batch` 审计日志，包含变更模型和旧/新倍率（超长截断）。

## 验证

```sh
node server/scripts/test-agent-tools.js
node server/scripts/test-agent-multiplier.js
node server/scripts/test-agent-attachments.js
node server/scripts/test-agent-fetch.js
node server/scripts/test-agent-web-search.js
node server/scripts/test-agent-transactions.js
node server/scripts/test-agent-images.js
node scripts/test-blora-agent-registration.js
npm run docs:check
```

集成测试使用临时 Unix-socket PostgreSQL 集群和合成文件，不读取生产配置或数据库。
