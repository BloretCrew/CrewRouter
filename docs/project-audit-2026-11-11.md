# CrewRouter 全项目风险审查报告

## 审查约束、基线与结论

- 仓库：`/data/CrewRouter`，检查时 HEAD 为 `faee7a6f`。主代理正在并行修改签名及默认开关，以下行号以本次读取工作树为准。
- 本审查不修改源码、不提交；只在 `/tmp` 输出报告和隔离验证材料。不读取真实 config.json、.env 或密钥，不连接真实数据库、不写生产数据。
- 先执行 `git ls-files` 确认边界。已跟踪目录中 server 406 项、public 992 项、桌面 194 项、SDK 41 项、CLI 36 项、plugins 32 项；audit 3387 项主要是审计材料，不作为业务入口。跳过 node_modules、vendor、第三方镜像、归档和未跟踪第三方仓库。
- 本次是跨模块、风险导向审查，不是逐行穷尽或证明项目无漏洞。确认 **8 项产品问题和 1 项测试缺陷**（其中 R8 已在本轮修复）；优先处理 XSS、发布构建、凭据转发及插件身份刷新。

## 覆盖范围

| 范围 | 已追踪的主要代码与边界 |
|---|---|
| 认证、授权 | server/index.js 挂载；middleware/auth、request-auth、api-key-permissions、oauth-bearer、csrf；auth、setup、OAuth code/refresh/revoke；用户/API Key/Team/会话归属 |
| API 代理、SSRF | routes/api、agent、user 供应商调用；url-validator、quota-request-context、proxy-pool、before-upstream-policy；DNS 固定、手动拒绝重定向 |
| 配额计费、事务 | points-deduct、balance、agent-billing；API Key 校验、退款余额、会话写事务、Agent 图片归属与结算 |
| 上传及文件 | avatar-upload、agent-images、conversations；插件下载限制、ZIP 解包、插件静态目录 |
| 前端 | app.js 设置保存和 Key 选项、console.html、playground Markdown、dom 工具、store.js 与额度报表的字符串汇点 |
| 插件 | routes/plugins、plugins/host/registry/zip/store-client，自有示例插件和 webhook；后端插件信任开关与路由身份策略 |
| SDK/CLI | Go/Python HTTP、重试与流接口；CLI HTTP、认证与配置相关入口。CLI 不自动跟随重定向；本次确认的重定向泄漏特指 Go x-api-key 模式 |
| 桌面 | app/window、ipc、preload、client-config，自有导航白名单、主帧身份和写配置确认；不审第三方 vendor 资源 |
| 部署 | 两份 compose、两个 Dockerfile、deploy/build/bundle 和 build-release；单文件产物与动态路由/语言资源 |

## 按严重程度排序的问题

### R1 — 高：模型回复中的 Markdown 链接可注入事件属性，形成同源 XSS

- **文件:行号**：`public/js/playground.js:843-848,894-895`；插入位置 `:795-803,953-955`；`public/js/dom.js:91-95`。
- **问题**：初始转义只处理 `&<>`，链接正则把攻击者控制的 URL 原样放进双引号 href。`setHTML` 是 innerHTML 封装，不是净化器。模型返回内容和已保存对话重新渲染都经过此路径。
- **隔离复现**：在 Node VM 仅载入 playground.js 并禁止 DOMContentLoaded 回调，调用 `PlaygroundApp.prototype.renderMarkdown`。输入 `[link](https://example.org/" onmouseover="document.title='review')`，实际输出包含 `<a href="https://example.org/" onmouseover="document.title='review'" ...>`。鼠标经过链接即执行事件；无需真实模型或服务。
- **跨模块影响**：脚本在已登录 Playground 的 origin 执行，可读取页面和发起同源请求。没有证据表明会自动提升为管理员；权限取决于受害者身份。未运行真实浏览器事件，仅已验证危险 HTML 输出和无净化插入链。
- **建议**：使用成熟 Markdown 解析器并对最终 HTML 进行允许列表净化；URL 只允许规定协议，属性使用 DOM API 或正确属性转义；补充双引号、javascript URL、编码协议和历史会话渲染测试。
- **状态**：已确认，未修复；并行设置 diff 不涉及该问题。

