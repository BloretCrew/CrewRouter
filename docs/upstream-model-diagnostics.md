# 上游响应模型诊断

CrewRouter 为调用记录保存三种模型身份，帮助排查模型映射、队列切换及上游降级。

| 字段 | 含义 |
| --- | --- |
| `requested_model` | 客户端原始请求的模型名 |
| `resolved_model` | 本次尝试实际发给上游的模型名 |
| `response_model` | 原始上游响应或流式事件声明的模型名 |

模型身份在正常调用过程中采集，不会额外发起模型探测请求。采集发生在响应插件改写和协议转换之前。每次重试独立维护身份，最终调用记录关联产生该记录的尝试。

## 如何判断

- 路由模型与响应模型相同：模型名称一致。
- 两个有效名称不同：模型名称不一致，需要结合供应商别名与版本映射排查。
- 响应没有模型字段：上游未提供。
- 历史记录没有采集值：保留缺失状态。

上游响应模型来自供应商返回的信息，供应商可能改写它。名称比对可以提供模型切换线索，模型权重真实性需要独立证据。日期后缀、别名和版本映射也可能产生差异。

该功能保留既有计费、Token 统计、配额和队列策略，不自动禁用供应商或更改账单。

## 数据与部署

`usage_records` 新增三个可空 TEXT 字段。新实例建表和既有实例初始化迁移均包含字段定义。历史数据保持 NULL，避免从当前配置反推历史模型身份。

用户和管理员的调用记录、详情、会话中关联调用及导出使用这些请求级快照。单一记录代表多模型融合结果时，缺少有效单模型证据的身份保持缺失。

上线前建议备份数据库，在隔离环境验证迁移与锁等待，再安排生产升级。代码提交本身不会启动生产迁移或重启实例。

## 验证命令

- `npm run test:model-identity`：采集、协议转换、重试、权限、导出、会话合并与界面转义测试。
- `MODEL_IDENTITY_TEST_DATABASE_URL=... npm run test:model-identity`：额外执行隔离 PostgreSQL 集成测试；地址必须为本机，数据库名以 `crewrouter_model_test` 开头。
- `MODEL_TEST_PG_PORT=... node server/scripts/test-model-identity-postgres.js`：临时本机数据库的迁移设置恢复与锁等待测试。
- 浏览器测试先分别运行 `node scripts/test-model-identity-browser.js --server` 和 `--chrome`，再运行 `npm run test:model-identity:browser`。默认端口为 18671 / 18672，服务使用隔离 demo 与内存夹具，结束后停止测试服务并清理临时下载文件。

浏览器夹具验证真实页面交互，模型调用使用模拟传输；代理函数与数据库分别有独立测试。真实供应商、生产迁移和完整登录到持久化调用的 HTTP 链路需要上线前另行验收。

## 参考

- [CPA-Manager-Plus v1.13.1](https://github.com/seakee/CPA-Manager-Plus/blob/main/docs/release-notes/v1.13.1-zh.md)
- [CLIProxyAPI 原始响应采集](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/helps/usage_helpers.go)
