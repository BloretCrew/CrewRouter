# CrewRouter 认证、身份绑定与审计器复核

日期：2026-10-25。此记录接续 [入侵与恢复审计](security-incident-2026-10-25.md)。以下新发现来自当前源码、隔离的离线回归和受限只读数据库查询；没有据此认定这些路径在事件期间已被攻击者利用。

## 当前配置与身份数据

16:43:52 CST 后续检查补充了 PassKey 的 TOTP 绕过、挑战/会话与 JSONB 竞态修复，以及 OAuth 与普通 Key 策略统一。当前两名管理员均有 PassKey，一名启用本地 2FA；现存密钥归属仍未验证，旧进程未加载补丁。详见 [PassKey 与 OAuth 专项复核](security-passkey-oauth-review-2026-10-25.md)。以下配置及历史证据的时间边界不变。

**提交前运行态覆盖更新（14:27:10 CST）：早前记录的 incident guard 已不再是当前有效防护。** `crewrouter.service` 仍为 root/PID 1407，启动时间为 10-24 12:36；`cr-incident-guard.service` 在 14:25:56 复核时已 `not-found`，实时 nft 中也没有 `cr_incident_guard`。两族 INPUT 策略为 ACCEPT，上游边界尚未核实，因此不能据本机状态直接断言公网可达。

13:57:08 CST 重新运行修正后的 `security-audit.js`：`readOnly=true`、`complete=true`，退出码为 `1`，原因仍仅为 `crewrouter` 具有 `public` schema CREATE 权限。余额/退款、团队、兑换码、API Key 关联、41 个序列、索引与约束检查未报告异常。GitHub、飞书、PassPort 身份重复和空绑定计数均为零。未启用 RLS，两个业务触发器的表、函数、属性与函数体均符合当前仓库预期；源码匹配不是独立的可信基线。

13:59:35 CST 的认证补查确认 `settings`、`instance_settings`、`users` 都是普通表、没有 RLS/forceRLS、所需列类型符合预期。只读事务使用 `REPEATABLE READ` 并以 `ROLLBACK` 结束：

| 项目 | 当前快照 |
| --- | --- |
| 版本 / 认证模式 | `team` / `feishu`，已有初始化完成标记 |
| 飞书设置来源 | `settings` 无覆盖行；本机配置包含 App ID、Secret 和 tenantKey |
| 用户数 / 飞书绑定数 | 13 / 12 |
| GitHub / PassPort 绑定数 | 0 / 0 |
| 启用本地 2FA 的用户 | 2 |
| 管理员 ID 1 | 已绑定飞书，已启用 2FA |
| 管理员 ID 3 | 已绑定飞书，未启用 2FA |

本机配置没有 GitHub 凭据，运行进程环境中也没有 GitHub 覆盖项。原始配置中没有 PassPort 凭据，但 `config-loader.js` 存在内置 PassPort 默认值；因此不能把原始配置字段为空解释为该代码路径不可用。新回调会重新检查实例认证模式。

14:17:54 CST 另行补查此前会话/API Key 审计未覆盖的 OAuth 凭据表：`oauth_auth_codes`、`oauth_tokens` 均存在，为普通表，无 RLS/forceRLS 或继承，所用列为预期内置类型且不是生成列。两表各 **0 行**；未用且未过期的 code、未撤销且未过期的 access/refresh、access/refresh/其他 kind 总量均为 0。用户/API Key 孤儿关联、API Key 所有人不符、`rotated_from` 的悬空父、自环、跨用户及跨客户端边计数也均为 0。

该补查在受限 transient unit 中执行：仅允许访问数据库地址，文件系统只读且仅报告目录可写，设置内存、任务和运行时间上限。事务确认 `READ ONLY`、`REPEATABLE READ`、`search_path=pg_catalog`、`row_security=off`，每条 SQL 超时 10 秒、锁等待 1 秒；持有 `ACCESS SHARE` 锁后重新核对表形状，只对 `ONLY` 表做聚合查询，最终 `ROLLBACK`，报告 `complete=true`。没有读取 code/token_hash 的值、个人资料或执行撤销与业务写操作。两表当前为空，不能证明事件期 OAuth 记录完整或其他外部会话均已撤销。

