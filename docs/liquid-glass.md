# Liquid Glass 设计（晶液）

控制台的 Apple Liquid Glass 直接抄自 `BloraDesign3-ARCHIVE/themes/skins/liquid/`
（晶液）。光学、令牌、壁纸和水滴都按那套写法挂到 CrewRouter 的 DOM 上。

## 五条规则

1. 玻璃只给控制层。文字和数据坐在 `--sheet` 纸面上。
2. 透镜，不是磨砂。Chromium 用 SVG `feDisplacementMap` 做边缘折射
   （`backdrop-filter: url(#filter)`）；模糊只是非 Chromium 回退，约 16px。
3. 没有描边、没有 rim glow。轮廓来自材质对比和软阴影。
4. 同心圆角：外 28 → 内 20 → 12。
5. 选中态只由一颗滑动、拉伸的白色玻璃水滴来画。

默认调色板是晶液青灰：`--hue: 200; --chroma: .06`。强调色由 hue/chroma 算出，
不用 systemBlue `#007AFF`。不引入晶液的 Dock / 启动器 / 窗口铬，也不引入六套色盘。

## 文件

| 文件 | 作用 |
| --- | --- |
| `public/css/liquid-glass.css` | 晶液令牌、玻璃配方、水滴、Blora 令牌桥接、组件皮肤、壳层、无障碍降级 |
| `public/js/liquid-glass.js` | 壁纸 SVG、透镜引擎、水滴几何与拖拽、壁纸选择器（抄自 `liquid.js` + `scaffold.js`） |
| `public/assets/wallpapers/` | 晶液原壁纸 12 张 SVG（青灰 / 冰蓝 / 暖砂 / 苔绿 / 雾紫 / 烟粉 × 明暗） |
| `public/css/liquid-glass-pages.css` | 独立页（登录、商店、Playground 等）共用的壁纸与卡片层级 |
| `public/css/popup-notices.css` | 管理后台弹窗通知：叠放卡片、气泡列表、管理端列表 |
| `public/js/popup-notices.js` | 弹窗通知渲染器（`window.CrewRouterPopupNotices`） |
| `public/css/model-library-console.css` | 模型库页面布局与材质层级 |
| `public/css/my-upstream.css` | 我的上游页面布局，以及其 6 个弹窗内部的布局 |
| `public/css/api-keys.css` | API Key 页布局、Key 卡片、标签 / 路由浮层 |
| `public/css/config-dialog-blora.css` | 客户端配置弹窗内部布局（面板外观交给玻璃面板） |
| `public/js/blora-dialog.js` | 从玻璃页面打开的确认框 / 提示框自动加 `lg-scope` |

`liquid-glass.css` 在 `console.html` 中排在 `console-blora.css` / `sidebar-blora.css`
之后、各页面样式之前加载；页面样式可以覆盖基础皮肤。独立页面没有 `.lg-page`，
在 `<body>` 上加 `lg-scope` 即可拿到同一套令牌与组件皮肤。所有 HTML 页面都加载
`liquid-glass.js`。

`--lg-*` 是给旧页面 CSS 用的别名：`--lg-glass-border` 为透明，`--lg-sheen` /
`--lg-rim-gradient` 为 `none`，`--lg-blur` 为 16px。页面里写
`border: 1px solid var(--lg-glass-border)` 不会再画出描边。

## 光学

`liquid-glass.js` 按元素尺寸画 canvas 位移图，塞进 SVG `feDisplacementMap`，
再写成 `--lens: url(#liquid-lens-N)`。只有 Chromium 会在 `backdrop-filter` 里
渲染 `url()` filter；其它引擎走 CSS 里的 `--g-fallback`。

透镜配置抄自晶液 `PROFILES`：

| 配置 | 用在 |
| --- | --- |
| `capsule` | 侧栏、移动顶栏、筛选条、悬浮工具栏 |
| `menu` | 下拉菜单、选择弹层、气泡菜单 |
| `panel` | 对话框、登录卡、独立页主卡 |
| `toast` | 操作反馈 `.app-toast`、提示气泡、弹窗通知气泡列表 |
| `panel` | 对话框、登录卡、弹窗通知激活卡（整圈边缘折射） |
| `rim` | 水滴被拖动时的窄边折射 |

控件层 CSS 必须写成 `backdrop-filter: var(--lens, var(--g-fallback))`，
页面自己写 `blur(...)` 会盖掉透镜。

壁纸默认是晶液青灰构图的内联 SVG（`#lg-wallpaper`），颜色走 `--wp-*`。
用户可在「用户设置 → 界面背景」或「管理后台 → 外观」切换：

- **主题壁纸**：内联青灰 SVG，随明暗变色。
- **原壁纸**：抄自晶液 `assets/wallpapers/` 的 6 套产品插画，明暗各一张。
- **自定义**：本机上传图片或填写 `https` 地址，存在 `localStorage`（`crewrouter-liquid-appearance`），不超过 1.8MB。

UI 色盘仍固定青灰。`data-wallpaper` 为 `theme` / `product` / `custom`。
`body::before` 的旧径向光斑已关掉。遮罩（dialog / drawer / overlay）只有淡色，没有 blur。