### R2 — 高：单文件发布产物无法解析运行时动态路由，非 demo 部署启动失败

- **文件:行号**：`server/index.js:2873-2888`，尤其 `:2886`；`server/routes/mounts.js` 的 setup 首项；`deploy/build/bundle.js:43-59`；`deploy/build/build-release.js:84-125`。
- **问题**：路由表使用 `require(path.join(__dirname, 'routes', entry.module))`，esbuild 无法静态纳入该依赖。发布过程只交付 bundle、public、worker、可选 lang、package/config，并未复制 routes 源码。bundle 中 __dirname 是 dist，加载 setup 等路由会寻找不存在的 dist/routes/setup。
- **隔离证据**：使用与 bundle.js 相同的入口和 bundle/platform/packages 设置，`write:false`、`metafile:true`，未执行应用。输出确认 `dynamic route require retained: true`、`setup router bundled: false`。
- **影响**：普通非 demo 发布/Docker 入口在挂载路由阶段即可能抛 MODULE_NOT_FOUND；源码直接 node server/index.js 不受此路径缺失影响。未实际构建 Docker 或启动真实应用。
- **建议**：为路由模块建立静态 require 映射供 bundler 收集，或明确复制保持路径的完整运行时模块；为 release/saas 增加无真实配置的产物启动冒烟测试。
- **状态**：已确认，未修复。

### R3 — 高：Go SDK 的 x-api-key 在跨 origin 重定向时被转发

- **文件:行号**：`sdk/go/client.go:80-83`；`sdk/go/http.go` 的 buildHeaders 和 Request/Stream 中 HTTPClient.Do。
- **问题**：默认 `http.Client{}` 自动跟随重定向。Go 的默认敏感头规则不包含自定义 `x-api-key`，SDK 通过此头认证时会把 Key 转发给重定向目标。
- **隔离复现**：临时 Go 程序使用 SDK，BaseURL 指向本机随机端口 A，A 返回 302 到本机随机端口 B；使用合成 Key `review-synthetic-key`、AuthStyle=x-api-key。B 捕获该头，程序输出 `redirect followed=true synthetic key forwarded=true`。未联网、未读取实际凭据。
- **影响限制**：已证实不同端口 origin；跨主机也受相同自定义头复制机制影响，但本次未访问外部主机。不把此结论扩大为 Bearer 一律跨域泄漏。
- **建议**：默认拒绝跨 origin/降级重定向，或在 CheckRedirect 中显式去除所有凭据头；保留调用方提供 HTTPClient 的明确语义并测试 Request 和 Stream。
- **状态**：已确认，未修复。

### R4 — 高：插件私有 API 直接信任旧 Session，降权和删除用户后仍可访问

- **文件:行号**：`server/routes/plugins.js:416-436`；`server/middleware/request-auth.js:32-41`；对照 `server/middleware/auth.js:18-45,48-85`。
- **问题**：全局身份解析对 Session 只复制 req.session.user。插件分发检查 req.authUser.isAdmin / 是否存在，却没有执行 requireAdmin/requireAuth；普通业务路由会查询数据库刷新/校验身份。已有管理员 Session 被数据库降权后，仍能调用清单声明 auth=admin 的已加载插件处理器；用户被删除后 auth=user 路由同样只检查旧对象。
- **复现前提/代码证据**：需要有已启用插件登记对应私有路由；构造旧 Session user.isAdmin=true，数据库当前 is_admin=false，后续直接请求该插件端点而不先经过刷新身份的其他业务路由。插件分发没有数据库检查，handler 被调用。此项为确定性调用链证据，未操作真实用户或启用生产插件。
- **建议**：none 公开端点以外统一调用 requireAuth；admin 端点通过 requireAdmin，而非直接读 session 快照；补充删除用户/管理员降权后的请求测试。
- **状态**：已确认条件性授权缺陷，未修复。

