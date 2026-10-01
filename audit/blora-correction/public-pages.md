# 公开页面 Blora 2.1 纠正验收

范围：现有十二页及 auth-shell/playground/store/usage 专用 CSS、oauth-consent/playground/store/usage JS。不修改 console/admin、main/themes、services/foundation/theme，不新增演示页，不访问 shadowRoot，不提交。

已阅读安装包 2.1.0 的 patterns、guide、framework、migration/from-any-ui-to-blora-design、standards，以及 card/field/button/table/alert/empty/search/rate/dialog/drawer/menu/chat 契约、component/custom-elements manifests。迁移以公开 DOM/class/属性为边界，专用 CSS 只保留布局；旧表面不能靠降层继续提供。

| 页面 | 原问题 → 本轮处理 | 能力验收 / 父任务补验 |
| --- | --- | --- |
| index | 24rem 标题拥挤、旧卡片 logo/footer 外观、Field 改原生输入后仍查 `#id input` → 42rem 表单列、官方 Card/标题、直接读真实原生值、预注册完整图标。 | Chrome 390px 无横溢/嵌套卡，图标实际 SVG；父补真实登录、2FA、PassKey 和身份重定向。 |
| data | 自绘统计/表格/字号 → 官方小 Card、h2 区块、独立 TableWrap、Tag/Mono；加载错误增加重试。 | 窄屏独立表格滚动、空数据；父补非空长设备号/大数及 30 秒真实刷新。 |
| feishu-bind | logo/login-form 继续继承 main 的旧外观 → 去掉 main/themes 依赖，官方标题、Card/Stack/Field。 | 窄屏标题/表单无横溢；父补真实飞书 pending 与密码绑定。 |
| oauth-consent | scopes 自绘边框、缺少选择器关联/失败恢复 → 官方 List/Code、区块标题、关联标签、Alert+Retry；默认密钥校验，拒绝不触发批准所需表单验证。 | Chrome 已呈现 scopes/选择器；保持原 POST、decision、请求隐藏域；父补原生批准/拒绝跳转、无密钥和未登录。 |
| playground | 自绘左右面板/输入壳/头像/菜单/代码/错误，移动端参数无入口 → 一层官方 Card，消息 Avatar/Stack、官方 Skeleton/Alert/Code，官方 Dialog 消息操作、官方 Drawer 移动历史/参数面板；模型/历史失败重试，原生可键盘思考展开。 | Chrome 移动参数按钮可用；Batch C 流成功/失败/timeout/disconnect/计费/不可变重试通过；父补真实模型流和历史记录、菜单键盘、停止/重试。 |
| plugin-install | 插件标题是 div、错误态无页面标题、权限/行为字号自绘 → 固定 h1、插件 h2、官方 Code/Alert、安装/加载失败重试。 | Chrome 成功态一个 h1、无嵌套卡；保留 admin 安装接口及 401/403；父补真实安装权限、失败恢复。 |
| purchase | 伪控制台侧栏、旧商品外观及内联蓝色提示 → 专注内容页，官方标题/Card/Alert/按钮，加载重试，商品文本转义。 | Chrome 商品呈现无横溢；购买仍明确提示“暂未开放”，未伪造支付；父补真实商品缺失/下架。 |
| set-password | Field 原生化后仍读取子 input，密码不一致仅页级错误 → 直接读真实控件，确认密码 Field invalid/error + 聚焦。 | Chrome 实际提交 payload 含输入的 password/confirmPassword；父补真实设置成功/权限重定向。 |
| setup | 步骤标题/警告/空错误旧外观，永久版本确认用 window.confirm → 官方标题/Card/Stack/Message，状态失败 Retry，公开 Dialog 确认永久选择。 | Chrome 初始化完成态无溢出；父补未初始化 edition/mode/admin 各步骤及二次确认。 |
| showcase | 大量渐变/玻璃背景/自绘状态和按钮/装饰 SVG，表格外壳混乱 → 官方 Card/Badge/Tag/Button/标题/Code、Lucide，表格独立 TableWrap，移除内联旧外观和 hero 装饰。 | Chrome 一页一个 h1、无嵌套卡/溢出、所有图标 SVG；保留现有介绍与 console iframe，父补真实预览加载/明暗宽屏视觉。 |
| store | 专用 CSS 继续重绘卡片/侧卡/状态/输入/弹窗；标题 div → 官方资源 Card、h1/h2、Search、Field、List/Badge/Empty；手写 mask 改公开 Dialog show/close，增加读取 Retry/本地 Field 校验。 | Chrome 浏览资源、详情安装 Dialog 显示、Esc 关闭；父补真实搜索/排序、评分、提交、我的插件/审核权限、禁用安装实例。 |
| usage | 数据外壳/标题/返回按钮旧外观、请求错误无恢复 → 独立 TableWrap、正式表头/caption、Skeleton/Alert/Empty + Retry；长模型 Tag 可换行，hidden 状态显式布局保护。 | Chrome 500→Retry→Empty 实际通过；保持非法 key/401/403 流，父补真实长模型/日期聚合/金额。 |

