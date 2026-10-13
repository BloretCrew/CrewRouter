'use strict';

const express = require('express');
const { createStore, keyId, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } = require('../utils/model-trace-store');
const { createRunner } = require('../utils/model-trace-runner');

function uuid(value) { return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value); }

function createRouter({ pool, getKeys, loadCore, loadBank, transport, quotaBuffer, score }) {
  const router = express.Router();
  const store = createStore({ pool, getKeys, quotaBuffer });
  const runner = createRunner({ store, loadCore, loadBank, transport, score });
  let ready = false;
  const action = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : '模型归因暂不可用，请稍后重试' }); }
  };

  router.use((req, res, next) => {
    if (!req.session?.user?.id) return res.status(401).json({ error: '请先登录' });
    if (!ready) return res.status(503).json({ error: '模型归因尚未就绪' });
    // Session-only APIs must not inherit the global Bearer CSRF exemption.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.authorization || req.headers['x-api-key']) return res.status(403).json({ error: '请使用登录会话与 CSRF 校验' });
      return require('../middleware/csrf').csrfProtection(req, res, next);
    }
    next();
  });

  router.get('/bank', action(async (req, res) => {
    const { bank, metadata } = await loadBank();
    res.json({ ...metadata, version: metadata.algorithm_version, bank_version: metadata.bank_hash,
      candidates: bank.models.map(model => ({ id: model.id, name: model.display_name, family: model.family })),
      notice: '候选库内概率仅供实验参考；库外模型、系统提示词及采集环境会影响结果' });
  }));

  router.get('/targets', action(async (req, res) => {
    const models = await store.targets(req.session.user.id);
    res.json({ targets: models.map(model => ({ model_id: model.id, model_name: model.name,
      provider_id: model.provider_id, provider_name: model.provider_name, protocol: model.format || 'openai',
      keys: getKeys(model).map((entry, index) => ({ id: keyId(entry.key), key_id: keyId(entry.key), label: entry.label || `Key ${index + 1}`, enabled: entry.enabled !== false })).filter(entry => entry.enabled),
      budget: 3, max_output_tokens: MAX_OUTPUT_TOKENS, max_input_tokens: MAX_INPUT_TOKENS, timeout_ms: 60000,
      estimated_max_points_per_probe: Math.ceil((MAX_INPUT_TOKENS + MAX_OUTPUT_TOKENS) * (Number(model.model_multiplier) || 1) / 100) / 10000 })) });
  }));

  router.post('/jobs', action(async (req, res) => {
    const { metadata } = await loadBank();
    const job = await store.create(req.session.user.id, req.body || {}, metadata);
    if (job.status === 'pending') runner.enqueue(job.id);
    res.status(202).json({ job: await store.get(req.session.user.id, job.id) });
  }));

  router.get('/jobs', action(async (req, res) => {
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 20));
    res.json(await store.list(req.session.user.id, page, limit));
  }));

  router.get('/jobs/:id', action(async (req, res) => {
    if (!uuid(req.params.id)) return res.status(404).json({ error: '任务不存在' });
    res.json({ job: await store.get(req.session.user.id, req.params.id) });
  }));

  router.post('/jobs/:id/cancel', action(async (req, res) => {
    if (!uuid(req.params.id)) return res.status(404).json({ error: '任务不存在' });
    await store.cancel(req.session.user.id, req.params.id);
    runner.cancel(req.params.id);
    res.json({ job: await store.get(req.session.user.id, req.params.id) });
  }));

  router.initialize = async () => { await store.recover(); ready = true; };
  router.shutdown = () => runner.stop();
  router.store = store;
  router.runner = runner;
  return router;
}

let singleton;
function getRouter() {
  if (!singleton) {
    const { pool } = require('../models/database');
    const { normalizeProviderKeyEntries } = require('../utils/provider-keys');
    const { loadCore, loadBank } = require('../utils/model-trace-core');
    const { transport } = require('../utils/model-trace-transport');
    singleton = createRouter({ pool, getKeys: normalizeProviderKeyEntries, loadCore, loadBank, transport,
      quotaBuffer: userId => require('../utils/quota-data').getUserQuotaBuffer(userId) });
  }
  return singleton;
}

module.exports = { createRouter, getRouter };