## 水滴

侧栏分组、分段控件、页签导航会挂 `[data-indicator]`。选中项不再自带底色，
由 `.indicator` 按 `--ind-x/y/w/h` 滑动。行程用 `--glide`（约 150ms 越过、
0.45s 落定）。沿运动方向拉伸，停下时回弹。观察器策略抄晶液：透镜按元素
`ResizeObserver` 更新；主题只盯 `data-blora-color-scheme`；侧栏只盯
`aria-current` 等选中态属性。不观察整棵文档的 `childList`（会和 Blora
SidebarNav / foundation 互刷，卡死主线程）。晚到的导航用 400ms / 1.5s
各扫一次，菜单在 `pointerdown` 时再登记。

## 启用方式

- 页面容器加 `lg-page`。作用域内的 Blora 组件通过令牌桥接
  （`--blora-*` → `--lg-*`）与统一皮肤呈现玻璃外观。
- 不在页面容器内的弹层加 `lg-scope`。`<blora-dialog class="lg-scope">` 的面板
  变为玻璃面板（`::part(panel)`）。`Dialog.confirm / alert / showModal` 生成的
  临时弹窗在当前页带 `lg-page` 时自动加上。
- 当前页带 `lg-page` 或 body 带 `lg-scope` 时显示晶液壁纸。
- 壳层（侧栏、页面大标题、主题按钮、移动顶栏）对整个控制台生效。

## 材质层级

壁纸 → 玻璃控制层 → `--sheet` 内容 → 控件。

- 真实透镜只用于浮在内容上的元素：侧栏、悬浮工具栏、筛选条、菜单、提示、
  对话框、登录卡。
- 内容卡片用 `--sheet` / `--sheet-2`，不做模糊。卡片数量可能很多，逐个透镜
  开销大；带模糊的祖先还会成为 backdrop root。
- 菜单用不透明更高的 `--g-tint-menu`。
- 菜单打开时提升所在卡片 / 分组的 `z-index`，避免被后面的元素盖住。

## 弹窗通知（管理后台广播）

`public/js/popup-notices.js` + `public/css/popup-notices.css`，控制台启动时由
`app.js#init` 的 `_maybeShowPopupNotices()` 拉取未读并展示，管理后台「系统设置 →
弹窗通知」创建/预览。

- 浮层是原生 `<dialog class="cr-pn-overlay lg-scope">`，`showModal()` 后与
  `blora-dialog` 同在 top layer，预览可以盖住仍打开的编辑弹窗；不支持 `<dialog>`
  时回退为 fixed 浮层。
- 卡片是晶液玻璃面板（`--g-tint-menu` + `panel` 透镜），仅当前激活卡片使用透镜；
  打开/切换后会调用 `CrewRouterLiquid.scan()` 生成 `--lens`。不要再叠一层带
  `backdrop-filter` 的 `::after` 边框环：Chromium 下 mask 常失效，会整块盖住
  正文区变成发白磨砂板。
- hero 是暖色径向光斑（琥珀 / 珊瑚 / 玫瑰 / 赤陶），"CrewRouter" 每 50～70ms
  （随机）切换已安装系统字体；`prefers-reduced-motion` 下固定为 `--lg-font-display`。
- 多条通知叠放，左侧（≤900px 时卡片下方）显示气泡列表；只剩一条时不显示列表，
  窄屏只显示当前卡片。
- 已读按服务端记录（`popup_notice_views`），激活/关闭时批量上报，失败保留重试。
- 客户端拉取、上报失败均静默，不阻塞控制台；内容全部 `textContent` 写入。

## 组件皮肤

作用域内统一生效，后续页面直接复用：

- 按钮：primary 实心强调色；secondary 用 `--field`；没有光晕。
- 标签 / 徽章：无边框着色胶囊。
- 下拉选择（`blora-select`，经 `::part`）：胶囊触发器，弹层为菜单玻璃 + 透镜。
- 搜索与输入：`--field` 填充，聚焦时强调色光环。
- 菜单（`blora-dropdown`）、提示气泡、分段控件（`blora-segmented`）。
- 页签（`blora-tabs`）：轨道是浅凹槽，选中由水滴来画。
- 表格（`blora-table`）：`--sheet` 分组列表；右侧固定列为透明 + 轻模糊，
  横向滚动时内容从下方滑过；批量操作条为强调色胶囊。
- 复选框：圆角方框，选中为强调色实心 + 白色对勾。原生 `input[type=checkbox]`
  与 `blora-checkbox` 的 `.blora-checkbox__box` 用同一套配方（开关里的隐藏 input 除外）。