基础与认证报告原存于 `/run/crewrouter-readonly-20261025T055618Z/`，OAuth 报告原存于 `/run/crewrouter-oauth-readonly-20261025T061209Z/`；三份报告均已另存到 `/root/crewrouter-audit-evidence/20261025T055618Z-auth/`，目录 `0700`、文件 `0600`，没有放入 Git：

| 报告 | SHA-256 |
| --- | --- |
| `security-audit.json` | `f19f389a90196537195ad0da3fca8b776a6a9e7e22d37009c435a627952cd772` |
| `auth-snapshot.json` | `f8ba234466b8fbb14de7b0271bfb8224a2321f4dd2e52b46c68717e887974cdb` |
| `oauth-audit.json` | `1e21a83184b42a83668d0d8a8989c6b53ce97d0975f198fce9306c2b2ecdfd79` |

报告及哈希目前仍保存在失陷主机本地。它们描述活库当时返回的状态，无法证明历史完整性或抵御 root 修改，仍需异机保全。

提交前另行保全了防护状态差异：journal 记录 13:59:28 开始停止 guard，13:59:29 停止成功；14:27:10 实时 nft 仅剩 `ip`/`ip6` 的 filter/nat 表，原 incident guard 表不存在。systemd 单元文件已消失，`/etc/nftables/cr-incident-guard.nft` 仍存在（修改时间 13:53:36），其中新增注释声称 `.2` 已经人工复核并恢复完整访问，同时出现该节点的 IPv4/IPv6 accept 配置；文件注释不能证明节点可信、操作身份或规则已加载。已向用户核实是否人工停用，尚未获得回答。本轮只读保全现状，没有修改或自动恢复防火墙；身份与原因未明，不能据此判定发生二次入侵。

证据保存在 `/root/crewrouter-audit-evidence/20261025T062710Z-guard-state/`，目录 `0700`、文件 `0600`，附 `SHA256SUMS`：

| 防护证据 | SHA-256 |
| --- | --- |
| `nft-ruleset.json` | `5da878f13b5d138c67b25884b6b2bb0661f82006d6c47b8857595b937b085fdf` |
| `guard-journal.txt` | `87cd436ddfaaf71af62effe21ac317f1261a9fee818bea70fcd431982843158a` |
| `guard-config.nft` | `0d26f4e543501b2fe02bd387a867c1d4ff38715fc7c6fa7846a20388c4168a3a` |

补充审计事件显示：13:59:27.867 有 root SSH 登录形成会话 `946`；13:59:28.304 该会话以 `auid=0`、`uid=0` 执行 `systemctl disable --now` 停用 guard，13:59:29.007 systemd 子进程成功注销 nft guard 表，13:59:29.013 服务停止成功。13:59:30.037 同一会话通过 `mv` 的 `renameat2` 成功把单元移到 `/root/disabled-services-backup/cr-incident-guard.service`，随后归档规则并重新加载 systemd 配置。13:53:36 的另一 root SSH 会话曾运行 `nft -c -f`，这条命令只证明语法检查。两次 SSH 会话来源相同，但不能由此确认现实操作者或授权意图。

相关 60 个完整事件保全于 `/root/crewrouter-audit-evidence/guard-attribution-20261025T062938Z/targeted-events.log`，目录 `0700`、文件 `0600`，SHA-256 为 `23f5533a7aa593b9d09cdccc20e7251cd7f934c76e6ee930dda603c18124c751`。它补足了单元从原路径消失的操作记录，仍不能证明这是获授权的人工调整或二次入侵；用户尚未回复，本轮未修改防火墙。这些证据同样只保存在失陷主机本地，后续需异机留存。


## 已确认的代码问题及修复

### 密码与 2FA 会话保存失败后仍可能留下登录状态

