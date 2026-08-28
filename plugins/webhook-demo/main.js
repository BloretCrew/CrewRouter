// Webhook 出站示例插件
// 演示 webhook:register 权限配套的 ctx.registerWebhook / ctx.webhook.emit
(async (ctx) => {
  // 注册一个到白名单域（allowedHosts）的 webhook，事件 demo.heartbeat
  if (ctx.registerWebhook) {
    try {
      const r = await ctx.registerWebhook({
        url: 'https://webhook.bloret.net/hooks/crewrouter-demo',
        events: ['demo.heartbeat'],
        secret: 'demo-secret-1',
      });
      ctx.log.info(`webhook 注册成功: host=${r.host}`);
    } catch (e) {
      ctx.log.error(`webhook 注册失败: ${e.message}`);
    }
  }

  // cron 处理器：定时 emit 一次 demo.heartbeat（被 /plugins/webhook-demo/plugin.json cron 引用）
  if (ctx.cronHandler) {
    ctx.cronHandler('demoEmit', async () => {
      const delivered = await ctx.webhook.emit('demo.heartbeat', { ok: true, ts: Date.now() });
      ctx.log.info(`demo.heartbeat 已投递 ${delivered.delivered} 个 webhook`);
    });
  }

  // 安全演示：白名单外域名应被拒
  if (ctx.registerWebhook) {
    try {
      await ctx.registerWebhook({ url: 'https://evil.example.org/hook' });
      ctx.log.warn('⚠️ 白名单外域名居然注册成功（不应发生）');
    } catch (e) {
      ctx.log.info(`白名单外域名被正确拒绝: ${e.message}`);
    }
  }
})
