# public CREATE 风险：可执行、默认只读的人工处置方案

日期：2026-10-25。此文及配套 SQL 是待审阅的操作材料，**没有在生产执行**。不得仅凭仓库补丁、历史快照或临时库测试宣布生产风险解除。

## 范围和安全边界

入口为 `audit/review-public-schema-create.sql`，由人工使用 `psql --no-psqlrc` 执行。它不读取应用配置、不自动选择连接、不创建角色、不迁移/修改业务数据、不修改口令、不修改对象归属或角色成员关系，也不自动执行部署。仅在显式授权的 apply 模式中尝试撤销目标数据库 `public` schema 上的两项 CREATE 授权：`PUBLIC` 与指定应用角色；不撤销 USAGE、表或序列权限。

三种模式：

| 参数 | 行为 |
| --- | --- |
| 不指定 `apply` | `REPEATABLE READ READ ONLY`，检查后 `ROLLBACK`，不执行 REVOKE |
| `apply=true authorization=REVOKE_PUBLIC_CREATE` | 真实执行 REVOKE 和后置检查，但默认 `ROLLBACK` |
| 上述参数再加 `commit=true` | 所有断言通过才 `COMMIT` |

`authorization` 是操作人员已获得授权的显式确认标记，不是密码，也不是数据库权限控制的替代品。**预演模式也会临时写系统目录并获取锁，因此生产预演同样需要人工授权和维护窗口**。错误会通过 `ON_ERROR_STOP` 非零退出；未提交连接关闭时回滚。禁止把“默认回滚”当成可在生产擅自执行的理由。

## 为什么不能只运行一句 REVOKE

- `REVOKE CREATE ... FROM PUBLIC` 不移除直接授给应用角色或其成员角色的权限。
- 仅撤销当前应用角色权限不影响 PUBLIC 的授予，且 `NOINHERIT` 角色仍可能通过角色切换获得权限。
- schema 所有者即使撤销自己的普通 CREATE ACL，仍能重新授权；数据库所有者及其角色关系同样不能当作低权限运行态。
- SQL 对所有 `MEMBER` 关系采取保守检查，包括跨层成员和所有权；不会自动撤销成员关系。在 PostgreSQL 支持细粒度 SET/INHERIT 选项的版本中，不能切换且不继承的成员关系也可能被保守阻断，需 DBA 单独审阅，不表示已证明可利用。
- 应用或成员角色具有 superuser、CREATEROLE、CREATEDB、REPLICATION、BYPASSRLS 时拒绝处置；不能用撤销 schema CREATE 掩盖更大的权限问题。

脚本保留原始 schema ACL、schema/database owner、操作者与成员角色输出。发现所有权或残余成员权限时整体失败回滚，**不会留下只撤销 PUBLIC、却仍能从其他来源取得 CREATE 的部分修复**。不执行 `REASSIGN OWNED`、`DROP OWNED`、`CASCADE`、所有权转移或批量成员撤销。

## 操作前必须完成

1. 从可信终端确定目标数据库、应用运行角色、审阅人、授权单和维护窗口；不要把历史报告中的角色、主机或管理端点当作当前已核准事实。本轮没有重新连接生产，当前所有权及 ACL 分配仍未知。
2. 取得可信恢复副本及经审批的备份/还原记录；在隔离副本先运行同一文件并保存输出。事件主机上的现有数据库不因关系审计为零而恢复可信。
3. 冻结并发角色、ACL、归属及 schema 变更；确认其他使用该数据库的应用不依赖 PUBLIC CREATE。它是数据库级的共享 schema 权限，不仅影响 CrewRouter。
4. 逐项核准运行角色与迁移角色的职责，不能让运行角色通过成员关系重新取得迁移/owner 权限。需要创建角色、转移所有权或调整成员关系时，另列最小对象清单和独立授权；此脚本会主动报 blocker，不替你完成这些操作。
5. **在恢复副本上，以将使用的运行角色跑实际应用启动和功能验收**。CrewRouter 目前仍在启动/功能初始化时执行 DDL 和迁移，不是已经完成迁移角色分离的应用；现有表归属也不在此脚本处置范围。缺表、新函数、扩展或版本升级可能因为缺少 CREATE 而失败。未验证这一点，不得在生产提交撤权，也不得为了启动成功重新给运行角色全库 CREATE。
6. 保存原始 ACL、所有权、成员关系、表/序列授权清单；将脱敏输出与 SQL/应用版本的 SHA-256 放到独立证据存储。需要回退时，由 DBA 从该清单生成**精确逆向授权**，仅恢复原有 grantee、权限及 grant option，不使用无条件 `GRANT CREATE TO PUBLIC` 当成通用回滚。

