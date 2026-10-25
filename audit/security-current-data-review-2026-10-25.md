# 当前数据库只读复核

日期：2026-10-25。数据库实测时间：16:11:09 CST（`2026-10-25T08:11:09.602Z`）。

## 结论与证据边界

本轮已在生产数据库真实运行完整只读审计脚本，报告为 `readOnly=true`、`complete=true`，事务最终 `ROLLBACK`。退出码为 `1`，唯一报告风险是应用角色 `crewrouter` 仍有 `public` schema 的 CREATE 权限（`publicSchemaCreate=true`）；其他高危角色标志均为 false。当前检查范围内没有发现关系或业务不变量异常，但这不能证明余额真实、历史记录完整或恢复过程正确。

用户本轮明确没有事件前备份、物理恢复输出、逐表导入记录，也没有可定位的具体错乱对象。附件所称 81 GB 原库与 728,981 行恢复仅是材料中的说法，当前没有独立记录可核验。可以核验当前记录之间的关系，不能由当前关系一致反推历史完整；不得按现有汇总自动补账、生成退款或兑换历史、调整余额，或重建历史队列。未来取得独立付款、兑换或配置凭证后，再逐项对账并保留来源。

本轮只读证据位于 `/root/crewrouter-audit-evidence/20261025T081109Z-data-consistency/security-audit.json`，SHA-256 为 `23015e8ff395c5fb8ebea04ce3d7e936ac0066b1992b9025ad48a37f0ebeebce`。目录为 `0700`，文件为 `0600`；`execution.json` 记录命令、起止时间、基线提交和审计源码哈希，`SHA256SUMS` 覆盖本轮证据文件，根代理已复核哈希一致。证据仍在失陷主机本地；哈希用于识别该文件，不提供独立可信性，应将报告及哈希异机保全。

## 新增队列、Harness 与提示词检查

新增检查涉及的四张表均存在，通过表类型预检且没有启用 RLS。生产完整脚本本次已成功执行新增聚合检查，结果如下：

| 检查节 | 当前记录数 | 风险结果 |
| --- | ---: | --- |
| `apiKeyQueues` | 12 | `orphanKeys`、`orphanModels`、`duplicateBindings` 均为 0 |
| `apiKeyHarness` | 0 | 所有风险指标均为 0 |
| `promptRecords` | 2 | `orphanOwners=0` |
| `promptBindings` | 0 | 孤儿、跨属主及重复绑定指标均为 0 |

`duplicateBindings` 表示重复键组数，不是重复行数。队列和提示词的排序值重复、负默认排序，以及 `current_model_id` 不在队列中，本身不作为异常；Legacy NULL 属主也不因此误报。当前 Harness 和提示词绑定为空，零风险不能证明这些功能的生产业务行为已得到覆盖。

## 既有检查与前次快照比较

与 13:57:08.822 的快照比较，共同的 18 节中有 17 节完全一致。`redemptionCodes` 节原有的 `usedCountMismatches`、`codesOverUseLimit`、`invalidCodeValues`、`orphanCreators` 四项均为 0；新增的 `orphanUses`、`duplicateUses`、`balancesWithoutUse` 三项也均为 0。这是检查字段扩展，不能据此宣称业务数据发生变化。

本次余额汇总为 `901353.6882`，退款汇总为 `0.0000`，数据库大小为 `296425151` 字节。41 个序列的 `behind` 指标为 0；团队、身份、余额明细、预扣、兑换、成员和 catalog 检查的风险指标均为 0。这些数字仅描述当前活库及审计覆盖的不变量，不证明资金真实、业务授权正确或已删除历史不存在。

当前 29 个供应商中有 28 个启用，12 个插件全部禁用；活动及过期 session 均为 0，启用的用户 Key 为 0，其中保存可恢复 Key 值的启用 Key 也为 0，`refundHistory` 为 `[]`。没有退款历史记录不能证明历史上未发生退款。

## 执行与验证范围

此前 `08:06:47Z` 与 `08:10:21Z` 两次启动失败，stdout 为空，stderr 为 65 字节的 `Remote peer disconnected`，没有形成完整审计结果；失败证据目录保留。使用 `/usr/bin/true` 复现表明，stdout/stderr 直接传入普通文件时出现相同失败；保持相同隔离属性、改为通过 subprocess PIPE 收集输出后成功，没有放宽隔离。本次完整生产报告与这两次启动失败分开保留。

离线回归为 33/33 通过。隔离 PostgreSQL 使用新增四表的真实 DDL 验证了新增原样聚合块，独立只读复核通过；完整审计流程的离线测试使用 mock，不能表述为完整流程已在隔离真实数据库验证。缺列的旧 schema 会失败并退出 `2`，不代表审计完成。本次生产完整脚本则已真实执行并报告完成。

16:12:08.309547 CST 运行态复核显示，应用仍为 root / PID 1407，10-24 12:36:00 启动，状态为 active/running；`NoNewPrivileges`、`ProtectSystem`、`ProtectHome`、`PrivateTmp` 均为 no。guard 为 `LoadState=not-found`、inactive/dead，实时 nft 表清单只有 ip/ip6 的 filter/nat，没有 incident guard 表。本轮只读取 nft 表清单，没有检查 INPUT policy；不能将 14:27 的策略当成本次实测。

运行态证据 `application-state.txt`、`guard-state.txt`、`nft-tables.json`、`runtime-execution.json` 与更新后的 `SHA256SUMS` 保存在上述同一证据目录。本轮未写入配置、部署、重启、修改生产业务数据或恢复 guard。数据库审计完成不意味着旧进程已加载仓库补丁或主机恢复可信。运行态和防护边界继续参见 [事件记录](security-incident-2026-10-25.md) 与 [可信重建清单](security-recovery-runbook-2026-10-25.md)。
