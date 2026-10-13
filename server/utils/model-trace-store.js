'use strict';

const { randomUUID, createHash } = require('crypto');
const { calculateCost } = require('./billing');
const { moneyToString } = require('./money');
const MAX_OUTPUT_TOKENS = 4096;
const MAX_INPUT_TOKENS = 4096;
const ACTIVE = ['pending', 'running'];

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function keyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

function configurationHash(model) {
  const copy = { ...model };
  delete copy.api_key;
  delete copy.api_keys;
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

function createStore({ pool, getKeys, quotaBuffer = () => [] }) {
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function targets(userId, db = pool, modelId = null) {
    const result = await db.query(`SELECT m.id, m.name, m.upstream_model_id, m.model_multiplier,
      p.id AS provider_id, p.name AS provider_name, p.base_url, p.format,
      p.api_key, p.api_keys, p.key_mode, p.proxy_pool, p.proxy_subscription_url,
      p.proxy_enabled, p.proxy_mode, p.proxy_url, p.proxy_use_system,
      p.test_user_agent, ut.team_id
      FROM models m JOIN providers p ON p.id = m.provider
      JOIN team_models tm ON tm.model_id = m.id AND tm.enabled = TRUE
      JOIN user_teams ut ON ut.team_id = tm.team_id
      JOIN users u ON u.id = ut.user_id
      WHERE ut.user_id = $1 AND m.enabled = TRUE AND p.enabled = TRUE
        AND (p.created_by IS NULL OR p.created_by = u.id OR u.is_admin = TRUE)
        AND COALESCE(p.key_mode, 'fixed') = 'fixed'
        AND ($2::text IS NULL OR m.id = $2)
      ORDER BY m.name`, [userId, modelId]);
    return result.rows.filter(row => ['openai', 'anthropic', 'responses'].includes(row.format || 'openai'));
  }

  async function resolve(userId, modelId, selectedKey, db = pool) {
    const model = (await targets(userId, db, modelId))[0];
    if (!model) fail('无权使用该模型或供应商', 403);
    const keys = getKeys(model).filter(entry => entry.enabled !== false);
    if (!selectedKey && keys.length !== 1) fail('请选择一个启用的 Key');
    const entry = keys.find(item => keyId(item.key) === selectedKey) || (!selectedKey && keys[0]);
    if (!entry) fail('Key 不存在或已禁用', 403);
    return { model, entry, key_id: keyId(entry.key) };
  }

  async function lockUser(db, userId) {
    const user = (await db.query('SELECT id, balance FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!user) fail('请先登录', 401);
    return user;
  }

  async function quotaCovered(db, userId, teamId, weight) {
    const raw = (await db.query('SELECT quota_rules FROM teams WHERE id = $1', [teamId])).rows[0]?.quota_rules;
    const rules = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(rules) || !rules.length) return false;
    for (const rule of rules) {
      if (!['requests', 'tokens'].includes(rule.rule_type)) continue;
      const hours = Number(rule.duration_hours);
      const limit = Number(rule.rule_value);
      if (!(hours > 0) || !(limit > 0)) continue;
      const since = new Date(Date.now() - hours * 3600000);
      const used = (await db.query(`SELECT COUNT(*)::bigint AS requests,
        COALESCE(SUM(weighted_tokens),0) AS tokens FROM usage_records WHERE user_id=$1 AND created_at >= $2`, [userId, since])).rows[0];
      const held = (await db.query(`SELECT COUNT(*)::bigint AS requests, COALESCE(SUM(p.reserved_weight),0) AS tokens
        FROM model_trace_probes p JOIN model_trace_jobs j ON j.id=p.job_id
        WHERE j.user_id=$1 AND p.status='reserved' AND p.quota_covered=TRUE AND p.created_at >= $2`, [userId, since])).rows[0];
      let total = Number(used[rule.rule_type]) + Number(held[rule.rule_type]);
      for (const item of quotaBuffer(userId)) {
        if (item.created_at >= since) total += rule.rule_type === 'requests' ? item.count : (item.weighted_tokens || item.token_used);
      }
      if (total < limit) return true;
    }
    return false;
  }

  async function checkFunds(db, user, model, teamId) {
    const estimate = calculateCost(model, { promptTokens: MAX_INPUT_TOKENS, completionTokens: MAX_OUTPUT_TOKENS });
    const covered = await quotaCovered(db, user.id, teamId, estimate.weightedTokens);
    const cost = covered ? 0 : Math.ceil(estimate.pointsCost * 10000) / 10000;
    if (Number(user.balance) < cost) fail('积分不足，无法预留检测预算', 402);
    return { cost, weight: estimate.weightedTokens, covered };
  }

  async function create(userId, body, version) {
    if (typeof body.model_id !== 'string' || body.model_id.length > 100 ||
        typeof body.idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.idempotency_key) ||
        (body.key_id != null && !/^[a-f0-9]{24}$/.test(body.key_id)) ||
        (body.parent_job_id != null && !/^[a-f0-9-]{36}$/.test(body.parent_job_id))) fail('无效的任务参数');
    return transaction(async db => {
      const user = await lockUser(db, userId);
      const existing = (await db.query('SELECT * FROM model_trace_jobs WHERE user_id=$1 AND idempotency_key=$2', [userId, body.idempotency_key])).rows[0];
      if (existing) {
        if (existing.model_id !== body.model_id || (body.key_id && existing.target.key_id !== body.key_id) ||
            (existing.parent_job_id || null) !== (body.parent_job_id || null)) fail('幂等键已用于不同任务', 409);
        return existing;
      }
      const { model, entry, key_id } = await resolve(userId, body.model_id, body.key_id, db);
      // Serialize supplier admission across users without a long network transaction.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`model_trace:${model.provider_id}`]);
      if (body.parent_job_id) {
        const parent = (await db.query('SELECT * FROM model_trace_jobs WHERE id=$1 AND user_id=$2', [body.parent_job_id, userId])).rows[0];
        if (!parent || parent.model_id !== model.id || ACTIVE.includes(parent.status)) fail('补测来源不存在或尚未结束', 409);
      }
      const counts = (await db.query(`SELECT COUNT(*) FILTER (WHERE user_id=$1 AND status IN ('pending','running')) AS active,
        COUNT(*) FILTER (WHERE provider_id=$2 AND status IN ('pending','running')) AS supplier,
        COUNT(*) FILTER (WHERE user_id=$1 AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 day') AS daily,
        COUNT(*) FILTER (WHERE user_id=$1 AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 minute') AS recent
        FROM model_trace_jobs`, [userId, model.provider_id])).rows[0];
      if (Number(counts.active) >= 1 || Number(counts.supplier) >= 2 || Number(counts.daily) >= 20 || Number(counts.recent) >= 2) fail('检测任务已达到并发或频率限制', 429);
      await checkFunds(db, user, model, model.team_id);
      const target = { model_id: model.id, model_name: model.name, upstream_model_id: model.upstream_model_id || model.name || model.id,
        provider_id: model.provider_id, provider_name: model.provider_name, key_id,
        key_label: entry.label || `Key ${getKeys(model).findIndex(item => keyId(item.key) === key_id) + 1}`,
        protocol: model.format || 'openai', model_multiplier: Number(model.model_multiplier) || 1,
        configuration_hash: configurationHash(model), path: 'provider_direct', max_output_tokens: MAX_OUTPUT_TOKENS, timeout_ms: 60000 };
      return (await db.query(`INSERT INTO model_trace_jobs(id,user_id,team_id,model_id,provider_id,idempotency_key,parent_job_id,target,version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [randomUUID(), userId, model.team_id, model.id, model.provider_id, body.idempotency_key, body.parent_job_id || null, target, version])).rows[0];
    });
  }

  async function reserve(jobId, ordinal, expectedCount) {
    return transaction(async db => {
      const preliminary = (await db.query('SELECT user_id FROM model_trace_jobs WHERE id=$1', [jobId])).rows[0];
      if (!preliminary) return null;
      const user = await lockUser(db, preliminary.user_id);
      const job = (await db.query('SELECT * FROM model_trace_jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
      if (job.status !== 'running' || job.cancel_requested || ordinal > job.budget || ordinal !== job.attempted + 1) return null;
      const { model, entry } = await resolve(job.user_id, job.model_id, job.target.key_id, db);
      if (model.team_id !== job.team_id || configurationHash(model) !== job.target.configuration_hash) fail('目标配置或授权已变化', 403);
      const held = await checkFunds(db, user, model, job.team_id);
      if (held.cost > 0) await db.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [moneyToString(held.cost), job.user_id]);
      await db.query(`INSERT INTO model_trace_probes(job_id,ordinal,reserved_cost,reserved_weight,quota_covered,expected_count)
        VALUES($1,$2,$3,$4,$5,$6)`, [jobId, ordinal, held.cost, held.weight, held.covered, expectedCount]);
      return { job, model, key: entry.key };
    });
  }

  async function markSent(jobId, ordinal) {
    return transaction(async db => {
      const job = (await db.query('SELECT * FROM model_trace_jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
      if (job.status !== 'running' || job.cancel_requested) return false;
      const sent = await db.query(`UPDATE model_trace_probes SET sent=TRUE WHERE job_id=$1 AND ordinal=$2 AND status='reserved' AND sent=FALSE RETURNING ordinal`, [jobId, ordinal]);
      if (!sent.rowCount) return false;
      await db.query('UPDATE model_trace_jobs SET attempted=attempted+1 WHERE id=$1', [jobId]);
      return true;
    });
  }

  async function settle(jobId, ordinal, diagnostic = {}) {
    return transaction(async db => {
      const owner = (await db.query('SELECT user_id FROM model_trace_jobs WHERE id=$1', [jobId])).rows[0];
      if (!owner) return;
      await lockUser(db, owner.user_id);
      const job = (await db.query('SELECT * FROM model_trace_jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
      const probe = (await db.query('SELECT * FROM model_trace_probes WHERE job_id=$1 AND ordinal=$2 FOR UPDATE', [jobId, ordinal])).rows[0];
      if (!probe || probe.status !== 'reserved') return;
      const usage = diagnostic.usage;
      const unknown = probe.sent && !usage && !diagnostic.definite_rejection;
      const billing = usage ? calculateCost(job.target, usage) : { weightedTokens: 0, pointsCost: 0 };
      // Unknown generation retains its pre-reserved amount; it is never reported as known zero cost.
      const cost = unknown ? Number(probe.reserved_cost) : (probe.quota_covered ? 0 : Math.min(Number(probe.reserved_cost), billing.pointsCost));
      const delta = Number(probe.reserved_cost) - cost;
      await db.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [moneyToString(delta), job.user_id]);
      let usageId = null;
      if (probe.sent && !diagnostic.definite_rejection) {
        const weight = unknown ? Number(probe.reserved_weight) : billing.weightedTokens;
        const tokens = usage ? usage.promptTokens + usage.completionTokens : 0;
        usageId = (await db.query(`INSERT INTO usage_records(user_id,model_id,provider_id,request_type,request_source,
          tokens_used,prompt_tokens,completion_tokens,cached_tokens,weighted_tokens,cost,history_hidden)
          VALUES($1,$2,$3,'model_trace','model_trace',$4,$5,$6,$7,$8,$9,TRUE) RETURNING id`,
        [job.user_id, job.model_id, job.provider_id, tokens, usage?.promptTokens || 0, usage?.completionTokens || 0, usage?.cachedTokens || 0, weight, cost])).rows[0].id;
        await db.query(`INSERT INTO quota_data(user_id,model_name,created_at,token_used,weighted_tokens,count,quota)
          VALUES($1,$2,date_trunc('hour',CURRENT_TIMESTAMP),$3,$4,1,$5)
          ON CONFLICT(user_id,model_name,created_at) DO UPDATE SET token_used=quota_data.token_used+EXCLUDED.token_used,
          weighted_tokens=quota_data.weighted_tokens+EXCLUDED.weighted_tokens,count=quota_data.count+1,quota=quota_data.quota+EXCLUDED.quota`,
        [job.user_id, job.target.model_name, tokens, weight, cost]);
      }
      await db.query(`UPDATE model_trace_probes SET status=$3,cost=$4,total_tokens=$5,prompt_tokens=$6,completion_tokens=$7,
        weighted_tokens=$8,usage_unknown=$9,valid=$10,number_count=$11,response_model=$12,error=$13,usage_record_id=$14
        WHERE job_id=$1 AND ordinal=$2`, [jobId, ordinal, diagnostic.valid ? 'completed' : 'failed', cost,
        usage ? usage.promptTokens + usage.completionTokens : 0, usage?.promptTokens || 0, usage?.completionTokens || 0,
        billing.weightedTokens, unknown, !!diagnostic.valid, diagnostic.number_count || 0,
        typeof diagnostic.response_model === 'string' ? diagnostic.response_model.slice(0, 256) : null, diagnostic.error || null, usageId]);
      await db.query(`UPDATE model_trace_jobs SET valid_outputs=(SELECT COUNT(*) FROM model_trace_probes WHERE job_id=$1 AND valid=TRUE) WHERE id=$1`, [jobId]);
    });
  }

  async function claim(id) {
    return (await pool.query(`UPDATE model_trace_jobs SET status='running' WHERE id=$1 AND status='pending' AND cancel_requested=FALSE RETURNING *`, [id])).rows[0];
  }

  async function markSettlementPending(id) {
    await pool.query(`UPDATE model_trace_jobs SET error=$2 WHERE id=$1 AND status='running'`,
      [id, '结算暂不可用，已停止后续挑战，正在自动重试；取消检测不会停止结算']);
  }

  async function finish(id, status, result = null, error = null) {
    await pool.query(`UPDATE model_trace_jobs SET status=CASE WHEN cancel_requested THEN 'canceled' ELSE $2 END,
      result=$3,error=$4,finished_at=CURRENT_TIMESTAMP WHERE id=$1 AND status IN ('pending','running')
      AND NOT EXISTS (SELECT 1 FROM model_trace_probes WHERE job_id=$1 AND status='reserved')`, [id, status, result, error]);
  }

  async function cancel(userId, id) {
    const changed = await pool.query(`UPDATE model_trace_jobs SET cancel_requested=TRUE,
      status=CASE WHEN status='pending' THEN 'canceled' ELSE status END,
      finished_at=CASE WHEN status='pending' THEN CURRENT_TIMESTAMP ELSE finished_at END
      WHERE id=$1 AND user_id=$2 AND status IN ('pending','running') RETURNING *`, [id, userId]);
    if (!changed.rowCount) {
      const existing = await pool.query('SELECT 1 FROM model_trace_jobs WHERE id=$1 AND user_id=$2', [id, userId]);
      if (!existing.rowCount) fail('任务不存在', 404);
    }
  }

  async function get(userId, id) {
    const job = (await pool.query('SELECT * FROM model_trace_jobs WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    if (!job) fail('任务不存在', 404);
    const probes = (await pool.query(`SELECT ordinal,status,sent,valid,number_count,expected_count,cost,total_tokens,usage_unknown,response_model,error FROM model_trace_probes WHERE job_id=$1 ORDER BY ordinal`, [id])).rows;
    return { id: job.id, status: job.status, target: job.target, attempted: job.attempted, valid_outputs: job.valid_outputs,
      probes: probes.map(p => ({ ...p, cost: p.cost == null ? null : Number(p.cost) })), result: job.result,
      cost: probes.reduce((sum, p) => sum + Number(p.cost || 0), 0), total_tokens: probes.reduce((sum, p) => sum + p.total_tokens, 0),
      usage_unknown: probes.some(p => p.usage_unknown || (p.sent && p.status === 'reserved')),
      error: job.error, created_at: job.created_at, parent_job_id: job.parent_job_id, version: job.version };
  }

  async function list(userId, page, limit) {
    const result = await pool.query('SELECT id,COUNT(*) OVER() AS total FROM model_trace_jobs WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3', [userId, limit, (page - 1) * limit]);
    return { jobs: await Promise.all(result.rows.map(row => get(userId, row.id))), total: Number(result.rows[0]?.total || 0), page, limit };
  }

  async function recover() {
    const jobs = (await pool.query(`SELECT DISTINCT j.id FROM model_trace_jobs j
      LEFT JOIN model_trace_probes p ON p.job_id=j.id
      WHERE j.status IN ('pending','running') OR p.status='reserved'`)).rows;
    for (const job of jobs) {
      const probes = (await pool.query(`SELECT ordinal FROM model_trace_probes WHERE job_id=$1 AND status='reserved'`, [job.id])).rows;
      for (const probe of probes) await settle(job.id, probe.ordinal, { error: '进程中断，用量可能未知' });
      await finish(job.id, 'interrupted', null, '进程重启中断；不会自动继续检测');
    }
  }

  return { targets, resolve, create, reserve, markSent, settle, claim, markSettlementPending, finish, cancel, get, list, recover, transaction };
}

module.exports = { createStore, keyId, configurationHash, MAX_OUTPUT_TOKENS, MAX_INPUT_TOKENS };
