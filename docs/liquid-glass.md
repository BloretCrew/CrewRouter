# Liquid Glass 设计（控制台）

控制台正在从 Blora 外观迁移到 Apple Liquid Glass 风格。设计直接复用
`/data/HTML-Clock/index.html`（Liquid Glass Clock）的材质令牌与组件做法，
再按 Apple Liquid Glass 与系统色校准。迁移按页面进行，一页一次提交。

## 文件

| 文件 | 作用 |
| --- | --- |
| `public/css/liquid-glass.css` | 令牌、可复用材质、Blora 令牌桥接、组件皮肤、控制台壳层、无障碍降级 |
| `public/css/model-library-console.css` | 模型库页面布局与材质层级 |
| `public/css/my-upstream.css` | 我的上游页面布局，以及其 6 个弹窗内部的布局 |
| `public/css/api-keys.css` | API Key 页布局、Key 卡片、标签 / 路由浮层、本页弹窗与 Key picker 列表 |
| `public/css/config-dialog-blora.css` | 客户端配置弹窗内部布局（面板外观交给玻璃面板） |
| `public/js/blora-dialog.js` | 从玻璃页面打开的确认框 / 提示框自动加 `lg-scope` |

`liquid-glass.css` 在 `console.html` 中排在 `console-blora.css` / `sidebar-blora.css`
之后、各页面样式之前加载；页面样式可以覆盖基础皮肤。

## 来源与校准

直接沿用 HTML-Clock 的值：`--glass-bg`、`--glass-bg-strong`、`--glass-border(-strong)`、
`--glass-highlight`、`--panel-bg`、`--divider`、`--chip-bg`、`--transition`
（`cubic-bezier(0.32, 0.72, 0, 1)`）、`--blur-amount`（40px）、`blur() saturate(180%)`
的玻璃配方、胶囊控件、`.font-card` 卡片（半透明 + 高光 + 描边）、强调色光晕、
`:active` 缩放 0.96、深色「午夜」背景与 accent 光斑。

按 Apple Liquid Glass 调整的部分：

- 强调色与状态色使用 Apple 系统色：浅色 systemBlue `#007AFF`、深色 `#0A84FF`，
  绿 / 橙 / 红等同理；文字使用「增强对比度」版本（如 `#248A3D`、`#D70015`）。
- 浅色模式给白色玻璃补一圈极浅外描边和左上 / 右下更亮的渐变边缘高光
  （`--lg-rim-gradient`），白玻璃在浅色背景上仍有轮廓。
- 侧栏是悬浮的玻璃面板（macOS 26 侧栏），选中态为中性白色胶囊，
  与尚未迁移页面的 Blora 强调色不冲突。
- 背景光斑改为静态渐变。HTML-Clock 的光斑持续漂移，背景每帧变化会让所有玻璃
  每帧重新模糊；控制台长时间常开，因此不做动画。
- 支持系统「减少透明度」（玻璃改实色）、「增强对比度」（加深分隔线与描边）、
  「减少动态效果」；不支持背景模糊的浏览器自动提高不透明度。

## 启用方式

- 页面容器加 `lg-page`（如 `<div id="modelLibraryPage" class="page lg-page">`）。
  作用域内的 Blora 组件通过令牌桥接（`--blora-*` → `--lg-*`）与统一皮肤呈现玻璃外观。
- 不在页面容器内的弹层（对话框、挂在 body 下的菜单）加 `lg-scope`。
  `<blora-dialog class="lg-scope">` 的面板变为玻璃面板（`::part(panel)` 等）。
  `Dialog.confirm / alert / showModal` 生成的临时弹窗在当前页带 `lg-page` 时自动加上。
- 当前页带 `lg-page` 时，`body::before` 显示背景光斑；切到未迁移页面时淡出。
- 壳层（侧栏、页面大标题、主题按钮、移动顶栏）对整个控制台生效。

## 材质层级

背景光斑 → 玻璃面板 → 分组底 → 卡片 → 控件。

- 真实背景模糊（`backdrop-filter`）只用于浮在内容上的元素：侧栏、悬浮工具栏、
  筛选工具栏、绑定卡、菜单、提示气泡、玻璃按钮。
- 内容卡片沿用 HTML-Clock `.font-card`：半透明底 + 高光 + 描边，不做模糊。
  卡片数量可能很多，逐个模糊滚动开销大；而且带模糊的祖先会成为 backdrop root，
  内部元素本来也只能模糊到祖先自身。
- 菜单与下拉弹层使用 0.95 不透明度的厚材质：它们常位于带模糊的工具栏内，
  模糊取不到工具栏以外的内容，必须不依赖模糊也可读。
- 菜单打开时提升所在卡片 / 分组的 `z-index`，避免被后面的元素盖住。

## 已有的组件皮肤

作用域内统一生效，后续页面直接复用：

- 按钮：primary 实心强调色 + 光晕；secondary 灰色胶囊；outline 玻璃胶囊；ghost 透明；danger 红色。
- 标签 / 徽章：无边框着色胶囊（中性、强调、成功、警告、危险、信息）。
- 下拉选择（`blora-select`，经 `::part`）：胶囊触发器 + 上下双箭头，弹层为厚玻璃。
- 搜索与输入：iOS 填充式，聚焦时强调色光环；作用域内的普通文本输入框同样生效。
- 菜单（`blora-dropdown`）、提示气泡、分段控件（`blora-segmented`）。
- 页签（`blora-tabs`）：iOS 分段控件，滑块沿用 Blora 计算的位置变量。
- 表格（`blora-table`）：玻璃面板中的分组列表；右侧固定列为透明 + 模糊，
  横向滚动时内容从玻璃下滑过；批量操作条为强调色胶囊。