### R5 — 中：配额任一超限即拒绝，与实际扣费的“全部耗尽”规则冲突

- **文件:行号**：`server/routes/api.js:1233-1238,1288-1294`；`server/utils/points-deduct.js:76-88`。
- **问题**：网关校验使用 quotaRules.some(exceeded)，而计费规定只要某一规则仍有余量就不扣积分。零积分用户一个规则超限、另一个仍有余量时，校验提前返回 429，实际仍有的免费额度无法使用。
- **复现/证据**：规则数组 `[{exceeded:true},{exceeded:false}]`、balance=0：网关 exceeded=true，但 calculatePointsToDeduct 的 some(!exceeded)=true，应扣 0。缓存/非缓存两个分支一致存在该矛盾。
- **建议**：共享配额可用性判定，依据既定“任一余量可用”契约决定是否全部超限；补充混合窗口、空规则和缓存命中测试。
- **状态**：已确认，未修复。

### R6 — 中：网关超额预检忽略可退款余额，充值后仍被当作无积分

- **文件:行号**：`server/routes/api.js:1256-1263,1288-1294`，缓存分支 `:1233-1238`；对照 `server/utils/balance.js:105-155`。
- **问题**：网关只选择和判断 users.balance，不加载 refund_balance；实际扣款支持普通余额不足时从 user_code_balances 及 refund_balance 消费。配额耗尽、普通余额 0、可退款余额正数且明细一致时，提前返回 insufficient_quota，根本到不了合法扣款路径。
- **复现/证据**：设置隔离用例用户 balance=0、refund_balance=10、所有 quotaRules.exceeded=true，校验条件立即成立；真实余额模块则接受明细相符的该可退款余额。未在真实数据库创建记录。
- **建议**：由统一余额模块计算可用总额并校验明细，避免只比较一个字段；缓存更新也应采用同一语义，增加只有可退款余额的端到端用例。
- **状态**：已确认，未修复。

### R7 — 中：畸形统计上报可以持久化破坏整个 overview

- **文件:行号**：`server/routes/stats-report.js:99-148,163-186`；demo 挂载 `server/index.js:2870-2871`。
- **问题**：写入只检查 payload 是对象且小于 64 KiB，不校验 stats 数值。overview 对所有记录直接将字段转换 bigint/numeric。一条 total="bad" 或超出 bigint 的记录就会导致聚合查询失败，后续 overview 持续 503，直到坏记录被处理。
- **复现/证据**：向隔离同等接口提交 `{"deviceId":"review","payload":{"stats":{"requests":{"total":"bad"}}}}` 可通过现有写入检查；overview 随后执行 `(payload->'stats'->'requests'->>'total')::bigint`，PostgreSQL 无法转换。未向真实接口发送该 payload。
- **权限/部署前提**：只在 demo 中央统计接收端挂载；共享上报 token 是可选的，配置后需要该 token，未配置时接口自身不验证上报来源。CSRF 并非服务端数据格式校验。
- **建议**：持久化前验证完整数值结构和界限；读取聚合对历史畸形记录容错/隔离；增加非数字、负数、溢出、数组等用例。
- **状态**：已确认，未修复。

### R8 — 低：用户级签名保存没有失效网关 Key 缓存

