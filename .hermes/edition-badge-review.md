# `efbef8f` 版本标签实现复审更新

## Issue 状态

- Issue 1：**fixed**。已覆盖全部审查列出的正式品牌页面：`index.html`、`showcase.html`、`console.html`、`admin.html`、`playground.html`、`store.html`、`data.html`、`setup.html`、`feishu-bind.html`、`oauth-consent.html`、`purchase.html`、`set-password.html`、`plugin-install.html`。插件安装页新增轻量品牌行；其余页面沿用现有品牌容器。
- Issue 2：**fixed**。setup 选择 edition 成功后调用 `CrewRouterEditionBadge.refresh(data)`，使用初始化接口返回的安全 metadata 立即显示标签；未初始化或接口失败时保持隐藏。
- Issue 3：**not changed / out of scope**。本次仅修复前端 badge 展示闭环，不扩展 `/api/instance` 的完整 bootstrap schema；badge 只依赖已存在且公开的 `runtime`、`edition` 字段。
- Issue 4：**fixed**。共享脚本保留唯一自动挂载责任，`app.js` 与 `admin.js` 不再重复 mount；请求 Promise 仍缓存，`mount()` 对相同 label 幂等。
- Issue 5：**fixed**。badge 使用主题变量并提供静态颜色 fallback；600px 下 store/data 品牌导航允许收缩/换行。已用真实 Playwright Chromium 验收桌面与 600px 页面，并生成浅色/深色截图。
- Issue 6：**fixed**。测试覆盖全部正式页面的节点、脚本和样式，覆盖 LOCAL 优先级、PERSONAL/TEAM、未知值、注入字段、失败隐藏和重复 mount 幂等语义。
- Issue 7：**fixed**。保留白名单和 `textContent`，全部品牌容器统一使用 `.brand-edition-badge`；静态测试覆盖页面接入，浏览器截图验证可见文本、主题和窄屏布局。

## 实现总结

统一组件 `public/js/edition-badge.js` 复用 `/api/instance`，按 `desktop-local`、`personal`、`team` 顺序解析固定 badge。共享脚本在 DOMContentLoaded 后自动挂载，应用页面只消费同一缓存实例；setup edition 初始化成功后通过 `refresh()` 更新缓存并显示结果。公共样式提供 fallback 颜色、深色覆盖及 600px 下品牌行的收缩/换行规则。

## 验证记录

- `node --check public/js/app.js`
- `node --check public/js/admin.js`
- `node --check public/js/edition-badge.js`
- `node server/scripts/test-edition-badge.js`
- `node server/scripts/test-request-source.js`
- 静态页面覆盖与 CSS fallback 检查
- 隔离临时服务：`127.0.0.1:23103`（TEAM）和 `127.0.0.1:23104`（PERSONAL），均为 Python 静态服务，无生产端口、数据库或配置文件
- Playwright Chromium 实际访问 `/store`，验证 badge 文本与 computed display，并生成截图：
  - `.hermes/screenshots/edition-badge-team.png`
  - `.hermes/screenshots/edition-badge-team-600px.png`
  - `.hermes/screenshots/edition-badge-personal.png`

`node server/scripts/test-usage-accuracy.js` 仍受当前环境缺少 `pg` 模块影响，未能执行；未修改生产依赖。
