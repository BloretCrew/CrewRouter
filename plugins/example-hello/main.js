// 示例插件后端入口：整个文件求值为 async (ctx) => { ... }
// ctx 提供：on（钩子）、expose（自有 API）、storage（KV）、log、config、fetch
async (ctx) => {
  ctx.log.info('已加载，config =', ctx.config);

  // 网关钩子演示：每次上游请求前记录 UA 并附加自定义头
  ctx.on('gateway:beforeUpstream', async (payload, meta) => {
    const ua = payload.headers?.['user-agent'] || payload.headers?.['User-Agent'] || '(无)';
    ctx.log.info(`beforeUpstream provider=${meta.provider?.id} model=${meta.model} ua=${String(ua).slice(0, 120)}`);
    if (payload.headers && payload.headers['x-plugin-example'] === undefined) {
      payload.headers['x-plugin-example'] = 'hello-from-example-hello';
    }
    return payload;
  });

  // 自有 API：POST /api/plugins/example-hello/visit —— KV 访问计数 +1
  ctx.expose('post', '/visit', async (req, res) => {
    const n = ((await ctx.storage.get('visits')) || 0) + 1;
    await ctx.storage.set('visits', n);
    res.json({ ok: true, visits: n });
  });

  // 自有 API：GET /api/plugins/example-hello/hello
  ctx.expose('get', '/hello', async (req, res) => {
    res.json({ ok: true, plugin: ctx.pluginId, version: ctx.version, message: 'Hello from CrewRouter plugin!' });
  });
}