- **文件:行号**：`server/routes/user.js:2059-2070`；`server/routes/api.js:782-824,1210-1249,1320-1324`。
- **问题**：用户设置写数据库/会话后不调用 invalidateUserApiKeyCache。网关把继承来的 signatureEnabled/signatureTemplate 缓存 60 秒；命中时刷新模型权限但不刷新签名。Key 级签名更新已有失效逻辑，用户级没有。
- **复现/证据**：先用继承用户签名的 Key 暖缓存；PUT /api/user/settings 改签名，再立即请求，可继续得到旧签名，直到 TTL 或其他操作失效缓存。低调用/免费场景没有后续余额扣款缓存失效时尤其明显；不保证每个请求都延迟 60 秒。
- **建议**：用户签名字段成功更新后失效其所有 Key 缓存；多进程部署需共享失效或版本校验；测试保存后下一个调用的继承行为。
- **状态**：本轮已修复。用户签名或模板写入成功后调用 invalidateUserApiKeyCache；新增 test-user-signature-settings.js 验证关闭值持久化、成功失效与失败保持缓存。此失效作用于当前进程；多进程同步仍待专项完善。

### T1 — 低（测试）：会话事务回归夹具未注入新请求身份，整组测试提前失败

- **文件:行号**：`server/scripts/test-conversation-transactions.js:22-25`；对照 `server/routes/conversations.js:88-96`。
- **问题**：测试绕过 requireAuth，仅构造 req.session.user，处理器已使用 req.authUser.id。首次 create 返回 500，后续事务回滚和竞态断言根本没有运行。
- **实际验证**：离线防护下运行该脚本，create 断言 `500 !== 200`，响应 `{"error":"创建对话失败"}`；读代码可定位缺少 authUser。临时 PostgreSQL 已由夹具清理。
- **建议**：更新夹具身份结构，或执行真实中间件链后调用处理器；不要把此失败解读为生产会话接口一定不可用。
- **状态**：已确认测试缺陷，未修复。

## 并行设置修复 diff 评估

- 主代理把保存签名按钮移到 signatureTemplateGroup 之外，符合“关闭开关后仍可保存”的 UI 调用链；捕获提交时 enabled/template，且检查 res.ok，避免成功回包覆盖为稍后编辑的未提交值。
- 已看到 quota_warning_enabled、crewrouter_commands 和 inject_prompts.enabled 的新建默认值/前后端 fallback 改为显式 true 才开启；原先启动时强制给所有 Key 开启额度预警的迁移被移除。
- 现有用户显式 true 不会被 SET DEFAULT FALSE 清掉，这是保留用户选择的行为；不能等同为所有历史选项已关闭。是否要求迁移历史值应由主代理确认产品需求。
- 未完整运行主代理正在新增的设置浏览器测试，也未验证真实 PostgreSQL 升级；本报告不代替其最终测试结论。R8 的当前进程缓存滞后随后已由主代理补齐并通过隔离测试。

## 实际运行的隔离验证

1. `node --require ./server/scripts/test-support/offline-security-preload.js --test server/scripts/test-auth-guards.js server/scripts/test-oauth-bearer-policy.js server/scripts/test-oauth-clients.js server/scripts/test-api-key-permissions.js server/scripts/test-conversation-transactions.js server/scripts/test-upstream-transport.js server/scripts/test-csrf-boundaries.js`。
   - **126 测试，125 通过，1 失败**；唯一失败为 T1。日志 `/tmp/crewrouter-review-tests.log`。
   - 防护器替代应用配置/数据库、拒绝应用启动和真实 config.json 读取、只允许临时注册本机端口/隔离 PG socket；因此没有运行依赖实际部署配置的安全扫描命令。
2. Node VM Markdown 字符串测试：确认 R1 的 onmouseover 属性输出。
3. esbuild `write:false` 内存打包与 metafile：确认 R2 的动态 require 保留、setup 路由不在输入依赖图。
4. Go SDK 两个 httptest 临时本机服务、合成 Key：确认 R3；GOPROXY=off，不下载外部依赖。
5. 配额 some 判定和 SELECT 字段只读核对：确认 R5/R6。

## 未能验证、非问题与剩余风险