- 复选框：圆角方框，选中为强调色实心 + 白色对勾（开关里的隐藏 input 除外）。
- 表单：字段标签次级小字；`blora-fieldset` 为 iOS 分组底；步骤条强调色。
- 对话框：玻璃面板（blur 60px + saturate 200%），圆形关闭按钮悬停旋转；
  由 `blora-dialog.js` 托管的旧版 `.modal-content` 弹窗同样改为玻璃面板。
- 旧版内容区 `.content-section` / `.section-header`：玻璃面板 + 页内标题。
- 卡片（`.blora-card`）、统计数字（`blora-statistic`）、iOS 绿色开关（`blora-switch`）、
  组合控件（`blora-join` 改为留间距）、时间选择面板。
- app.js 行内样式使用的旧变量（`--muted-foreground`、`--border`、`--destructive` 等）
  在作用域内同样映射到玻璃令牌。

## 与旧样式的优先级

`console-blora.css` 未分层，并直接写了 `background`、`border-radius`、输入框边框
（`.blora-page input:not(...)×3`）。基础皮肤因此写实际属性而不只是改 Blora 变量，
并使用同等或更高的特异性，靠加载顺序胜出。迁移新页面时如果组件颜色没变，
先检查是否被 `console-blora.css` 的同名规则覆盖。复选框同理：`toggles-blora.css`
用 `:not()` 链给所有复选框定了尺寸与圆角，玻璃皮肤沿用同样的 `:not()` 链。

## 迁移进度

1. 模型库 `#modelLibraryPage` — 已完成
2. 我的上游 `#myUpstreamPage`，含添加 / 编辑供应商、管理模型、添加 / 编辑模型、
   批量编辑、批量设置价格 6 个弹窗，以及删除确认等临时弹窗 — 已完成
3. API Key 与用量 `#apiKeysPage`：Key 卡片、标签栏、悬浮顶栏、授权管理，
   标签 / 路由队列浮层，创建密钥、成员、选项、签名、定时、新建标签、额度脚本、
   模型队列（Key picker）、客户端配置等弹窗 — 已完成
4. 统计信息 `#statsPage`：筛选条、统计瓷片、实时活动、缓存命中、今日 / 昨日、
   分段页签、10 个分析页签（概览、延迟与吞吐、多维分析、每日、时段、模型、密钥、
   客户端、消息、调用记录）、供应商额度与图表配色 — 已完成
5. 项目工作 `#projectWorkPage`：工作台标题、筛选条、汇总瓷片、最近活动图表、
   最近活跃项目、项目卡片 — 已完成
6. 排行榜 `#leaderboardPage`：玻璃排行表（名次徽章、头像、当前用户行高亮、页脚） — 已完成
7. 下一步：积分 `#balancePage`，之后按侧栏顺序继续。

`.stats-filters` 筛选条的玻璃皮肤已提到 `liquid-glass.css`，统计信息、项目工作、
排行榜等页面直接复用，页面 CSS 只调下拉宽度与排布。

## 图表配色（Liquid Glass 页）

canvas 不解析 `var(--x)`，`app.js` 的 `_upsertChart` 会按图表所在 `.page` 作用域解析颜色：
Liquid Glass 页额外把 `--info` / `--success` 等文字用的 ink 色换成 `--lg-accent` /
`--lg-green` 等标准系统色（`_glassChartTokens`），线条 2px 无点 + 渐隐面积，柱状圆角、
圆环带间隙；主题切换时由 `_watchGlassChartTheme` 重算数据色。`multi-dimension-chart.js`
单独建图，用 `container.closest('.lg-page')` 判断后套用同一套系统色与刻度色。

## 新页面迁移清单

1. 容器加 `lg-page`，弹层加 `lg-scope`。
2. 页面 CSS 只写布局与材质层级，组件外观交给 `liquid-glass.css`；
   需要新组件皮肤时加到基础文件，供后续页面复用。
3. 去掉页面内的旧背景色（页面容器不能盖住背景光斑）。
4. 浅色 / 深色、1440 / 820 / 390 宽度截图检查；打开菜单与下拉检查层级与可读性。
5. 运行相关浏览器测试，与迁移前结果对比。

## 验证

```sh
# 隔离的演示服务与无头 Chrome（不连生产库），浏览器测试默认连 18571 / 18572
node scripts/verify-blora-correction-browser.js --server
node scripts/verify-blora-correction-browser.js --chrome
node scripts/test-agent-model-library-browser.js
node scripts/test-client-config-browser.js
node scripts/test-provider-editor-pages-browser.js
node scripts/test-api-key-card-controls-browser.js
# 自带服务与浏览器
node scripts/test-unified-provider-browser.js
```

迁移后通过：`test-agent-model-library-browser.js`、`test-client-config-browser.js`、
`test-provider-editor-pages-browser.js`、`test-unified-provider-browser.js`、
`test-api-key-card-controls-browser.js`。

`test-library-sticky-alignment-browser.js`、`test-model-card-badges-browser.js`、
`test-inject-uptime-menu-browser.js`、`test-library-closed-keys-browser.js`、
`test-provider-quota-layout-browser.js`、`test-cpa-quota-browser.js`、
`test-provider-wizard-browser.js`、`test-api-keys-desktop-layout-browser.js`、
`test-config-dialog-browser.js` 在迁移前已在同一断言失败，迁移后结果相同。
