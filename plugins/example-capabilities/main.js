// 示例插件·二期能力 后端入口
// 演示：provider 格式注册/转换器、供应商选择、API Key 校验/创建回调、
//      计费调整、stats:record 维度、定时任务、KV 存储
async (ctx) => {
  const { on, expose, storage, config, log, cronHandler } = ctx;

  log.info('已加载（二期能力）config =', config);

  // ---- 1. provider:registerFormats：注册一个「mock」上游格式适配器与协议转换器 ----
  // 用 ctx.on 注册（权限 apikey/billing/provider 等在 host 层校验）
  // 适配器类定义在沙箱内（基于注册中心导出的 BaseProviderAdapter）
  on('provider:registerFormats', async (payload) => {
    try {
      // 注册客户端/上游格式 mock：简单的 JSON 回显适配器
      ctx.registerProviderFormat('mock', class MockAdapter {
        constructor(provider) { this.provider = provider; }
        get name() { return this.provider.id; }
        getApiFormat() { return 'mock'; }
        needsTransform(clientFormat) { return clientFormat !== 'mock'; }
        transformRequest(body, clientFormat) {
          if (clientFormat === 'mock') return body;
          return { messages: body.messages || (body.input ? [{ role: 'user', content: body.input }] : []), _converted: true };
        }
        transformResponse(body, clientFormat) {
          if (clientFormat === 'mock') return body;
          return { choices: [{ message: { role: 'assistant', content: body.output_text || 'mock' }, finish_reason: 'stop' }] };
        }
        buildUrl(model) { return `${String(this.provider.base_url || '').replace(/\/$/, '')}/v1/chat/completions`; }
        getAuthHeaders() { return { 'x-api-key': this.provider.api_key || '' }; }
        buildHeaders() { return { 'Content-Type': 'application/json' }; }
      });
      // 注册 openai->mock 协议转换器
      ctx.registerTransform('openai', 'mock', {
        request: (body) => ({ messages: body.messages, _via: 'openai->mock' }),
        response: (body) => ({ choices: body.choices || [], _via: 'mock->openai' }),
      });
      log.info('已注册 mock 格式适配器与 openai->mock 转换器');
    } catch (e) {
      log.error('格式注册失败:', e.message);
    }
    return payload;
  }, -100);

  // ---- 2. apikey:validate：按 IP 时段自定义校验（仅演示：不拒绝任何请求） ----
  on('apikey:validate', async (payload, meta) => {
    await storage.set('last_validate_at', new Date().toISOString());
    // 示例：周一 00:00-06:00 拒绝（仅演示逻辑，实际可改为自定义黑名单）
    const d = new Date();
    if (d.getDay() === 1 && d.getHours() < 6 && config.blockMondayEarly === true) {
      payload.allow = false;
      payload.reason = '插件规则：周一凌晨维护窗口禁止调用';
      payload.status = 403;
    }
    return payload;
  });

  // ---- 3. apikey:created：Key 创建后回调 ----
  on('apikey:created', async (payload, meta) => {
    await storage.set('last_created_key', meta.keyPrefix || '');
    log.info('新 Key 已创建:', meta.keyPrefix, 'user=', meta.username);
  });

  // ---- 4. billing:calculate：按配置倍率调整计费 ----
  on('billing:calculate', async (payload, meta) => {
    const ratio = parseFloat(config.costRatio);
    if (Number.isFinite(ratio) && ratio > 0 && ratio !== 1) {
      payload.cost = payload.cost * ratio;
    }
    return payload;
  });

  // ---- 5. stats:record：为用量记录附加统计维度 ----
  on('stats:record', async (payload, meta) => {
    // 约定 plugin_meta 维度键以 plugin: 开头，前端「插件维度」卡片按此聚合展示
    payload.meta['plugin:example-capabilities'] = meta.provider || 'unknown';
    payload.meta['dim:cost-tag'] = meta.model ? 'model-tracked' : 'none';
    return payload;
  });

  // ---- 6. provider:select：干预候选供应商排序（演示：把名称含 test 的置顶） ----
  on('provider:select', async (payload) => {
    if (Array.isArray(payload.candidates) && payload.candidates.length > 1) {
      payload.candidates = [...payload.candidates].sort((a, b) => {
        const aTest = /test/i.test(String(a.name || a.id));
        const bTest = /test/i.test(String(b.name || b.id));
        if (aTest !== bTest) return aTest ? -1 : 1;
        return 0;
      });
    }
    return payload;
  });

  // ---- 7. cron：每 5 分钟执行一次，写 KV 时间戳 ----
  cronHandler('onTick', async () => {
    const ticks = ((await storage.get('cron_ticks')) || 0) + 1;
    await storage.set('cron_ticks', ticks);
    await storage.set('last_tick', new Date().toISOString());
    log.info('定时任务执行 #', ticks);
  });

  // ---- 自有 API ----
  expose('get', '/overview', async (req, res) => {
    res.json({
      ok: true,
      plugin: ctx.pluginId,
      cronTicks: await storage.get('cron_ticks'),
      lastTick: await storage.get('last_tick'),
      lastValidateAt: await storage.get('last_validate_at'),
    });
  });
}