旧密码登录、待 2FA 状态保存和 2FA 完成路径，在显式 `session.save` 失败后仍保留请求中的 `user` 或 `pendingTwoFactor`。真实 `express-session` 在错误响应结束时可能再次自动保存，把页面已报告失败的登录或待验证状态写入会话存储。触发前提是先验证正确密码，完成 2FA 时还须有正确 TOTP；这项发现不构成无凭据登录绕过证据。

修复会先断开请求的 session 引用，清除认证与待验证字段，并尝试销毁失败 session，防止响应结束再次隐式写入。15 项真实 `express-session` 故障注入回归覆盖回调报错、同步抛错、先落库再报错、密码登录、待 2FA 与 2FA 完成，以及 HTML 失败重定向和正常登录；确认失败不签发新登录 cookie、不留下可重用认证状态、不产生登录成功审计，正常登录及会话轮换仍可用。测试的会话存储是隔离替身，未对生产会话库注入故障。

### 飞书绑定绕过本地 2FA、覆盖已有身份

旧 `server/routes/feishu.js` 在邮箱匹配时直接写入飞书身份并登录；用户名匹配的绑定流程只校验密码，没有检查用户已启用的 TOTP、待绑定状态有效期或失败次数，而且可以覆盖原有飞书绑定。对于配置了企业隔离的实例，同名路径的攻击前提包括通过当前飞书应用/租户验证及知道目标本地密码；不能据源码假定任意公网账号都能利用。

现有邮箱/用户名匹配统一进入凭据验证页，要求密码及目标账号已启用的 TOTP；已有不同飞书身份时拒绝覆盖。状态五分钟到期，同一 IP/账号十五分钟最多五次验证，重新发起待绑定状态也不会重置进程内计数。回调和待绑定状态同时关联应用、密钥和租户的配置摘要，配置切换后必须重新授权。数据库更新附带密码、2FA 配置和已有绑定的条件，防止验证后的并发变化被覆盖；会话使用 `RETURNING` 得到的最新账号数据。绑定先记录审计，再轮换会话；最终会话写入失败时销毁认证状态。

飞书回调也增加有效期、配置与当前登录方式检查，成功登录轮换 session。该修复保护新增身份绑定；已有、明确绑定的飞书身份仍作为独立登录凭据。不能把“新增绑定验证 TOTP”表述成所有外部身份登录都已统一强制本地 TOTP。

### 认证与 OAuth 写接口被整段排除于 CSRF 防护

旧 `server/middleware/csrf.js` 豁免全部 `/auth/`、`/oauth/` 路径，包括设置密码、绑定身份、批准 OAuth 授权和撤销授权。`SameSite=Lax` 对跨站请求有帮助，但不阻止同站恶意子域向另一来源发起带 cookie 的请求；它也不能替代登录流程的状态绑定。

现在仅保留不依赖浏览器会话的精确 token/revoke 交换端点。浏览器写操作必须通过同源或 CSRF token 校验；认证路径和采用独立身份 cookie 的 `/store` 不因伪造 Bearer/API Key 头而跳过校验。请求来源使用 Express 根据代理信任规则得到的 `req.protocol`，不再直接相信任意 `X-Forwarded-Proto`。

Desktop 的一次性 code/PKCE 会话交换只对没有任何浏览器来源头的原生 JSON 请求豁免；客户端已同步改为 JSON。**旧 Desktop 若仍发送表单编码，须随服务端一起更新**。CLI `/oauth/token` 的表单交换保持兼容。

### OAuth 轮换链撤销遗漏、异常环与并发边界

旧撤销逻辑向上寻找根节点时最多遍历 64 次；构造 67 代轮换链时，根代的 access token 会被遗漏，接口仍可能报告撤销成功。旧递归也没有完整限定用户/客户端边界，异常环和被篡改的父子关联会影响终止性与撤销范围。当前活库 OAuth 两表为空，这些是代码和隔离样例确认的问题，未据此认定生产出现过遗漏撤销。

