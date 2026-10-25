# PassPort、Desktop 与 Demo 商店安全复审

日期：2026-10-25。接续 [认证审计](security-auth-review-2026-10-25.md)；本记录描述上一轮提交 `b0f63ac9` 之后的工作树修复。源码和隔离回归确认的问题不等于事件期间已被利用，也不等于修复已上线。本轮未调用真实 PassPort 授权码或密钥，未对业务数据库写入。

## 共享应用凭据与缺配置行为

旧配置加载器和示例包含共享 PassPort 应用凭据，空配置还会回填该默认值；因此“原始配置未填 PassPort”不能证明该路径不可用。现已移除内置值及空值补回，按历史泄露 Secret 的 SHA-256 指纹拒绝旧值，避免复制旧配置重新启用已公开凭据。主登录和 Demo 商店的入口、交换阶段均检查有效配置。报告不记录旧 Secret；代码拒绝旧值不能代替提供方撤销，旧凭据尚未在上游撤销。

`/auth/status` 的新增配置状态字段仅公开 `passportConfigured` 布尔值和固定错误码，不返回凭据或提供方原始错误。三个登录/初始化页面及 Desktop Local 登录窗口提示缺少配置；未增加匿名登录或免登录回退。

Desktop 使用专用 PassPort 环境变量；整组来源优先级为 `opts.config.passport`、`opts.env`、`process.env`，不把不同来源的 App ID 与 Secret 混配。通用 `CR_*` 环境变量仍受原过滤规则约束。runtime 配置写入改为私有 `0700` 目录，使用 `wx` 创建 `0600` 临时文件再原子 rename，避免旧配置先以 `0644` 暴露的窗口及沿旧目标符号链接写入。配置目录仍应仅由当前系统用户控制；这不能抵御失陷主机的 root。

## Demo 商店身份 cookie

旧默认签名密钥允许知晓默认值者自行签发包含 `admin=true` 的身份 cookie，已在内存隔离样例中复现。该路由仅在 `demo=true` 时挂载；最近生产配置快照为 `demo=false`，不能将此问题认定为生产入侵入口。

新逻辑拒绝默认模板密钥，要求 Secret 为 32–4096 个 UTF-8 字节，并校验规范字符串；长度校验不是随机性证明，部署时须生成独立随机密钥。签名载荷及解析增加字符串长度/规范 UTF-8 校验、严格布尔 `admin`、大小上限、整数 `iat`、七天有效期及最多 60 秒未来时钟偏差。重复同名 cookie 一律拒绝，避免解析器对重复值的选择差异。

身份 cookie 保留原名称 `bl_store_session`；此前已加固的登录关联 state cookie 与它不是同一 cookie。身份 cookie 本轮未迁移至 `__Host-`，也没有单会话撤销能力。部署时须轮换商店签名密钥并使旧 cookie 失效；缩短有效期与严格解析不能撤销已经泄露的签名能力。

## 提供方请求和响应

新增共享 `passport-verifier`，用于 Core 与商店交换。请求限定 HTTPS、固定 DNS 解析结果并禁止重定向；总计十秒覆盖 DNS、请求和响应流读取，响应最多 64 KiB，严格检查 UTF-8、JSON 和身份字段。对外只返回固定安全错误，不记录响应 body、payload 或带 Secret 的 URL。

Core 保留既有 POST 交换及必须返回 `apptoken` 的要求；商店保留 GET 交换且不要求 `apptoken`。严格校验可能拒绝原先被容忍的非规范响应，须在新环境用专属测试应用验证。GET 查询中的密钥仍可能进入提供方及其反向代理日志；HTTPS 保护传输链路，不消除端点日志泄露风险。

历史契约来源为提交 `0b55da0191ee0b1c8b6a81fec28e030787b41621` 的 `docs/OauthAPI.md`，其中只记载 GET、一次性 code、可选 `apptoken` 和布尔 `admin`。Core POST 自 `bf08bfcf`（2026-08-28）已存在，本轮没有改为新协议。未找到新版线上契约，也没有找到提供方保证回传 state 或保留回调 query 的说明；不得将历史文档或本地 mock 通过表述为线上兼容性已验证。服务端把 state 放入回调 URI 的做法仍依赖提供方保留该参数，跨实例授权码重放防护仍依赖提供方的一次性 code 实现。

## 验证与现场边界

本轮相关 `node:test` 回归共 **54 项通过**，命令如下：

| 范围 | 命令 | 通过数 |
| --- | --- | --- |
| Store 会话与配置 | `node --test server/scripts/test-store-session-security.js` | 20 |
| PassPort 凭据与加载器 | `node --test server/scripts/test-passport-credentials.js` | 6 |
| Desktop 配置与子进程 | `node --test CrewRouter-Desktop/test/server-manager.test.js` | 13 |
| 认证配置状态 | `node --test server/scripts/test-auth-status-security.js` | 5 |
| Desktop 本地授权 | `node --test CrewRouter-Desktop/test/local-passport.test.js` | 10 |

以下独立脚本亦已通过，不计入上述 54 项：

- `node server/scripts/test-passport-verifier-security.js`
- `node server/scripts/test-passport-login-security.js`
- `node server/scripts/test-local-passport.js`
- `node server/scripts/test-passport-store-security.js`

20 个修改/新增 JavaScript 文件均通过 `node --check`，三个修改 HTML 的内联脚本语法解析和 `git diff --check` 通过；当前受 Git 跟踪的文件中未再检出原共享 Secret 字面量。此前的提交历史和旧发布包仍可能含有该已公开凭据。这些验证使用内存数据、依赖替身及本地网络，没有证明提供方线上兼容或执行上游凭据撤销。

14:52:10 CST 的运行态复查仍为旧 root 进程 PID 1407，自 10-24 12:36 启动；guard unit 为 `not-found`，实时 nft 无 incident guard。先前 root SSH 停用记录已保全，用户尚未确认是否人工操作；本轮未修改防火墙，也未据此重新归因。最近数据库证据仍是 13:57、13:59 和 14:17 的只读快照，本轮未重新核验数据。

本轮未重启或部署，不能视为旧进程已加载上述修复。仍需按 [恢复运行手册](security-recovery-runbook-2026-10-25.md) 从可信来源重建、异机保全证据、撤销并轮换上游凭据、核验恢复来源及完成外部账目对账；源码修复和当前数据库不变量检查均不能证明主机清洁或历史数据完整。
