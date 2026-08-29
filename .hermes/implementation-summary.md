# 实现总结

## 改动文件

- `server/utils/balance.js`：修复 settleBalance 幂等性；deductPoints 支持外部 client；新增 usage 与扣款事务 helper。
- `server/utils/key-hash.js`：新增统一 SHA-256 工具。
- `server/utils/internal-oauth.js`：新增内部 OAuth access token 签发。
- `server/routes/api.js`：认证、签名查询及缓存改用 key_hash；8 处 usage 写入与积分扣款事务化。
- `server/routes/user.js`：创建 Key 使用 SHA-256、停止写入明文；列表不返回 key_value；cc-switch 查询改 hash。
- `server/routes/setup.js`、`server/routes/feishu.js`、`server/routes/passport-auth.js`：初始化 Key 改为只写 hash。
- `server/routes/oauth.js`、`server/middleware/oauth-bearer.js`：复用统一 SHA-256 工具。
- `server/routes/sessions-view.js`：内部会话调用改用 OAuth token。
- `server/index.js`：请求日志缓存改 hash；启动迁移放宽 key_value 非空约束并增加 key_hash 唯一索引。
- `public/js/app.js`：老 Key 无完整值时隐藏显示/复制按钮。
- `scripts/migrate-api-keys-hash.js`：新增存量 Key 迁移脚本，默认 dry-run；仅显式传 `--apply` 才写库。

## 完成情况

- 1A：完成 pending 条件与 rowCount 检查，重复结算不再重复退款/补扣。
- 1B：完成可选 client 与 8 处 usage/扣款事务化，保留各点位原有列集合。
- 2A-2H：完成统一 hash、建 Key 停写明文、认证及缓存查询改 hash、内部 OAuth、前端防回显、迁移脚本及启动 DDL。

## 验证输出

- `node --check server/utils/key-hash.js`：通过。
- `node --check server/utils/balance.js`：通过。
- `node --check server/routes/api.js`：通过。
- `node --check server/routes/user.js`：通过。
- `node --check server/routes/sessions-view.js`：通过。
- `node --check server/index.js`：通过。
- `node --check scripts/migrate-api-keys-hash.js`：通过。
- 任务书中的数据库测试与 dry-run 尚未在本环境执行；未执行真实迁移、未重启服务、未 push。

## 遗留风险

- 内部 OAuth token 需要 `oauth_tokens` 表可用，首次调用会懒建 OAuth 表；当前实现每次签发新 token，旧的有效 token 不复用。
- 当前环境未连接数据库，无法确认迁移行数、数据库测试及运行时会话总结/老 Key 兼容性。

- 新增无数据库静态断言：确认 `api.js` 有 8 个 `recordUsageAndDeduct` 点位，且每个点位包含失败检查；确认每个 usage SQL 占位符数量与参数数组长度一致。
- 数据库相关测试仍受当前环境缺少 `pg` 模块影响；未执行真实迁移，未重启服务，未 push。

## Review 修复补充

- 8 个 usage 事务点位已增加失败传播检查；`server/scripts/test-financial-usage-static.js` 无数据库静态断言通过。
- Claude Code 配置接口对历史 Key 明确返回 HTTP 410，不读取明文、不使用 hash 充当 token。
- internal-oauth 增加按 API Key 的进程级短期缓存、并发 Promise 合并、过期/吊销 token 清理。
- init-db.js 已同步可空 key_value 与唯一非空 key_hash 定义。
- 迁移 `--apply` 使用单事务并检查重复 hash，默认仍 dry-run；本次未执行真实迁移。
- 静态检查、request-source 测试和财务静态断言通过；数据库测试、迁移 dry-run 和端到端验证受环境缺少 `pg`/数据库限制未完成。

## 第二轮审查修复

- usage 计费失败不再被局部 catch 吞掉：未发送响应时返回 500，流式已发送响应时销毁连接；无数据库静态测试已覆盖 8 个点位及外围 catch。
- internal-oauth 缓存命中前校验数据库 revoked/expired 状态，TTL 缩短为 5 分钟，并保留并发签发合并。
- init-db 旧表迁移改为事务内的分阶段可空补列、回填、重复检查、清空明文、最后约束化。
