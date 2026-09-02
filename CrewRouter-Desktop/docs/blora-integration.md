# Blora Design 2.0 正式接入记录

## 研究证据

截至 2026-09-01，npm registry 可解析并安装 `@bloret-crew/blora-design@2.0.8`。`npm view` 返回：

- `latest`: `2.0.8`；同时存在 `2.0.0` 至 `2.0.8` 稳定版本。
- 包类型为 ESM，入口为 `./dist/index.js`。
- 官方仓库：`https://github.com/BloretCrew/blora-design`，目录为 `packages/blora-design`。
- 官方 README 的引入方式是 `import "@bloret-crew/blora-design/blora.css"`，并可按需使用 `auto`；组件展示使用官方 `.blora-button`、`.blora-card`、`.blora-badge` 等 class 与 `data-variant`。
- npm exports 提供 `./blora.css`、`./tokens.css`、`./tokens.dark.css`、各组件 CSS，以及 `./auto`。
- tarball 的 `files` 包含 `dist/`、`contracts/` 和 `schemas/`，实际发布内容包含生成后的 CSS、ESM 文件和 `blora.global.js`。

## Electron 使用方式

本项目是无打包 renderer 脚本的 Electron `file://` 页面，因此直接以相对 `node_modules` 路径加载 npm 包发布的 CSS：

```html
<link rel="stylesheet" href="../../node_modules/@bloret-crew/blora-design/dist/blora.css">
<link rel="stylesheet" href="../../node_modules/@bloret-crew/blora-design/dist/tokens.dark.css">
```

同时按页面实际使用的公开 class 加载 card、badge、input、button CSS。没有使用 CDN，也没有执行运行时初始化。`electron-builder` 的 `files` 保留 `src/**/*` 和 `package.json`，官方包是 production dependency，构建时会将其依赖资源放进应用的 asar；测试会检查包解析、CSS 文件存在和打包清单中的依赖资源。

Blora 2.0 包自身为 ESM，但本页面只加载官方 CSS，不在 CommonJS renderer 中直接 `import`，所以不需要额外的 file:// ESM loader 或构建步骤。官方包提供 `auto` 和全局 IIFE，但本页面没有使用它们，因为启动页只需要 CSS 组件能力。

## 迁移边界

- 页面按钮使用官方 `.blora-button` + `data-variant="primary|secondary"` + `data-block`。
- 卡片使用官方 `.blora-card` + `data-variant="content"`。
- 输入框、徽标和 token 均由官方 CSS 提供；`src/renderer/styles.css` 只保留页面布局和语义排版，不声明自有 `--blora-*` token。
- 没有使用 1.x 的 `blora-btn`、`blora-btn--primary`、`Blora.init()` 或 UMD `blora.js`。没有引入 Lucide；图标仍遵循原项目 SF Symbols 约定。
- Local/Remote 流程、元数据、认证、安全 IPC 和 URL policy 未改变。

## 可验证性与风险

无网络时，已安装依赖的 CSS 位于应用包内，页面不依赖 CDN 才能获得核心样式。SF Symbols 图片仍是原有的远程增强资源，图片失败时保留本地字符 fallback；这不影响 Blora 核心 CSS/token。

Linux 构建环境可以验证 Linux AppImage。Windows NSIS 和 macOS DMG 仍需各自原生 CI runner 验证。若 `file://` 环境或未来 electron-builder 版本改变依赖文件布局，应优先通过构建产物检查修正资源路径，而不是复制官方 CSS 到项目中。
