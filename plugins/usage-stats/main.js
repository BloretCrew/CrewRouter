// 用量统计示例插件：仅展示三期开放的只读能力
// 整个文件是一个 JS 表达式，求值为 async (ctx) => {...}
(async (ctx) => {
  // 路由：声明 pages:register? 否——示例用 routes:register 暴露一个 JSON 端点
  // 这里不注册路由，只演示 ctx.usage / ctx.models / ctx.pluginMeta 可用
  if (ctx.usage) {
    ctx.log.info('usage:read 可用 — ctx.usage.summary / ctx.usage.models');
  }
  if (ctx.models) {
    ctx.log.info('models:read 可用 — ctx.models.list / ctx.models.health');
  }
  if (ctx.pluginMeta) {
    ctx.log.info('meta:read 可用 — ctx.pluginMeta.get / listAll');
  }
  // 权限不足的应不可用（不抛出，仅提示）
  if (!ctx.fetch) ctx.log.info('（无 network 权限，ctx.fetch 不可用——预期行为）');
})