## 人工执行命令模板（本轮均未执行）

以下 service 名是占位的 libpq service，必须在可信终端预先配置目标和凭据；不得直接复制成生产目标。口令不要放进命令行、Git 或报告。`REVIEW_DB` 和 `REVIEW_APP_ROLE` 必须来自上述核准清单。

```sh
: "${REVIEW_DB:?填写已核准的数据库名}"
: "${REVIEW_APP_ROLE:?填写已核准的应用运行角色}"
```

第一步，获得只读检查授权后采集；保存输出并让 DBA 审阅。`expected_database` 校验实际数据库名，但不能验证主机身份或环境归属，连接目标必须由人工独立确认。

```sh
psql --no-psqlrc --no-password 'service=crewrouter_reviewed_target connect_timeout=10' \
  --set=expected_database="$REVIEW_DB" \
  --set=application_role="$REVIEW_APP_ROLE" \
  --file=audit/review-public-schema-create.sql
```

第二步，只有已获目录写入/锁操作授权、并已在隔离副本通过兼容性测试，才执行真实撤权预演；核对 `PREVIEW ONLY`，退出码应为 0，授权应在回滚后恢复原样。

```sh
psql --no-psqlrc --no-password 'service=crewrouter_reviewed_target connect_timeout=10' \
  --set=expected_database="$REVIEW_DB" \
  --set=application_role="$REVIEW_APP_ROLE" \
  --set=apply=true --set=authorization=REVOKE_PUBLIC_CREATE \
  --file=audit/review-public-schema-create.sql
```

第三步，取得独立的正式变更批准，复核无 ACL 漂移、其他应用影响和恢复方案后，才在上述命令增加 `--set=commit=true`。只有退出 0 且输出 `APPLIED` 才表示此脚本事务已提交；任何 blocker 都必须停止，不能删断言、忽略退出码或拆成两条生产 REVOKE 规避保护。

## 验收与回退

- 用新连接重新运行默认只读检查，确认运行角色没有有效 CREATE、没有可恢复该权限的成员/owner 路径，USAGE 及原有表/序列授权仍符合清单。
- 在隔离副本用运行身份确认不能新建 schema 对象，并验证正常读写和序列；生产不要通过写探针表证明拒绝，也不要在未经授权时重启应用。
- 按单独批准的部署窗口验证真实版本启动、鉴权、路由、余额/队列并发及功能初始化。应用和迁移身份分离尚未完成时，保持上线阻断，而不是自动扩大授权。
- 提交前失败由事务回滚；提交后的回退由 DBA 执行已审阅的精确逆向授权。不要回退到不可信旧服务进程或无条件恢复 PUBLIC CREATE。
- 权限收缩不会移除已有恶意对象、触发器、函数、扩展或历史数据篡改，也不替代可信重建、凭证处置和历史对账。它不能解决运行角色已经拥有的表的 ALTER/DROP 权限；这属于另行审阅的角色/所有权分离。

## 本轮可验证范围

配套测试 `npm run test:public-schema-create` 只创建全新临时 PostgreSQL 集群，使用私有 Unix socket、空 TCP 监听和合成角色/表。它直接以 `psql` 执行上述原文件，覆盖默认只读、缺参数/授权、错库、带引号/SQL 外观角色名、权限不足、预演回滚、成员权限、owner、高危属性、提交、幂等和保留既有 DML/序列权限；临时集群停止后删除其生成目录。

该测试还执行审计器原样角色查询，覆盖 NOINHERIT 成员权限以及 owner 撤销自身 CREATE 后有效授权为 false 的情况。不代表完整生产审计或实际应用启动已在新角色下通过。完整结果见 `audit/security-guard-permissions-review-2026-10-25.md`。
