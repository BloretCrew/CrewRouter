# PassKey 与 OAuth 入口安全复核

日期：2026-10-25。接续 [认证安全补充记录](security-auth-review-2026-10-25.md)。以下代码问题不等于本次攻击的已证实利用路径。

## 当前结论

16:43:52 CST 生产只读审计完成，`readOnly=true`、`complete=true`、退出码 `1`。新增统计发现 **两名管理员均持有 PassKey，其中一名启用了本地 2FA**。旧 PassKey 路由直接建立登录会话，没有检查 `two_factor_enabled`；因此绕过本地 TOTP 的代码问题涉及当前管理员账号。该快照不能确认 PassKey 的注册者、注册来源或事件期间是否使用过它们。

当前 OAuth access/refresh token、授权码和邀请表均为零行。所有新增重复凭证、非规范 PassKey 形状、孤儿及所有人不符指标均为零。余额明细、团队、兑换、队列、提示词和 41 个序列等共同字段与 16:11 快照一致；唯一审计退出码风险仍为应用角色 `publicSchemaCreate=true`。聚合检查没有把正常存在的 PassKey、2FA、活动 token 或邀请本身当作漏洞。

运行态仍是 root/PID 1407，自 10-24 12:36 启动；没有加载本次补丁。incident guard 单元仍 `not-found`，实时 nft 表清单没有对应表。未修改生产业务记录、数据库权限、防火墙或服务。没有事件前备份或恢复输出，历史完整性仍未验证。

## 已确认问题与仓库修复

| 问题 | 原行为与影响 | 本次修改 |
| --- | --- | --- |
| 登录方式策略绕过 | Personal / desktop-local 仅允许 PassPort 时仍可通过 PassKey 登录 | 注册和登录的 options/verify 均检查实例允许的认证方式；仅允许本地密码认证的实例开放新绑定和登录 |
| 本地 TOTP 绕过 | PassKey 验证后直接写入 `session.user`，不检查用户 2FA；WebAuthn 也不要求设备端用户验证 | 注册及登录要求 WebAuthn User Verification；启用 2FA 时只写短期 `pendingTwoFactor`，通过既有 `/auth/login/2fa` 后才建立登录态，登录页接入同一 TOTP 表单 |
| 会话固定及保存失败 | 登录没有重新生成 session；保存失败可能被响应结束时的隐式保存再次写入 | 登录前重建 session；显式保存异常时移除请求会话、清空认证/待验证状态并销毁该 session；覆盖同步抛错及“已写入后报错” |
| PassKey 丢失更新与撤销失效 | 注册、删除和计数器更新读写整个 JSONB 数组；陈旧登录写入可恢复已经删除的密钥 | 三条写路径复用事务及 `SELECT ... FOR UPDATE`；登录在获得锁后读取最新凭证并验证，计数器更新不覆盖其他写入 |
| 跨用户重复凭证 | JSONB 没有全局 credentialID 唯一约束，查找用 `LIMIT 1` 任意选人 | 注册按 credentialID 获取事务 advisory lock 后全局查重；登录用 `LIMIT 2` 检查歧义并拒绝。直接 SQL 仍可绕过应用锁，审计器另行聚合检测 |
| 挑战重用及跨会话使用 | 全局 Map 以公开 challenge 或用户 ID 定位，验证成功后才删除 | 为浏览器会话生成随机 owner 并保存到服务端 session；注册同时绑定 user ID；在第一次异步验证前一次性取出 challenge，取消无会话兼容回退 |
| 挑战内存不受限 | 公开 options 可无限写入 Map，过期值仅在被访问时删除 | challenge 上限 10,000，5 分钟 TTL、定期清理；路由每来源 IP 最多 60 次/5 分钟，限流 Map 同样有上限及清理。均为单进程限制 |
| PassKey 审计缺口 | 注册、删除和成功登录未调用结构化审计日志 | 新增注册、删除、登录及 PassKey+TOTP 登录日志；凭证仅记录 SHA-256 指纹，正确记录管理员属性；错误响应隐藏内部异常 |
| OAuth 与 Key 策略不一致 | OAuth 自行拼装身份，遗漏 Team 额度预检、用户 RPM/TPM、吞图、命令、Fusion 与签名设置，也未核对 token 用户与 Key 所有人一致 | 验证 access token 及 scope 后按 Key ID **和**用户 ID 进入普通 Key 鉴权流程；每次重新读取，执行同一生命周期/额度/授权检查并填充相同设置；OAuth token 不进入原始 Key 缓存 |
| 凭据过期边界 | OAuth token 以及普通 Key 冷加载对无效日期和恰好过期时刻的处理不足 | 非有效日期或 `expires_at <= now` 均拒绝 |

实例策略取自现有 `metadata()`：Team 即使选择 `auth_mode=passport`，仍允许 `password`，不能把该配置误称为“只允许 PassPort”。真正只允许 PassPort 的是 Personal 或 desktop-local。本次没有改变该产品策略。

## 进一步核实后未成立的越权假设

OAuth 中间件原来没有调用模型授权刷新，但三种主要网关 handler 在入口已经调用 `refreshApiUserForRequest()`，普通调用也按用户查模型。因此不能仅依据中间件缺字段认定 OAuth 可以任意调用未授权模型。本次复用 Key 鉴权仍消除了策略重复实现，确认修复的绕过点是额度预检和用户限流等缺失设置。

