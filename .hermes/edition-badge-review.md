# `efbef8f` 版本标签实现审查

## 审查范围

- 目标提交：`efbef8f`（`feat: add instance edition badges to branded pages`）
- 依据：提交计划、完整提交 diff、`/api/instance` 及实例 edition 公共逻辑、公共 badge 脚本、正式页面、相关测试，以及 Desktop 侧对实例 metadata 的消费方式。
- 已执行：`npm run test:edition-badge`、`npm run test:instance-edition`、相关 JavaScript 语法检查、提交 diff 空白检查和正式页面静态接入盘点。
- 未执行：真实浏览器/Electron 视觉截图和带真实数据库的 HTTP 集成验收。

## Verdict

**发现问题，不建议将该提交视为完整满足“所有正式页面、真实实例状态、重复挂载、深浅色与 600px 响应式、测试覆盖”要求的最终实现。**

## Issues

### Issue 1

- **severity**: high
- **File**: `public/pages/index.html:80-84`, `public/pages/showcase.html:380-384`, `public/pages/feishu-bind.html:35-40`, `public/pages/oauth-consent.html:89-92`, `public/pages/purchase.html:120-128`, `public/pages/set-password.html:30-40`, `public/pages/plugin-install.html:1-...`
- **Description**: 提交只接入了 `admin.html`、`console.html`、`data.html`、`playground.html`、`setup.html`、`store.html` 六个页面。静态盘点显示其余仍包含 CrewRouter 品牌区的正式页面均没有 `data-edition-badge` 节点，也没有加载 `edition-badge.js`/对应 CSS。尤其根登录页、演示首页、OAuth 授权页、绑定/设置密码页和购买页在用户可见品牌处不会显示实例状态，因此不满足“所有正式页面/品牌区”的覆盖要求。`showcase.html` 还是 demo 根路由实际返回的首页。
- **Suggestion**: 先定义完整的正式页面清单，并为每个实际展示 CrewRouter 品牌的页面统一接入节点、CSS 和脚本；若某些页面明确不应展示，应在计划和测试中写出排除理由，而不是只依赖未文档化的页面子集。
- **Status**: open

### Issue 2

- **severity**: medium
- **File**: `public/pages/setup.html:112-113,122`, `public/js/edition-badge.js:24-30,39-44`
- **Description**: setup 页在首次未初始化 edition 时加载 `/api/instance`。服务端此时 `ensureInstanceEdition()` 返回空值，`metadata()` 抛出错误，`/api/instance` 返回 503；共享脚本把失败静默转换成 `null` 并隐藏 badge。用户随后在 setup 页选择 Personal/Team 后，页面没有再次调用 `load()` 或 `mount()`，因此该页在整个 edition 选择/初始化流程中都不会显示刚刚选择的版本。该行为也使 `/api/instance` 的失败语义与页面状态之间缺少可验证的更新闭环。
- **Suggestion**: 明确 setup 未初始化状态的预期（隐藏/“未初始化”/选择后显示），并在 edition 初始化成功后用响应中的 metadata 立即更新 badge，或重新读取实例接口；同时为 503、未初始化、选择成功三阶段增加测试。
- **Status**: open

### Issue 3

- **severity**: medium
- **File**: `server/index.js:2510-2517`, `server/utils/instance-edition.js:40-51`
- **Description**: `/api/instance` 对普通服务端返回 `runtime`、`edition`、`auth`、`capabilities`，对 demo 强制使用 `edition: 'team'`，对 Desktop Local 强制使用 local auth；但 `metadata()` 没有返回 `demo` 或 `protocolVersion`，且其 `auth` 是根据 `authMode` 推导的，不是直接校验/回显 `config.auth`。因此该接口可作为 badge 的最小来源，但不能完整代表计划/其他消费者所称的“权威实例 metadata”。当配置中的 auth 声明、数据库 auth_mode、runtime 或 demo 状态不一致时，接口可能继续生成一套推导后的 auth，而不是报告不一致或真实配置。提交没有新增 API 集成测试来证明这些字段和失败语义。
- **Suggestion**: 规定 `/api/instance` 的正式 schema，区分 badge 所需字段和完整 bootstrap metadata；从同一权威配置/持久化状态生成并校验 `runtime`、`edition`、`auth`、`demo`、协议版本，冲突时返回稳定的错误类型和状态码。至少覆盖未初始化、无效持久化 edition、CR_EDITION 冲突、数据库未就绪、demo、Desktop Local、Personal/Team 服务端实际 auth 的 HTTP 测试。
- **Status**: open

### Issue 4

