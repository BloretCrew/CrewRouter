# Blora 2.1.0 静态测试与生产构建检查

检查时间：2026-10-01 12:03（UTC+08:00）。其他代理仍并发修改页面，结果仅对应实际执行时的工作区，不代表后续变更。执行环境：Node.js v24.13.1、npm 11.16.0。

## 范围与安全

- 已读取根 package.json、相关 scripts 验证及 deploy/build 构建脚本。根依赖和实际安装均为 `@bloret-crew/blora-design@2.1.0`。
- 仅修改四个现有验证脚本的固定 2.0.8 版本字符串/正则为 2.1.0：test-blora-http.js、test-blora-public-batch-a.js、test-blora-public-batch-c.js、verify-blora-public-batch-a.js。未删断言、未放松规则。
- 未覆盖父代理修改的 scripts/test-blora-foundation.js，未修改业务源码，未提交 Git。
- 已运行测试仅使用文件读取、VM/纯函数、独立本地 HTTP 静态服务；没有加载 server/index.js 或数据库连接模块，没有执行数据库测试或写生产数据库。Batch C 计费验证使用 usageSpy 而不是数据库。
- 执行构建前确认 dist/ 没有 Git 跟踪文件，受 .gitignore 的 dist/ 规则忽略；内容为 server.js、public/、lang/、生产 package.json 和 config.example.json。由现有 build-release.js 正常清理并重建，未额外删除其他目录。

## 实际结果

| 检查 | 最终结果 | 说明 |
| --- | --- | --- |
| npm run test:blora-foundation | 失败，退出 1 | foundation 第 25 行固定页面数 13，实际 14，报 `14 !== 13`；组合任务中的 parser、HTTP 因 `&&` 未执行，另行独立执行并通过。 |
| node scripts/test-blora-audit-parser.js | 通过，退出 0 | HTML 扫描与内联脚本/样式排除回归通过。 |
| node scripts/test-blora-http.js | 通过，退出 0 | 2.1.0 ESM 导入、CSS 图、资源路由、MIME、长缓存、404/路径越界检查通过。 |
| npm run test:blora-public-batch-a | 失败，退出 1 | test-blora-public-batch-a.js 第 17 行要求 `<blora-navbar ... variant="floating">`，当前 index.html 无 navbar；独立 HTTP wrapper 先执行该静态测试，故 HTTP 部分未进入。最终重跑 wrapper 仍退出 1。 |
| npm run test:blora-public-batch-c | 失败，退出 1 | test-blora-public-batch-c.js 第 32 行要求 `<button type="button" class="model-library-item"`；当前模型条目模板为 `<div class="blora-card model-library-item ..." ... onclick=...>`（public/js/app.js 约第 11046 行）。不是单纯新增 class：元素类型也变为 div，因此没有改松该规则。后续 SSE/重试行为断言被前置失败阻断，不能声称完整通过。 |
| npm run test:no-legacy-dialog | 通过，退出 0 | Fluent 依赖/锁文件及旧 dialog 入口排除、官方 dialog 适配器断言通过。 |
| npm run test:blora-navbar-runtime | 失败，退出 1 | verify-blora-navbar-runtime.js 第 14 行 `index.html: navbar exists`；在调用 Chromium 前即失败，不是浏览器缺失。最终独立复跑同样失败。 |
| node scripts/audit-blora-pages.js | 通过，退出 0（非准入断言） | 14 页均加载 foundation；controls/nativeDialogs/forms/tables/states = 599/0/17/14/139；旧 modal 容器、dialog 脚本/API 均 0。输出 runtime 为 conservative-unobserved/not-observed；脚本读取已有证据显示 13/14 页，不能据此认定本轮浏览器验收通过。未用 --write 覆盖既有审计。 |
| public/js 全部实际业务 JS：node --check | 最终 18/18 通过 | 递归检查 .js，排除 vendor/marked.min.js（第三方）及 admin.js.bak（备份）。首轮 store.js:209 报 `SyntaxError: Unexpected identifier '加载失败'`；其他代理修复后，于 12:02:55 后复跑全部业务文件均通过，本检查未修改该源码。 |
| npm run build | 通过，退出 0 | 用 block_until_ms=0 启动并等待实际完成；release 全流程 esbuild、混淆、复制资源、生成生产依赖、清理均完成。耗时 59.0 秒，产物 6.73 MB，bundle 2198.3 KB。 |
| node --check dist/server.js | 通过，退出 0 | 只做产物语法检查，未启动服务器。 |
| node --check dist/public/js/store.js | 通过，退出 0 | 构建复制到产物的 store.js 语法有效。 |
| dist/package.json 依赖版本 | 2.1.0 | 构建生成的生产依赖锁定版本正确。 |
| git diff --check（本轮四个验证脚本） | 通过，退出 0 | 无空白错误。 |

业务 JS 清单：admin.js、app.js、blora-agent.js、blora-dialog.js、blora-foundation.js、blora-services.js、dom.js、edition-badge.js、i18n.js、multi-dimension-chart.js、oauth-consent.js、playground-state.js、playground.js、plugin-runtime.js、session-tool-groups.js、store.js、theme.js、usage.js。

首轮未更新验证版本时 Batch A/C 都因 2.0.8 与页面 2.1.0 不符失败；严格更新版本后才暴露上述 navbar 和模型条目规则失败。foundation 页面计数首轮和复跑均失败，保留父代理文件不覆盖。

## 类型与 lint 缺失

根 package.json 没有 test 总入口、typecheck、check-types、lint 或 ESLint/Biome 脚本；根 devDependencies 仅 esbuild、javascript-obfuscator、nodemon。没有适用于根业务的 tsconfig/ESLint/Biome 配置。独立源码目录（如 blora-design 等）的配置不作为根 CrewRouter 的类型/lint 结果。本轮未安装额外工具、未伪造类型或 lint 通过。`node --check` 仅语法检查，esbuild 打包也不等价于类型检查、lint 或浏览器运行时验证。

## 证据与限制

本执行器原始日志位于 `/tmp/crewrouter-blora-checks/`：build.log、syntax.log、final-syntax.log、initial-*.log、final-*.log、npm_run_test_*.log、navbar.log。最终业务 JS SHA-256 快照为 final-business-sha256.txt。未覆盖 audit/blora-2.1 下其他代理生成的 browser.log、results.json、manifest.json、截图或既有测试日志。

本轮没有运行数据库集成测试、全应用 Electron test:blora-runtime 或其他代理的 verify-blora-2.1-browser.js；前两者超出本次静态/构建执行范围，全应用测试不得在未确认隔离前直接运行。构建成功不掩盖仍存在的静态验证失败，也不证明并发后续变更已验证。
