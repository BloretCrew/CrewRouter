# Liquid Glass 设计（控制台）

控制台正在从 Blora 外观迁移到 Apple Liquid Glass 风格。设计直接复用
`/data/HTML-Clock/index.html`（Liquid Glass Clock）的材质令牌与组件做法，
再按 Apple Liquid Glass 与系统色校准。迁移按页面进行，一页一次提交。

## 文件

| 文件 | 作用 |
| --- | --- |
| `public/css/liquid-glass.css` | 令牌、可复用材质、Blora 令牌桥接、组件皮肤、控制台壳层、无障碍降级 |
| `public/css/model-library-console.css` | 模型库页面布局与材质层级 |

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

## 与旧样式的优先级

`console-blora.css` 未分层，并直接写了 `background`、`border-radius`、输入框边框
（`.blora-page input:not(...)×3`）。基础皮肤因此写实际属性而不只是改 Blora 变量，
并使用同等或更高的特异性，靠加载顺序胜出。迁移新页面时如果组件颜色没变，
先检查是否被 `console-blora.css` 的同名规则覆盖。

## 迁移进度

1. 模型库 `#modelLibraryPage` — 已完成
2. 我的上游 `#myUpstreamPage` — 下一步
3. 其余页面按侧栏顺序继续：API Key 与用量、统计信息、项目工作、排行榜……

## 新页面迁移清单

1. 容器加 `lg-page`，弹层加 `lg-scope`。
2. 页面 CSS 只写布局与材质层级，组件外观交给 `liquid-glass.css`；
   需要新组件皮肤时加到基础文件，供后续页面复用。
3. 去掉页面内的旧背景色（页面容器不能盖住背景光斑）。
4. 浅色 / 深色、1440 / 820 / 390 宽度截图检查；打开菜单与下拉检查层级与可读性。
5. 运行相关浏览器测试，与迁移前结果对比。

## 验证

```sh
# 演示服务与无头 Chrome（隔离数据，不连生产库）
BLORA_TEST_URL=http://127.0.0.1:18481 node scripts/verify-blora-2.1-browser.js --server
node scripts/test-agent-model-library-browser.js
node scripts/test-client-config-browser.js
```

`test-library-sticky-alignment-browser.js`、`test-model-card-badges-browser.js`、
`test-inject-uptime-menu-browser.js`、`test-library-closed-keys-browser.js`、
`test-provider-quota-layout-browser.js`、`test-cpa-quota-browser.js` 在迁移前已在同一断言失败，
迁移后结果相同。
