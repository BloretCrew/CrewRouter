# Blora 2.1.0 最新最终检查

执行区间：2026-10-01 12:32:35—12:35:51（UTC+08:00）。Node.js v24.13.1，npm 11.16.0。本报告仅采用这次最终实跑结果，不沿用先前构建/语法通过结论。

## 结果摘要

| 检查 | 最新实际结果 |
| --- | --- |
| 9 项 Blora 脚本 | 9/9 退出 0。 |
| public/js + server/scripts + scripts 完整语法 | 89/89 退出 0：public/js 19（18 业务、1 vendor）、server/scripts 49、scripts 21。services 以 ESM 解析；.bak 不计业务文件。 |
| server/routes/oauth.js 额外语法 | 退出 0。 |
| 无真实 DB server 套件 | 本轮共 34 项执行，32 通过、2 失败；最终 Batch B 修改后两项失败另行复跑，详见下文。 |
| npm run build | release 全流程退出 0；98.3 秒，6.68 MB；bundle 2198.3 KB。block_until_ms=0 启动并等待实际完成。 |
| 完整源码集合前后快照 | 336 文件 → 336 文件；新增 0、删除 0、SHA-256 内容变化 0。 |
| public 与 dist/public 产物一致性 | 84/84 文件一致，缺失/额外/内容变化均 0。 |
| 产物语法 | dist/public/js 全部 19 个 .js 和 dist/server.js 均退出 0。 |
| 生产包依赖 | 全部 dependencies 与根包一致，Blora 为固定 2.1.0。 |
| 本轮修改 diff 空白检查 | 退出 0。 |

9 项通过：test-blora-foundation、test-blora-audit-parser、test-blora-http、test-blora-public-batch-a、test-blora-public-batch-c、test-no-legacy-dialog、test-blora-dialog-results、verify-blora-public-batch-a、verify-blora-navbar-runtime。具体退出码见 check-blora-results.json，每项完整原文见 check-*.log。

Batch C 实际执行全部原有 SSE 成功/失败/超时/断开、计费 spy、不可变重试 payload 断言及生产 Card 浏览器 Enter/Space 绑定、名称选择、队列、禁用/已绑定保护。Dialog 返回值测试 5 用例通过。公共控件使用当前真实语言/主题/nav 结构与官方 2.1.0 CE。未以构建成功替代行为测试。

## Batch B 本轮公共契约更新及保留失败

仅修改 `server/scripts/test-blora-console-batch-b.js` 的官方 Dialog 契约验证：

- 从官方 contracts/dialog.contract.json 读取 tagName 和 default/title/footer 公共 slots。
- 不再要求手写 `.blora-dialog__panel`。抽取当前 console 的实际对话框 HTML，加载生产 blora-dialog.js 适配器及官方 2.1.0 CE，用浏览器验收所有对话框的公开 title slot、原有 footer 的 footer slot、官方 CE 注册和 legacy overlay 移除。footer 按官方契约允许为空，因此只要求页面原本具有 footer 的对话框完成槽位迁移。
- 没有检查 shadowRoot；所有业务名称、加载/空/错误状态、URL/颜色/JS 字符串安全 marker 和处理器断言原样保留。keyModelsModalContent 必须继续存在，不再强求内部 panel 类。

实际公共 slots/CE 验证通过，但整个 Batch B **仍退出 1**，在 `server/scripts/test-blora-console-batch-b.js:54` 的旧精确 marker `class="blora-button btn btn-sm btn-secondary model-test-btn` 处失败，当前 app.js 已无该旧类组合。没有删掉该 marker，也没有降低规则让测试假通过；后续安全 marker 和可执行边界用例因前置失败被阻断，不能认定完整 Batch B 已通过。

另一项失败：`server/scripts/test-instance-edition.js:57` 要求 admin 页面存在 `data-page="adminUserGroups" data-capability="teamMembers"`，实际缺失。按委派要求保留这个既有未提交合并状态相关失败，未改测试、未补导航、未修改权限逻辑。前置纯能力/guard 验证已执行，但后续断言未完整执行。

