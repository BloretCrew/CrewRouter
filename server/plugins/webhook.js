'use strict';

const DELIVERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS plugin_webhook_deliveries (
    id BIGSERIAL PRIMARY KEY,
    plugin_id TEXT NOT NULL,
    webhook_id BIGINT,
    event_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('delivered', 'failed')),
    attempts INTEGER NOT NULL,
    response_status INTEGER,
    error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10000;
const RETRY_DELAYS_MS = [250, 1000];

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('webhook 超时')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createWebhookApi({ pluginId, pool, validateUrl, fetchValidated, allowedHosts = [], logFailure = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const allowedHostSet = new Set(allowedHosts.map(host => String(host).toLowerCase()));

  async function ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plugin_webhooks (
        id BIGSERIAL PRIMARY KEY, plugin_id TEXT NOT NULL, url TEXT NOT NULL,
        events JSONB NOT NULL DEFAULT '[]'::jsonb, secret TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(DELIVERY_SCHEMA);
  }

  async function register(hook = {}) {
    const url = String(hook.url || '');
    if (!url.startsWith('https://')) throw new Error(`[plugins:${pluginId}] webhook url 必须 https`);
    const host = url.replace(/^https:\/\//, '').split(/[/?#]/)[0].toLowerCase();
    if (allowedHostSet.size && !allowedHostSet.has(host)) {
      throw new Error(`[plugins:${pluginId}] webhook 目标域 ${host} 不在 allowedHosts 白名单`);
    }
    const check = await validateUrl(url, { allowPrivate: false });
    if (!check.ok) throw new Error(`[plugins:${pluginId}] webhook 被 SSRF 校验拒绝: ${check.error}`);
    await ensureTables();
    await pool.query(
      `INSERT INTO plugin_webhooks (plugin_id, url, events, secret) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [pluginId, url, JSON.stringify(Array.isArray(hook.events) ? hook.events : []), hook.secret || null]
    );
    return { registered: true, host };
  }

  async function deliver(webhook, eventName, payload) {
    let responseStatus = null;
    let error = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      try {
        const check = await validateUrl(webhook.url, { allowPrivate: false });
        if (!check.ok) throw new Error(`SSRF 校验拒绝: ${check.error}`);
        const headers = { 'Content-Type': 'application/json' };
        if (webhook.secret) headers['X-Webhook-Secret'] = webhook.secret;
        const response = await withTimeout(fetchValidated(check, {
          method: 'POST', headers,
          body: JSON.stringify({ event: eventName, payload, ts: Date.now() }),
          redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }), REQUEST_TIMEOUT_MS);
        responseStatus = Number.isInteger(response?.status) ? response.status : null;
        if (responseStatus === null || responseStatus < 200 || responseStatus >= 300) {
          throw new Error(responseStatus === null ? '无效 HTTP 响应' : `HTTP ${responseStatus}`);
        }
        error = null;
        break;
      } catch (cause) {
        error = String(cause?.message || '投递失败').slice(0, 500);
        logFailure(webhook.id, error);
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      }
    }
    const status = error === null ? 'delivered' : 'failed';
    await pool.query(
      `INSERT INTO plugin_webhook_deliveries
         (plugin_id, webhook_id, event_name, status, attempts, response_status, error, delivered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $4 = 'delivered' THEN now() ELSE NULL END)`,
      [pluginId, webhook.id, String(eventName).slice(0, 200), status, attempts, responseStatus, error]
    );
    return { webhookId: webhook.id, status, attempts, responseStatus, error };
  }

  async function emit(eventName, payload = {}) {
    await ensureTables();
    const { rows = [] } = await pool.query(
      `SELECT id, url, secret FROM plugin_webhooks WHERE plugin_id = $1 AND (events @> $2::jsonb OR events = '[]'::jsonb)`,
      [pluginId, JSON.stringify([String(eventName)])]
    );
    const results = [];
    for (const webhook of rows) results.push(await deliver(webhook, eventName, payload));
    const delivered = results.filter(result => result.status === 'delivered').length;
    return { matched: rows.length, delivered, failed: rows.length - delivered, results };
  }

  async function deliveries(options = {}) {
    await ensureTables();
    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 100);
    const params = [pluginId];
    let where = 'plugin_id = $1';
    if (options.status === 'delivered' || options.status === 'failed') {
      params.push(options.status);
      where += ` AND status = $${params.length}`;
    }
    params.push(limit);
    const { rows = [] } = await pool.query(
      `SELECT id, webhook_id AS "webhookId", event_name AS "eventName", status, attempts,
              response_status AS "responseStatus", error, delivered_at AS "deliveredAt", created_at AS "createdAt"
       FROM plugin_webhook_deliveries WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
      params
    );
    return rows;
  }

  return { register, emit, deliveries };
}

module.exports = { createWebhookApi, MAX_ATTEMPTS, RETRY_DELAYS_MS };