`api.js` 的 Fusion panel/judge/outer 三处无 userId 的 `getModelConfig()` 位于**已完成调用后的成本计算**。真正调用发生在 `fusion/index.js`，已按 `requestUserId` 检查模型访问，传给流式 synthesizer 的也是绑定该用户的查询函数。没有把计费查询误报成可越权执行的调用点，也没有改变这三处成本查询。

## 生产只读证据

证据目录：`/root/crewrouter-audit-evidence/20261025T084352Z-passkey-oauth/`（目录 0700，文件 0600）。`audit.json` SHA-256：

`7b48a717d692802be09163aca5cc71498648bf8a8570621e228cc6513d0975cf`

`execution.json` 记录实际命令、起止时间、基线提交及审计源码哈希，`runtime.json` 保存服务与 guard 状态，`SHA256SUMS` 覆盖文件。审计在 transient systemd 单元执行：只读文件系统、禁止提权、清空 capabilities，仅允许连接 `100.64.0.2/32`，并限制 CPU、内存、任务和运行时长；stdout/stderr 通过管道捕获后保存为私有文件。审计脚本使用 `REPEATABLE READ READ ONLY` 并最终 `ROLLBACK`。没有运行应用启动、数据库迁移、撤销或业务写入。

| 新增统计 | 结果 |
| --- | ---: |
| 持有 PassKey 的用户 / 管理员 | 2 / 2 |
| 启用本地 2FA 的管理员 | 1 |
| `temp_totp_secret` 非空用户 | 0 |
| 重复 credentialID 组 / 非规范 PassKey 存储用户 | 0 / 0 |
| OAuth token / 授权码 / 邀请总数 | 0 / 0 / 0 |
| 活动 access / refresh / code / invite | 0 / 0 / 0 / 0 |
| 新增孤儿或跨所有人关联 | 全部 0 |

只输出上述计数，未输出 credentialID、公钥、TOTP secret、token、code 或邀请秘密。非规范形状检查不是 WebAuthn 公钥密码学有效性证明。证据仍在失陷主机本地，哈希仅识别文件，应异机保全；不能把这些统计当作历史完整性或主机清洁证明。

## 验证与兼容性

- `node --test server/scripts/test-passkey-security.js server/scripts/test-auth-session-failure.js`：32 项，包含 PassKey 到真实 TOTP handler 的完整交接、cookie 轮换和保存故障。
- `node --test server/scripts/test-oauth-bearer-policy.js`：13 项，覆盖 Key 所有人、禁用/过期、scope、额度、策略字段和禁用 OAuth 缓存。
- `node --test server/scripts/test-security-audit.js`：34 项，覆盖新增统计、缺失结果、缺表/视图/RLS 和失败关闭。
- `node server/scripts/test-api-key-lifecycle.js`：普通 Key 冷加载/缓存生命周期与三类网关拒绝行为通过。
- `node server/scripts/test-passkey-store-postgres.js`：私有 Unix socket 新建 PostgreSQL 中验证删除与登录真实行锁等待、跨用户唯一性、并发注册、事务回滚及连接释放。
- `node server/scripts/test-security-audit-postgres.js`：使用仓库 DDL 在独立私有 socket 集群验证聚合 SQL、损坏关系、凭证形状和只读事务；两个临时集群均已停止并清理。

测试没有加载真实部署配置或真实数据库模块。WebAuthn 挑战消费和路由故障测试使用替身，不证明真实设备/浏览器的端到端兼容性；上线前仍需验证支持 UV 的设备、登录页与 TOTP 交互。旧的无 User Verification 设备会被拒绝，应通过可信登录方式重新绑定支持 PIN/生物验证的设备。挑战保存在单进程内存；多进程部署需要粘性会话或共享的一次性存储，进程重启后需重新获取选项。

## 仍需后续处置

- 现存两名管理员的 PassKey 无历史注册审计可证明归属，不能因为形状正常就认定可信。可信恢复时由账号所有者核实设备，在新环境重新绑定，并从可信设备轮换管理员密码、TOTP、第三方凭据及会话签名密钥；本轮没有自动删除生产凭证。
- 注册/删除 PassKey 尚未要求额外的近期重认证；仅有被盗活动会话者仍可能添加持久凭证。应为敏感凭证管理统一设计重认证流程，而不是把本次登录修复称为全部凭证管理加固完成。
- `two-factor.js` 的启用/禁用缺结构化审计、禁用仅要求密码、启用缺尝试限额，TOTP 未记录已消费时间步；密码或 2FA 变更也未统一撤销其他长寿命会话。这些是独立后续项，本次没有扩展修改。
- 网络隔离、低权限运行、应用角色撤销 `public` CREATE、可信重建与历史数据验收仍按 [恢复清单](security-recovery-runbook-2026-10-25.md) 执行。仓库修复尚未部署，guard 没有自动恢复。

本轮原计划继续使用用户指定的 `gpt-6.1-sol` 子代理，但此前六次启动均在产出前返回 `thinking_signature_invalid`，包括重试和 medium 推理设置。随后由根代理直接完成本项，没有改用 Astra，也没有把失败子代理计为独立复核。