新逻辑使用递归 `UNION` 去重，在同一 `user_id`、`client_id` 范围内先取祖先，再遍历相关后代；环会收敛，悬空父节点只处理已知关联部分，其他授权组件保持独立。祖先与关联组件两个阶段各设 10,000 行上限，每条 SQL 最长 5 秒；超限或数据库失败会回滚，并由撤销/刷新接口返回 `503 temporarily_unavailable`，不会把部分处理报告成成功。未知 token 的 RFC 7009 撤销请求仍返回 200。

初次成对签发、刷新轮换与链撤销共用用户/客户端事务锁，使撤销在先前轮换提交后再取得数据快照，随后轮换能看到已撤销的父 token。初次 refresh/access 成对签发也改为事务，后半部分插入失败会一起回滚。刷新重用触发撤销时复用已占用的连接，避免单连接池等待自身释放连接而死锁。

`test-oauth-revocation-security.js` 已在自行创建的临时 PostgreSQL 上通过，运行约 5.90 秒、退出码 0。测试禁用 TCP，仅使用私有 Unix socket，不读取应用配置或生产连接环境；覆盖 67 代链及根 access、环、悬空父、用户/客户端边界、两个阈值的完整回滚、初次签发原子性、刷新与撤销并发、单连接池以及真实 PostgreSQL 超时。结束时确认服务停止、PID 文件消失并删除生成的测试目录。

### PassPort 回调缺少状态绑定与认证策略检查

旧服务端回调在 state 或会话 state 缺失时仍接受 code，且只在登录入口检查认证模式。它还按“没有管理员”决定初始管理员身份，可能在已初始化但管理员记录缺失的数据库中重新创建管理员。

现在要求本会话签发的五分钟随机 state，绑定会话 ID、回调 origin 与应用；state 同时写入回调 URI，但其有效性依赖提供方保留回调 query；未找到线上契约保证，尚未验证真实提供方兼容性。消费后先保存会话，再交换 code；重新检查模式、配置，并在数据库事务内与初始化共用锁。首管理员只允许在未初始化且用户表为空时创建。登录轮换会话，保存失败销毁新认证状态。任意跨源 `redirect_origin` 与畸形/超长外部身份被拒绝。

状态保存在共享 session 中，可跨实例使用；进程内已消费缓存补充拒绝同进程并发副本。它不是跨实例原子消费，跨进程的重复 code 仍须由身份提供方的一次性授权码机制拒绝，当前离线测试没有验证外部服务的实现。

### 不受支持的 GitHub 旧入口仍可绕过认证模式

旧 `/auth/github-legacy/*` 代码未验证回调 state，并会按邮箱静默绑定本地账号。当前各版本的认证方法列表均不包含 GitHub，页面也没有该入口；本实例无配置凭据和数据库绑定。该遗留路由现统一返回 `410 auth_method_disabled`，不再加载数据库或执行外部交换。没有证据将其认定为本次入侵入口；依赖旧私有部署入口的使用方需迁移到受支持的登录方式。

### Demo 商店登录 CSRF 与返回地址校验

`server/routes/store.js` 仅在 `demo=true` 时挂载，本生产实例不走此路径。旧 state 只是可自行构造的返回路径 Base64，未绑定浏览器；旧路径检查还接受反斜杠形式的跨源跳转。离线 Express 响应与 URL 解析已确认旧返回地址能够改变来源。

现在使用短时随机 state 和独立签名 HttpOnly 关联 cookie，HTTPS 使用 `__Host-` 名称；跨实例可验签，同进程拒绝重复消费。返回路径在规范化前后均检查，拒绝反斜杠、控制字符、协议相对路径及点段规范化产生的双斜杠。商店身份仍独立于 Core session；多进程单次性同样依赖外部授权码契约。

### 头像写入与审计器准确性

