# 供应商额度历史与分析

## 数据口径

供应商额度来自上游账户查询。请求数、Token 和积分来自 CrewRouter 的请求记录。额度变化可能包含其他客户端直接调用上游产生的用量，因此“观测消耗”表示相邻有效观测的变化，不能作为单个成员、项目或请求的精确账单。

余额按计量单位分别展示；未知单位独立展示。百分比按额度账户与额度窗口展示。共享订阅、供应商汇总和逐 Key 明细应按账户身份去重，避免重复累计。

历史开始于首次导入的已有最新快照及后续实际查询。系统没有过去额度的原始观测，无法还原更早的变化。旧快照的逐 Key 下标和掩码无法可靠映射当前密钥，因此标记为历史导入账户。

## 采集

后台供应商“查询额度”、控制台刷新与启用后的定时查询都会留下历史。缓存读取不产生新的有效样本；CPA 被动观测保留上游观测时间。查询失败保留最后有效结果，同时显示最近查询失败与陈旧状态。

启用方式：后台 → 供应商 → 编辑 → 额度设置，启用额度查询并配置对应模式。持续趋势建议同时启用定时查询。分析页面查询已有历史，不会因打开统计页额外批量请求上游。

凭据只参与服务端稳定账户身份计算，历史记录与分析响应不会保存明文密钥、OAuth Token 或 CPA 管理密钥。凭据轮换、额度模式/配置切换可能建立新的账户序列。

## 分析

后台和用户统计页提供额度概览、账户明细、趋势与历史。选定日期范围按 Asia/Shanghai 自然日计算。期末额度表示该范围结束前最后有效观测，页面需同时查看观测时间与最近查询状态。

多维分析支持请求用量、供应商额度和关联分析。额度原生维度包括供应商、额度账户、类型、窗口、单位及日期。成员、Team、项目、客户端、模型和平台 API Key 展示请求贡献与关联供应商额度。平台 API Key 与上游供应商 Key 属于不同身份。

同供应商关联到多个账户或窗口时，每个账户行的请求贡献均是供应商上下文；请求贡献总计应使用独立去重汇总。稀疏采样、充值、额度调整、周期重置与回补都会影响观测变化，未知变化应保留为空。

普通用户只能查看当前授权范围内、允许展示额度的供应商。Team 隐藏额度、模型授权撤回等规则也适用于历史 API。用户的请求贡献仅包含自己的请求。

## 长期保留

额度日聚合长期保留。后台 → 设置 → 数据保留中的“供应商额度明细保留天数”默认 90 天，0 表示永久保留明细。明细只能在同一事务完成聚合后清理。供应商请求关联通过独立 `provider_usage_daily_agg` 和请求 ID 归档账本保存；已归档数据与尚未归档明细互斥查询，避免重复计数。

每日用量聚合和请求清理前均归档供应商维度；重跑及迟到请求使用请求 ID 去重。被功能启用前清除的历史无法补齐供应商和项目维度。Team 关联沿用现有统计的成员当前主 Team 口径。

## 验证命令

现有回归：

```sh
npm run test:quota-usage
npm run test:usage-accuracy
```

供应商请求长期归档测试仅允许本地专用测试库：

```sh
QUOTA_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:18579/crewrouter_quota_test \
  node server/scripts/test-provider-usage-history.js
```

新增后端验证：

```sh
node server/scripts/test-provider-quota-stats.js
QUOTA_HISTORY_TEST_DATABASE_URL="$QUOTA_TEST_DATABASE_URL" node server/scripts/test-provider-quota-history.js
QUOTA_STATS_TEST_DATABASE_URL="$QUOTA_TEST_DATABASE_URL" node server/scripts/test-provider-quota-stats-db.js
node server/scripts/test-provider-quota-integration.js
```

上述数据库命令使用预先导出的本地 `QUOTA_TEST_DATABASE_URL`，自动创建并移除隔离 schema。集成测试覆盖实际落库、共享账号、部分窗口、权限、清理连续性，并对查询执行 `EXPLAIN ANALYZE`。

浏览器回归：`node scripts/test-provider-quota-stats-browser.js`，需先按文件说明启动隔离 demo 服务及 Chrome，通过 `BLORA_TEST_URL` / `BLORA_CDP_URL` 配置测试地址。浏览器测试使用模拟上游数据；真实账户验证需要另行提供账号与授权。

## 上线

启动新版服务前备份数据库并配置稳定服务端密钥。启动迁移会创建额度历史与长期请求聚合表，并导入已有最新快照。部署或重启共享实例需要单独授权。无需修改现有请求扣费配置。
