# ModelTrace 浏览器验收

最终运行时间：2026-10-13 09:41:47 UTC（17:41:47 UTC+8）。

## 结果

使用 `scripts/test-model-trace-browser.js` 的隔离 demo 服务器与临时 CDP Chrome profile，最终同一次运行退出码为 0。

| viewport | 通过 | 失败 | 场景错误 |
| --- | ---: | ---: | ---: |
| 1440×900 | 45 | 0 | 0 |
| 1024×720 | 45 | 0 | 0 |
| 390×844 | 45 | 0 | 0 |
| 合计 | 135 | 0 | 0 |

每个 viewport 独立重置 fixture。每轮准确创建 4 次任务（4 次显式确认创建 POST），取消 2 次（2 次显式确认取消 POST）；完成与失败任务各推进 3 条模拟挑战，共 6 次模拟 probe。取消后推进不会产生新 probe。真实上游入口请求数为 0。

## 真实交互覆盖

- HTML 模块加载、真实 vendor ESM 手动计算、挑战复制；空回答、拒答/短序列、1/2/3 份有效回答；重新生成取消与确认清空。
- 真实选择 Key、启动费用确认取消/确认；模型库更多菜单真实进入归因；关闭对话框后任务仍显示运行状态。
- 跨页返回、重复打开、Escape、刷新恢复不额外创建任务；完成排行与恶意模型名、候选名、失败详情转义。
- 历史查看、实际下一页/上一页 GET；空历史、partial 部分有效、interrupted 执行中断。
- 取消确认拒绝不产生取消 POST；确认取消显示 canceled，并停止后续模拟 probe。
- 多归因任务与总结同时显示、单任务通知关闭不删除其他卡片；总结真实复制读取剪贴板、跳转原会话。
- 查询暂不可用与恢复，不重建任务；真实遮罩点击只关闭界面。
- 独立供应商管理菜单真实进入；个人版 iframe 菜单真实进入、iframe 内费用确认真实点击启动，关闭后父模型库顶部同步，父页面取消同一任务。
- Team / Personal / Desktop Local 的 TEAM / PERSONAL / LOCAL 徽章与同一次 `/api/instance` 响应一致；最终 viewport 无横向溢出。

## Fixture 与边界

- 自动任务采用 fixture 服务端 `advanceProbe` 控制推进，消除交互耗时与固定 timer 的竞争。测试没有修改前端 ModelTrace 状态、调用其内部方法或替代算法。
- 手动归因使用发布 vendor ESM 和真实 bank 文件；自动任务是合成结果，不验证归因准确率。
- API bank 摘要使用真实 metadata 和 candidates；自动结果采用后端 `result.results` / `family_probabilities` / `used_outputs` 结构；目标 Key 采用 `id`、`key_id`、`label`、`enabled` 结构。
- API 存储是隔离内存 fixture，不验证生产 runner、数据库、计费、权限、真实取消传输或真实模型识别。
- 版别徽章通过隔离路径原样服务真实登录 HTML，只有该页 `/auth/me` 使用未登录 fixture，避免 demo 根路径展示 showcase、自动跳转与缺失 Desktop bridge 的干扰；这仅验证徽章资源与 API 一致性，不代表 Desktop 原生窗口/bridge 验收。曾在缺 bridge 的 desktop-local 管理/控制台 fixture 下遇到 renderer/CDP 超时，不据此声称该环境通过。
- 前期真实点击发现的手动 ESM 签名、模型库菜单白名单及移动菜单层叠问题由主 agent 修复；最终运行包含修复后的真实业务入口。

## 复现

分别以后台任务启动 `node scripts/test-model-trace-browser.js --server`、`node scripts/test-model-trace-browser.js --chrome`，健康检查 demo API 与 CDP 后执行 `node scripts/test-model-trace-browser.js`。默认端口为 18771/18772，可通过 `BLORA_TEST_URL`、`BLORA_CDP_URL` 配置；`MODEL_TRACE_OUTPUT` 配置报告目录，`MODEL_TRACE_WIDTHS` 可限定复测宽度。

运行产生 JSON 与截图，最终统计为 135 passed、0 failed、0 errors。完成后所有自建服务器、Chrome、临时配置/profile、已识别历史运行日志与报告 scratch 已清理；本文件保留汇总，不保留临时截图与原始日志。未发起真实供应商请求，未修改生产配置或数据库，未进行 Git 提交。