上一轮头像改动之外，进一步确认旧上传流程没有清理 Formidable 成功后的临时文件，且数据库更新失败仍返回成功。新专用上传处理器使用私有临时目录并统一清理，限制整个 multipart 为 5 MiB + 16 KiB，接收限时 30 秒、DNS 与出站合计限时 10 秒，处理客户端断开和截断响应。只有数据库确认更新一行后才更新 session 并报告成功。图床成功、数据库失败仍可能留下远端孤儿图片；接口会报告失败。

审计器 RLS 检查此前把 SQL 的 `rowSecurityEnabled` 字段误读成 `relrowsecurity`，可能漏报。现在修正字段并核对结果类型，缺少关键字段会标为不完整并退出 `2`。同时补充外部身份唯一性和更严格的触发器检查；同名但错表、错函数或函数体变化的触发器会报告异常。当前活库已用修复后的脚本重新核验，不能仅引用此前有该缺陷的前置检查作为证明。

## 验证与部署边界

认证、上传、审计器与 Desktop 编码的回归使用隔离会话、内存数据或依赖替身，HTTP 测试只绑定 loopback，不调用真实身份提供方或图床。OAuth 撤销另用上述私有 socket 临时 PostgreSQL，数据与 schema 写入仅发生在该新建测试集群。只读活库审计验证的是数据库查询及当前状态，不执行登录、绑定或撤销写操作。

本轮以下 `node:test` 命令合计 **128 项通过**：

| 范围 | 命令 | 通过数 |
| --- | --- | --- |
| 头像上传与失败处理 | `node --test server/scripts/test-avatar-upload.js` | 37 |
| CSRF、GitHub legacy 与客户端边界 | `node --test server/scripts/test-csrf-boundaries.js` | 17 |
| 审计结果与退出码准确性 | `node --test server/scripts/test-security-audit.js` | 31 |
| Desktop 官方登录交换 | `node --test CrewRouter-Desktop/test/official-login.test.js` | 6 |
| 飞书绑定与会话失败 | `node --test server/scripts/test-feishu-binding-security.js` | 22 |
| 密码/2FA 会话保存故障 | `node --test server/scripts/test-auth-session-failure.js` | 15 |

以下独立脚本也均通过，未计入上述 128 项：

- `node server/scripts/test-passport-login-security.js`
- `node server/scripts/test-local-passport.js`
- `node server/scripts/test-passport-store-security.js`
- `node server/scripts/test-email-toctou-static.js`
- `node server/scripts/test-batch-e-permissions.js`
- `node server/scripts/test-oauth-revocation-security.js`（临时 PostgreSQL 验证，包含清理断言）

本轮 25 个修改/新增 JavaScript 文件均通过 `node --check`，`git diff --check` 通过。

首次运行旧 `test-local-passport.js` 时，尚未替换的 logger 生成了合成测试日志 `log/BSTUDIO-2026-10-25-13-56-43.log`（2,696 字节，SHA-256 `a2f318fc2c078d31d791edbeb3ced2358264edba5fcec3bf55bfb8512dcd3fe6`）。已将该测试的 logger 替换为离线替身，后续测试不再写真实业务日志。该文件保留且权限为 `0600`，不是事件期攻击证据。

本轮没有部署或重启服务，现有 root 进程 PID 1407 仍自 10-24 运行。修复应纳入可信重建制品，并配套更新 Desktop。后续共享 PassPort 默认凭据移除、Desktop 配置传递、提供方请求边界及 Demo 商店签名加固见 [PassPort 专项复审](security-passport-review-2026-10-25.md)。外部身份提供方的授权码/撤销契约、分布式验证限速及跨实例状态消费仍需继续检查；此外还须完成既有恢复清单中的主机重建、凭据轮换、可信备份和外部账目核验。

## 后续工作树复审

上一节 128 项及 25 文件语法检查属于上一轮提交 `b0f63ac9` 的验证记录。其后的 PassPort / Desktop / 商店修复与新增回归单独记于 [专项记录](security-passport-review-2026-10-25.md)，不应将前述计数当作本轮完整总数。约 14:36 CST 复查仍是旧 root/PID 1407、guard unit 不存在且 nft 无 guard；没有部署修复，也没有再次查询业务数据库。
