# 1fff5cc 最终独立审查

审查对象：提交 `1fff5cc`（`fix: harden billing and OAuth migrations`）中的最新源代码与测试。审查范围集中于财务事务失败传播、API Key 哈希迁移、内部 OAuth token 生命周期，以及任务书红线。

## 结论

**0 个 open issue。**

未发现提交 `1fff5cc` 仍存在已证实的功能性 bug，亦未发现违反任务书红线的改动：

- `server/routes/api.js` 的 8 个 `recordUsageAndDeduct` 调用均检查失败结果；计费事务异常带有 `billingFailure` 标记，未发送响应时返回 500，已进入流式响应时终止连接，不再继续伪装为成功完成。
- `server/utils/internal-oauth.js` 对缓存 token 在命中前查询数据库中的 `revoked`、过期状态和 token hash；缓存 TTL 为 5 分钟，并以 pending Promise 合并同进程并发签发。数据库仍只保存 token hash，没有恢复或伪造 API Key 明文。
- `server/scripts/init-db.js` 对旧 `api_keys` 表先以可空列补齐 `key_hash`，回填 SHA-256、检查重复值、清空明文，再设置非空约束和唯一索引；初始化过程置于事务中，失败会回滚。
- `server/middleware/oauth-bearer.js` 未被改动，符合任务书“不要修改该中间件现有逻辑”的红线。
- API Key 创建路径仍写入 `key_hash`、不写入 `key_value`；未发现将 hash 当作 Bearer token 或重新暴露明文的路径。

## 已执行验证

- `node server/scripts/test-financial-usage-static.js`：通过（8 个调用点、参数数量、失败传播断言）。
- `node server/scripts/test-request-source.js`：通过。
- 目标 JS 文件 `node --check`：通过。
- `git diff --check 1fff5cc^ 1fff5cc`：通过。
- 已审阅提交差异及 `scripts/migrate-api-keys-hash.js` 的事务/重复 hash 处理逻辑。

## 环境限制

仅剩数据库/端到端验证受环境限制：当前环境缺少 `pg` 模块且没有可用测试数据库，因此无法实测真实数据库迁移、事务回滚、token 吊销/并发、多进程行为，以及流式/非流式请求的运行时响应。`node server/scripts/test-usage-accuracy.js` 和迁移脚本 dry-run 均因 `Cannot find module 'pg'` 未能执行；这属于验证条件不足，不构成已确认的 open issue。