- 未运行生产数据库审计、迁移、真实 OAuth/PassPort/飞书外部交换、支付退款、真实供应商请求、Docker 完整构建、Electron GUI 和 SDK Python 全套 conformance；不对此作成功声明。
- 没有证明所有 routes/admin/user 的数百端点均已穷尽；重点追踪边界和高风险汇点，复杂插件/Agent/配额多请求业务仍建议独立专项审查。
- 现有 CSRF 和身份测试大部分通过；SSRF 公共工具已校验私网/多种 IPv6，quotaFetch 和商店下载有固定解析及手动重定向。不能仅因为出现 fetch/axios 就宣称存在 SSRF。
- 插件宿主明确声明 vm 不是安全沙箱，后端代码默认需要 CR_TRUST_IN_PROCESS_PLUGINS 显式信任；不将“受信后端插件可运行宿主代码”单独当作未知 RCE。
- 桌面已有 contextIsolation/sandbox、主帧 IPC origin 分类、客户端配置本地确认与信任重查；本次未确认新的桌面越权执行链，不以未跑 GUI 推断安全无风险。
- public/js/dom.js 的 setHTML 仅为字符串写入辅助，不能作为净化保证；除 R1 外的动态 HTML 汇点未做逐项数据源穷尽，不据此批量报告 XSS。
- 审查期间工作树变更来自主代理。本审查没有编辑、暂存或提交仓库文件。

## 主代理补充检查结果

- 21 组现有 npm 回归套件中 19 组通过；失败的两组如下，均未修改其业务源码。
- `test:quota-usage`：余额供应商测试向 127.0.0.1 fixture 发请求，被现有 SSRF 私网保护拦截，需修正测试隔离入口。
- `test:model-identity`：39 项中 20 通过、19 失败，错误为 VM 夹具缺少 require，执行提取代码中的 swallow-images 导入时提前终止。该结果不足以判定生产模型记录功能失败。
- `npm audit --omit=dev`：发现 follow-redirects 1.16.1 一项 high 公告 GHSA-mrwp-f3q8-3g9p（跨 realm sensitiveHeaders 数组导致自定义凭据可能随重定向转发）。axios 与 http-proxy 间接引入；公告条件在项目中的可达性尚未完整验证，建议升级到已修补版本并重跑代理测试。依赖未在本轮自动升级。
- 原有部分 npm 测试会导入真实配置/数据库模块，其中会话总结测试输出了余额表初始化日志。本轮没有执行生产数据审计或批量设置迁移，无法凭该测试声明真实环境完全无副作用；新增设置测试使用临时 PostgreSQL 或内存/VM 夹具。

## 本轮设置修复验收

- `node --test server/scripts/test-default-disabled.js server/scripts/test-user-signature-settings.js`：4 项全部通过。覆盖新旧库默认值、四类 Key 创建入口、播种/新建提示词默认禁用、保留历史选择，以及签名保存成功/失败的缓存行为。
- `npm run test:key-config` 最终完整通过，包含 Key 生命周期、提示词缓存、8 项事务测试、真实隔离 PostgreSQL 播种及 Key 并发写入；此前 initdb 超时在最终重跑中未再出现。
- 默认值修改适用于新增用户、密钥和提示词；用户已保存的显式开启选择保留。运行中的部署需要重新发布/重启后执行代码内列默认值迁移，本轮未操作现网服务。
- `node scripts/test-settings-defaults-browser.js`：最终真实无头 Chrome 回归通过，桌面 1440px 和手机 390px，共 61 项断言。验证签名开/关保存刷新、HTTP/业务错误重试、Key 选项保存及徽标同步、提示词停用/启用与新建、跨页面导航。此前重跑暴露的是测试等待异步列表和刷新执行上下文的竞态，已修正等待条件。
- 浏览器使用真实控制台和 Blora 组件，设置接口采用本地内存夹具；刷新持久性验证覆盖同一服务进程，数据库语义由独立 PostgreSQL 回归覆盖。未验证现网服务、浏览器登录授权或多进程缓存传播。
