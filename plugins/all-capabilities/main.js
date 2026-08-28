// 全能力示例插件 后端入口
// 逐项演示插件系统全部权限与钩子；每个能力都在日志中标注「[能力名] 可用/被拒」
async (ctx) => {
  const { log } = ctx;
  log.info('全能力示例插件加载，开始逐项验证能力…');

  // ---- storage：KV 读写 ----
  if (ctx.storage) {
    try {
      await ctx.storage.set('demo_key', { hello: 'all-capabilities', at: new Date().toISOString() });
      const v = await ctx.storage.get('demo_key');
      log.info('[storage] 可用 demo_key =', JSON.stringify(v));
    } catch (e) {
      log.error('[storage] 调用失败:', e.message);
    }
  } else {
    log.warn('[storage] 被拒（未授予 storage 权限）');
  }

  // ---- network：受控外网访问（仅标注，不真发请求） ----
  if (ctx.fetch) {
    log.info('[network] 可用（ctx.fetch 存在；演示不发真实请求）');
  } else {
    log.warn('[network] 被拒（未授予 network 权限）');
  }

  // ---- gateway:modify：responseChunk 原样返回 + finalResponse 加响应头 ----
  if (ctx.on) {
    try {
      ctx.on('gateway:responseChunk', async (payload) => payload);
      ctx.on('gateway:finalResponse', async (payload) => {
        payload.headers['X-Plugin-AllCap'] = 'demo';
        return payload;
      });
      log.info('[gateway:modify] 可用（已注册 responseChunk / finalResponse）');
    } catch (e) {
      log.warn('[gateway:modify] 被拒:', e.message);
    }

    // ---- billing:modify：计费钩子原样返回 ----
    try {
      ctx.on('billing:calculate', async (payload) => payload);
      log.info('[billing:modify] 可用（已注册 billing:calculate）');
    } catch (e) {
      log.warn('[billing:modify] 被拒:', e.message);
    }

    // ---- apikey:modify：Key 校验钩子原样返回 ----
    try {
      ctx.on('apikey:validate', async (payload) => payload);
      log.info('[apikey:modify] 可用（已注册 apikey:validate）');
    } catch (e) {
      log.warn('[apikey:modify] 被拒:', e.message);
    }

    // ---- stats:record：向统计维度注入 allCapDemo ----
    try {
      ctx.on('stats:record', async (payload) => {
        payload.meta = payload.meta || {};
        payload.meta.allCapDemo = 'on';
        return payload;
      });
      log.info('[stats:record] 可用（已注册 stats:record，注入 allCapDemo 维度）');
    } catch (e) {
      log.warn('[stats:record] 被拒:', e.message);
    }
  }

  // ---- provider:register：仅标注接口可用，不真注册（避免污染全局） ----
  if (ctx.registerProviderFormat && ctx.registerTransform) {
    log.info('[provider:register] 可用（registerProviderFormat / registerTransform 存在；演示不真注册自定义格式）');
  } else {
    log.warn('[provider:register] 被拒（未授予 provider:register 权限）');
  }

  // ---- usage:read：近 7 天用量聚合 ----
  if (ctx.usage) {
    try {
      const s = await ctx.usage.summary({ days: 7, groupBy: 'day' });
      log.info('[usage:read] 可用 summary(days=7) 行数 =', (s.rows || []).length);
    } catch (e) {
      log.error('[usage:read] 调用失败:', e.message);
    }
  } else {
    log.warn('[usage:read] 被拒（未授予 usage:read 权限）');
  }

  // ---- models:read：模型目录 ----
  if (ctx.models) {
    try {
      const list = await ctx.models.list();
      log.info('[models:read] 可用 models.list() 条数 =', (list || []).length);
    } catch (e) {
      log.error('[models:read] 调用失败:', e.message);
    }
  } else {
    log.warn('[models:read] 被拒（未授予 models:read 权限）');
  }

  // ---- preferences:read：需用户授权，仅标注接口存在 ----
  if (ctx.preferences) {
    log.info('[preferences:read] 可用（ctx.preferences.get/granted 存在；实际读取需用户在设置页授权）');
  } else {
    log.warn('[preferences:read] 被拒（未授予 preferences:read 权限）');
  }

  // ---- audit:write：写一条插件审计日志 ----
  if (ctx.audit) {
    try {
      await ctx.audit.write({
        description: '全能力示例插件加载，写入演示审计记录',
        details: { plugin: ctx.pluginId, at: new Date().toISOString() },
      });
      log.info('[audit:write] 可用（已写入一条演示审计日志）');
    } catch (e) {
      log.error('[audit:write] 调用失败:', e.message);
    }
  } else {
    log.warn('[audit:write] 被拒（未授予 audit:write 权限）');
  }

  // ---- export:usage：用量导出 ----
  if (ctx.exportUsage) {
    try {
      const out = await ctx.exportUsage.json({ days: 1 });
      log.info('[export:usage] 可用 exportUsage.json(days=1) exportedAt =', out.exportedAt);
    } catch (e) {
      log.error('[export:usage] 调用失败:', e.message);
    }
  } else {
    log.warn('[export:usage] 被拒（未授予 export:usage 权限）');
  }

  // ---- meta:read：读取本插件注册信息 ----
  if (ctx.pluginMeta) {
    try {
      const meta = await ctx.pluginMeta.get('all-capabilities');
      log.info('[meta:read] 可用 pluginMeta.get:', meta ? `id=${meta.id} version=${meta.version || '-'}` : 'null');
    } catch (e) {
      log.error('[meta:read] 调用失败:', e.message);
    }
  } else {
    log.warn('[meta:read] 被拒（未授予 meta:read 权限）');
  }

  // ---- admin:view：管理面板只读视图 ----
  if (ctx.adminView) {
    try {
      const plugins = await ctx.adminView.plugins();
      log.info('[admin:view] 可用 adminView.plugins() 条数 =', (plugins || []).length);
    } catch (e) {
      log.error('[admin:view] 调用失败:', e.message);
    }
  } else {
    log.warn('[admin:view] 被拒（未授予 admin:view 权限）');
  }

  // ---- webhook:register：白名单内注册 + 白名单外被拒演示 ----
  if (ctx.registerWebhook) {
    try {
      const r = await ctx.registerWebhook({
        url: 'https://webhook.bloret.net/hooks/all-capabilities-demo',
        events: ['demo.heartbeat'],
      });
      log.info('[webhook:register] 可用 注册成功 host =', r.host);
    } catch (e) {
      log.error('[webhook:register] 白名单内注册失败:', e.message);
    }
    try {
      await ctx.registerWebhook({ url: 'https://not-allowed.example.org/hook' });
      log.warn('[webhook:register] ⚠️ 白名单外域名居然注册成功（不应发生）');
    } catch (e) {
      log.info('[webhook:register] 白名单外域名被正确拒绝:', e.message);
    }
  } else {
    log.warn('[webhook:register] 被拒（未授予 webhook:register 权限）');
  }

  // ---- routes:register：自有 HTTP API ----
  if (ctx.expose) {
    try {
      ctx.expose('get', '/ping', async (req, res) => {
        res.json({ ok: true, plugin: ctx.pluginId, pong: true, at: new Date().toISOString() });
      });
      ctx.expose('get', '/usage', async (req, res) => {
        const summary = ctx.usage
          ? await ctx.usage.summary({ days: 7, groupBy: 'day' })
          : { error: 'usage:read 未授予' };
        const prefs = ctx.preferences
          ? await ctx.preferences.get(req)
          : { granted: false, reason: 'preferences:read 未授予' };
        res.json({ ok: true, plugin: ctx.pluginId, summary, preferences: prefs });
      });
      log.info('[routes:register] 可用（已登记 GET /ping、GET /usage）');
    } catch (e) {
      log.warn('[routes:register] 被拒:', e.message);
    }
  } else {
    log.warn('[routes:register] 被拒（未授予 routes:register 权限）');
  }

  // ---- cron:register：每 15 分钟心跳，触发 demo.heartbeat webhook ----
  if (ctx.cronHandler) {
    try {
      ctx.cronHandler('heartbeat', async () => {
        const delivered = ctx.webhook
          ? await ctx.webhook.emit('demo.heartbeat', { ok: true })
          : { delivered: 0 };
        log.info('[cron:register] heartbeat 执行，demo.heartbeat 投递', delivered.delivered, '个 webhook');
      });
      log.info('[cron:register] 可用（已登记 heartbeat 处理器，*/15 * * * *）');
    } catch (e) {
      log.warn('[cron:register] 被拒:', e.message);
    }
  } else {
    log.warn('[cron:register] 被拒（未授予 cron:register 权限）');
  }

  log.info('全能力示例插件能力验证完毕');
}