两项完整日志：check-test-blora-console-batch-b.log、check-test-instance-edition.log。34 项退出码记录在 check-server-results.json。其余 32 项通过：agent-images、batch-e-permissions、before-upstream-policy、client-events、codex-quota-refresh、config-center、crewrouter-command、custom-instructions、edition-badge、email-toctou-static、financial-usage-static、frontier-auto-add、gateway-body-parser、inject-append、inject-scrub、instance-edition-persistence、message-analysis、money-precision、multi-dimension-stats、outbox、reliability-closure-static、request-lifecycle、request-policy、request-semantics、request-source、session-classification-static、session-identity、stream-and-compaction、summary-errors、task5a-static、upstream-url、fusion-synthesis-prompt。

## 完整稳定性范围与产物

在最终测试前及生产构建/产物检查后，重新枚举并 SHA-256 对比完整文件集合，而非仅比较旧列表：

- public/：84 文件，含全部 CSS、页面、JS、plugin-runtime、shared Dialog。
- plugins/：30 文件。
- server/：220 文件，含 server/plugins/ 的 5 文件、server/blora-resources.js、server/routes/oauth.js、所有 routes/utils/scripts。
- 根 package.json、package-lock.json：2 文件。
- 排除第三方 node_modules，不读取/记录凭证内容；快照只保存路径与哈希。

上述共 336 个文件在测试到构建结束期间无新增、删除、内容变化；父代理最新 OAuth 错误页与 shared Dialog 已处于本轮基线内。dist/ 已确认无 Git 跟踪文件且被忽略，由既有 build 清理/重建。84 个 public 静态文件与 dist/public 精确集合及字节哈希一致；生产依赖与根包一致。server bundle 已完成 esbuild/混淆并通过产物语法检查，未启动服务器；不声称混淆产物与源码逐字节相同或完整服务运行验收通过。

证据：check-source-scope.json、check-build-source-before.json、check-build-source-after.json、check-build-source-stability.json、check-build-artifact.json、check-build-artifact.log、check-build-release.log、check-build-release.exit。

## 隔离、工具缺失与操作边界

- 无 DB 套件为文件静态读取、纯函数、显式 fakeDb 或隔离 VM；Codex quota/gateway 测试仅独立本地 HTTP fixture。Batch B 只加载页面对话框片段和官方/共享前端脚本，不启动 server/index，不访问生产 API。没有真实数据库查询或生产写入。
- 未运行可能加载真实 DB 的 agent-tools、attribution-affinity-cache、auth-mode、plugin-capabilities、quick-add-provider、quota-usage、session-summary-model-selection、sessions-pagination、usage-accuracy；其语法仍全部扫描留档。未运行全应用 Electron 或其他代理 demo 浏览器任务。
- 根项目无 typecheck/lint 脚本或根业务 ESLint/Biome/tsconfig；未安装额外工具，不能报告类型/lint 通过。89 文件结果仅为 JS 语法，其中所有 49 个 server/scripts 的语法均通过，未忽略测试脚本字符串错误。逐文件原文及结果：check-all-js-syntax.log/json。
- 本轮仅修改允许的 Batch B 测试契约及 audit 检查证据，没有修改业务源码或 test-instance-edition。未 git add、未 commit、未改父代理 partial staged 的 Git index。
- 未创建通用 scratch；新增 Batch B 浏览器探针在 finally 中清理专属 mkdtemp，其他现有 Card/navbar 测试同样自行清理。已检查本轮 `crewrouter-blora-batch-b-*` 无遗留，不删除其他代理 scratch/审计证据。

## 主代理末次修正与复验

Batch B 新版可执行危险操作检查发现 `deleteMyTeamModel` 按钮为 secondary；已仅将其公开变体改为 danger，接口、事件和权限保持。`check-test-blora-console-batch-b-final.log` 显示全部公开槽位、静态状态、安全转义、Checkbox/change/select-all 与 Dropdown/action 用例通过。旧 Batch B 失败已被此末次结果替代。

修正后再次 `npm run build` 退出 0，110.2 秒，6.68 MB；见 `build-after-danger-fix.log` 与 `.exit`。完整消费业务 CLI lint 仍为 0 errors、264 warnings，逐条见 consumer-warning-dispositions.md。instance-edition 既有团队合并断言失败继续保留；真实数据库及授权端到端限制继续保留。

该最后一处 app.js 变更使正在运行的全站浏览器快照存在变化，必须结合末次定点浏览器复验及源码变化记录，不能将旧稳定快照直接视为最后发布验收。