- **severity**: low
- **File**: `public/js/edition-badge.js:39-44`; `public/js/app.js:195-203`; `public/js/admin.js:145-153`; `public/pages/admin.html:2476-2481`; `public/pages/console.html:2717-2725`
- **Description**: 页面底部先加载共享脚本时，脚本注册 `DOMContentLoaded` 自动挂载；随后 `app.js`/`admin.js` 在登录用户加载完成后又调用同一个 `load()` 和 `mount()`。Promise 缓存避免了重复 HTTP 请求，但 DOM 挂载仍会发生两次，且测试没有模拟“自动挂载 + 页面显式挂载”的真实时序。该重复目前通常是幂等的，但会造成不必要的写入和未来扩展副作用风险，也没有对加载失败后的重试语义作出定义。
- **Suggestion**: 选择单一挂载责任（共享脚本负责全部页面，或页面应用负责受控挂载），或让脚本记录已挂载节点/状态并只在实例数据变化时更新；增加 DOMContentLoaded、应用显式 mount、HTTP 失败和重试场景测试。
- **Status**: open

### Issue 5

- **severity**: medium
- **File**: `public/css/edition-badge.css:1-29`; `public/css/store.css:18-20`; `public/pages/data.html:32-45,87-90`; `public/pages/showcase.html:60-70,356-370`
- **Description**: 提交只增加了 badge 自身的 dark 覆盖和一个 `max-width:600px` 规则，没有真实 600px 浏览器验收。`color-mix()` 没有 fallback；store 品牌行在 600px 以下仍是不可换行的单行 flex，品牌名、badge、插件商店 tag 及右侧导航在更窄 viewport 可能挤压或溢出；data 导航也仅缩小 padding，没有处理品牌、链接、语言选择和主题控件的整体空间。另一方面，`showcase.html` 的响应式断点使用 767px，并且其真正品牌导航没有接入 badge，故提交中的 600px 规则并不能证明所有正式页的 600px 安全。
- **Suggestion**: 在 Chromium 中实测浅色/深色及 600px（至少包含窄于 600px 的实际移动宽度），检查计算后的对比度、换行和横向滚动；为关键颜色提供 fallback，并针对 store/data/console/admin 各自的品牌容器设置收缩、换行或移动端布局规则。
- **Status**: open

### Issue 6

- **severity**: medium
- **File**: `server/scripts/test-edition-badge.js:7-31`, `package.json:30-31`
- **Description**: 新测试只在 VM 中测试 `resolve()` 和对两个伪造元素的 `textContent/hidden` 赋值。它没有读取或断言六个已接入页面，更没有发现其余页面遗漏；没有测试 `/api/instance` 的真实响应字段、503/冲突/未初始化语义、`fetch` 非 2xx、JSON 解析失败、自动挂载时序、重复挂载、深色 CSS、600px 布局或真实页面脚本加载。测试中的 `mounts` 变量只是手工累加元素数量，并非重复挂载断言。
- **Suggestion**: 增加静态页面覆盖测试、真实 Express/HTTP API 测试和 DOM 时序测试；对每个正式页面断言节点、脚本和样式；对 LOCAL 优先级、未知值、XSS 输入、失败隐藏/恢复、单次请求、重复 mount、主题变量及 600px 样式分别断言。将这些测试纳入默认验证流程，而不是只提供可单独运行的脚本。
- **Status**: open

### Issue 7

- **severity**: low
- **File**: `public/pages/setup.html:122-123`, `public/pages/playground.html:37`, `public/pages/admin.html:60`, `public/pages/console.html:63`
- **Description**: badge 使用 `textContent` 渲染，当前固定白名单 `LOCAL/PERSONAL/TEAM`，因此未发现直接 XSS；LOCAL 优先级实现本身正确（`runtime === 'desktop-local'` 先于 edition）。但接入位置和容器并不统一：setup 是标题内联、playground 是移动标题，admin/console 是 sidebar 标题，store/data 是品牌行。测试只验证固定 label，没有验证不同页面容器的 flex/line-height/可见性组合，不能据此排除真实页面回归。
- **Suggestion**: 保留白名单与 `textContent`，并为各类品牌容器增加 DOM/CSS 回归断言或实际截图；明确未知 runtime/edition 的产品行为（隐藏还是错误提示），避免静默隐藏掩盖实例 metadata 异常。
- **Status**: open

## 已确认的正面结果

- `resolveEditionBadge()` 的 LOCAL 优先级正确：`runtime === 'desktop-local'` 会覆盖同时存在的 `edition: 'personal'`。
- badge 标签通过 `textContent` 写入，提交中未发现将实例字段直接拼进 `innerHTML` 的 XSS 路径。
- `npm run test:edition-badge`、`npm run test:instance-edition` 均通过；相关 JS 语法检查和 `git diff --check` 通过。
- 已接入页面中，badge CSS 在 HTML 中位于主题 CSS 之后，脚本位于页面应用脚本之前；这部分加载顺序本身合理。但 setup 的提前读取和应用层二次挂载仍见 Issue 2/4。

## 回归与未验证项

- 未观察到 badge 脚本自身导致的已执行单元测试回归。
- 未完成真实浏览器/Electron 截图，因此不能宣称深浅色、600px 无横向溢出或页面首屏视觉通过。
- 未使用真实 PostgreSQL/启动完整 HTTP 服务验证 `/api/instance` 的全部成功与失败分支。
- 工作树在审查前已存在大量与本审查无关的未提交修改；本次没有修改代码，仅新增本审查报告。