- 单选：`blora-radio` 的圆点边框与内芯用强调色。
- 分页：当前页强调色方块，其它项悬停用芯片底。
- 滑块 / 进度条：轨道填充与拇指 / 填充条用强调色。
- 日期 / 时间选择：面板是菜单玻璃；触发按钮悬停用芯片底；选中日期强调色。
- 表单：字段标签次级小字；`blora-fieldset` 为分组底。
- 对话框：菜单玻璃 + 透镜，圆角 32px，圆形关闭按钮悬停旋转。
  由 `blora-dialog.js` 托管的旧版 `.modal-content` 弹窗同样改为玻璃面板。
  面板用 `box-sizing: border-box`，并把组件的回弹曲线换成 `--ease-out`。
  旧版弹窗的宽度上限取 HTML 声明值（行内 `max-width` 或 `.modal-wide`）。
  控制台与 `admin.html` 的静态弹窗全部加了 `lg-scope`。
  JS 动态 `createElement('blora-dialog')`（模型归因、额度周期、额度历史）
  在创建时加 `lg-scope`；`liquid-glass.js` 扫描时也会给当前玻璃页上的
  `blora-dialog` / `blora-drawer` 补上这个类。
- 挂在 `body` 下、由 JS 动态创建的浮层同样需要作用域：模型库 Key 气泡菜单、
  跟踪报告浮层、脚本「AI 辅助模型」选择器、供应商标签分配下拉。
- 操作反馈 toast 抄晶液 `.app-toast`：玻璃菜单材质 + 彩色圆点（成功绿 / 错误红 /
  信息强调色），不是整块实心色条。`CrewRouterLiquid.toast(message, kind)` 写入
  `#lg-toast-stack`；控制台、管理后台、Playground 的 `showToast` 都走这里。
  只观察 toast 栈的 `childList`，不观察整棵文档。
- 公开页 `blora-navbar.public-navbar`（初始化、飞书绑定）掀掉 vendor
  `::before { backdrop-filter: blur(20px) }`，胶囊透镜。
- Playground 右键菜单是菜单玻璃；思考开关与 Fusion 配置开关用 `blora-switch`。
- 旧版内容区 `.content-section` / `.section-header`：`--sheet` + 页内标题。
- 卡片（`.blora-card`）、统计数字（`blora-statistic`）、开关（`blora-switch`）、
  组合控件、时间选择面板。
- app.js 行内样式使用的旧变量（`--muted-foreground`、`--border`、`--destructive` 等）
  在作用域内同样映射到玻璃令牌。

## 无障碍

- `prefers-reduced-transparency`：关掉透镜，玻璃改实色。
- `prefers-contrast: more`：加深分隔线。
- `prefers-reduced-motion`：水滴不做拉伸与拖拽。
- 不支持 `backdrop-filter` 的浏览器走更高不透明度的 `--sheet`。

## 与旧样式的优先级

`console-blora.css` 未分层，并直接写了 `background`、`border-radius`、输入框边框。
基础皮肤因此写实际属性而不只是改 Blora 变量，并使用同等或更高的特异性，
靠加载顺序胜出。迁移新页面时如果组件颜色没变，先检查是否被
`console-blora.css` 的同名规则覆盖。复选框同理：`toggles-blora.css` 用
`:not()` 链给所有复选框定了尺寸与圆角，玻璃皮肤沿用同样的 `:not()` 链。
`.blora-page` 把 `--accent` 映射成 shadcn 的 soft 底；`:is(.lg-page, .lg-scope)`
会重新写成晶液品牌色，控件填充才是青灰而不是 vendor 的浅强调色。

页面 CSS 若再写 `backdrop-filter: blur(...)`，会盖掉 `--lens`。控件层一律写
`var(--lens, var(--g-fallback))`。

## 图表配色

canvas 不解析 `var(--x)`，`app.js` 的 `_upsertChart` 会按图表所在 `.page` 作用域
解析颜色：Liquid Glass 页额外把 `--info` / `--success` 等文字用的 ink 色换成
`--lg-accent` / `--lg-green` 等（`_glassChartTokens`），线条 2px 无点 + 渐隐面积，
柱状圆角、圆环带间隙；主题切换时由 `_watchGlassChartTheme` 重算数据色。
`multi-dimension-chart.js` 单独建图，用 `container.closest('.lg-page')` 判断后
套用同一套色。

## 新页面清单

1. 容器加 `lg-page`，弹层加 `lg-scope`，页面加载 `liquid-glass.js`。
2. 页面 CSS 只写布局与材质层级，组件外观交给 `liquid-glass.css`。
3. 控件层用透镜；内容用 `--sheet`。不要描边、不要 rim glow、不要厚模糊。
4. 浅色 / 深色、1440 / 820 / 390 宽度对照
   `BloraDesign3-ARCHIVE/themes/index.html?skin=liquid`。
5. 打开菜单与下拉检查层级与可读性；点侧栏看水滴是否跟着走。

## 验证

```sh
# 隔离的演示服务与无头 Chrome（不连生产库），浏览器测试默认连 18571 / 18572
node scripts/verify-blora-correction-browser.js --server
node scripts/verify-blora-correction-browser.js --chrome
```

对照基准：`BloraDesign3-ARCHIVE/themes/index.html?skin=liquid`。
需要看透镜时用 Chromium（`google-chrome`）；Firefox 只会看到模糊回退。

```sh
node scripts/test-liquid-wallpaper-browser.js
node scripts/test-liquid-controls-browser.js
```