## 已执行

- 官方 `blora-lint` 对十二页、四 CSS、四 JS：**0 problems**。
- 十二页所有内联脚本 VM 编译、四 JS `node --check`、限定范围 `git diff --check`：通过。
- `scripts/test-blora-public-batch-c.js`：通过，包括执行型流状态/计费/重试断言。
- 复用 Chrome CDP 18572，独立临时本地资源服务器与拦截接口；十二页 390px 明色检查和暗色复查均无 document 横溢、无嵌套 Card、图标包含真实 SVG、无 pageerror。实际互动：密码 payload、用量失败重试、移动参数入口、商店官方安装 Dialog/Esc。
- 浏览器详细结果：`/tmp/public-browser-results.json`；检查脚本 `/tmp/public-browser.cjs`。接口采用模拟响应，不能据此声称真实登录/授权/安装已验收。六主题、宽屏和真实数据全页验收由父任务统一完成，未跑旧 584 矩阵。

## 测试失配

`test-blora-public-batch-a.js`（及依赖它的 verify 脚本）仍断言 auth-shell CSS 必须包含 `--blora-color-surface-default` / `--blora-color-text-primary` 自绘外观；本轮将这些外观交还官方 Card/文字类后，该旧断言失败。未为了过旧测试重新引入业务外观，也未越界修改测试脚本。父任务应更新该断言为官方组件 DOM/计算样式验收。

## 追加纠正：Playground 浮层组合

前次的零 lint 和窄屏无溢出不能证明浮层组合合规：消息菜单仍手写 fixed/outside/focus，移动历史/设置仍使用业务遮罩和定位。本次已删除 `pgOverlay`、`.pg-overlay`、`.pg-history-panel.open`、fixed 历史/设置及菜单 CSS，并取消业务 document outside/Esc/scroll 与手动焦点管理。

- 消息操作改为公开 `blora-dialog.show()/close()`；保留 copy-text/copy-rich/copy-md/reply/fork/delete 业务分支。原右键、键盘 ContextMenu、Shift+F10 均打开该 Dialog；消息本身可聚焦。焦点圈禁、Esc、外部点击和归还由官方组件管理。
- 移动历史和模型参数分别使用公开 `blora-drawer` 左/右面板与 `open()/close()`。跨断点只搬运原面板和原控件节点，不复制或重建输入/选择器，不访问组件内部 BEM/shadowRoot。历史详情与参数共用设置 Drawer，保留现有切换事件。
- Drawer contract 未声明关闭事件，按钮 aria-expanded 仅观察宿主公开 open 属性；不监听猜测的自定义事件、不实现遮罩/焦点圈禁。
- Chrome 针对性互动通过：历史/设置 Drawer 显示及 Esc；设置关闭后焦点归还按钮；Shift+F10/右键消息 Dialog；回复流程；Dialog Esc 后焦点归还消息；390→1280 后原模型/滑块/开关/新建按钮节点身份一致，滑块原 input 监听仍更新值。无 pageerror。
- 追加检查脚本与日志：`/tmp/pg-official-overlay-browser.cjs`、`/tmp/pg-official-overlay-browser.log`；结构结果 `/tmp/pg-official-overlay-results.json`。首次加严运行遇到键盘打开等待时序问题，改用官方 open 状态等待后重复通过。父任务仍需全页六主题/真实数据验收。
- 本次限定修改 Playground HTML/JS/CSS 与本清单；无提交。lint/语法/Batch C 通过仅是静态/业务回归证据，不等同全部页面组合完全合规。
