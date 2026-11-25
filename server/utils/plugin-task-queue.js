'use strict';

const TASK_LEASE_MS = 60000;
const TASK_TIMEOUT_MS = 30000;

async function ensureSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS plugin_tasks (
    id BIGSERIAL PRIMARY KEY,
    plugin_id VARCHAR(100) NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    task_name VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key VARCHAR(200) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(255),
    result JSONB,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plugin_id, idempotency_key)
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS idx_plugin_tasks_claim ON plugin_tasks (available_at,id) WHERE status=\'pending\'');
  await db.query('CREATE INDEX IF NOT EXISTS idx_plugin_tasks_lease ON plugin_tasks (locked_at) WHERE status=\'running\'');
}

function validatePayload(value) {
  const encoded = JSON.stringify(value === undefined ? {} : value);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 65536) throw new Error('插件任务 payload 必须是 JSON 且不超过 64 KiB');
  const parsed = JSON.parse(encoded);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('插件任务 payload 必须是 JSON 对象');
  return parsed;
}

function createTaskQueue({ pool, isLoaded, getHandlers, getPluginDir = () => null, logger = console }) {
  let timer = null;
  let tickPromise = null;
  let busy = false;
  const running = new Map();

  async function enqueue(pluginId, taskName, payload, options = {}) {
    if (!isLoaded(pluginId)) throw new Error('插件未启用');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(String(taskName || ''))) throw new Error('插件任务名称无效');
    if (!getHandlers(pluginId)?.has(taskName)) throw new Error('插件任务未注册');
    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('插件任务必须提供 1–200 字符的幂等键');
    const body = validatePayload(payload);
    const maxAttempts = Math.min(20, Math.max(1, Math.floor(Number(options.maxAttempts) || 5)));
    const result = await pool.query(
      `INSERT INTO plugin_tasks (plugin_id, task_name, payload, idempotency_key, max_attempts)
       VALUES ($1,$2,$3::jsonb,$4,$5)
       ON CONFLICT (plugin_id, idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
       RETURNING id, plugin_id, task_name, payload, status, attempts, max_attempts, available_at`,
      [pluginId, taskName, JSON.stringify(body), idempotencyKey, maxAttempts]
    );
    return result.rows[0];
  }

  async function get(pluginId, taskId) {
    const result = await pool.query(`SELECT id, task_name, status, attempts, max_attempts, available_at, result, last_error, created_at, updated_at FROM plugin_tasks WHERE plugin_id=$1 AND id=$2`, [pluginId, taskId]);
    return result.rows[0] || null;
  }

  async function cancel(pluginId, taskId) {
    const result = await pool.query(`UPDATE plugin_tasks SET status='cancelled', locked_at=NULL, locked_by=NULL, updated_at=now() WHERE plugin_id=$1 AND id=$2 AND status='pending' RETURNING id,status`, [pluginId, taskId]);
    return result.rows[0] || null;
  }

  async function claim(workerId) {
    const result = await pool.query(`WITH candidate AS (
      SELECT id FROM plugin_tasks
      WHERE ((status='pending' AND available_at<=now()) OR (status='running' AND locked_at<=now()-($2::int * interval '1 millisecond')))
        AND attempts<max_attempts ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE plugin_tasks t SET status='running', attempts=t.attempts+1, locked_at=now(), locked_by=$1, updated_at=now()
      FROM candidate c WHERE t.id=c.id RETURNING t.*`, [workerId, TASK_LEASE_MS]);
    return result.rows[0] || null;
  }

  async function settle(task, status, resultValue, error) {
    if (status === 'retry' && task.attempts < task.max_attempts) {
      const delayMs = Math.min(300000, 1000 * (2 ** Math.max(0, task.attempts - 1)));
      await pool.query(`UPDATE plugin_tasks SET status='pending', available_at=now()+($2::int * interval '1 millisecond'), locked_at=NULL, locked_by=NULL, last_error=$3, updated_at=now() WHERE id=$1 AND locked_by=$4`, [task.id, delayMs, String(error?.message || error || '任务处理失败').slice(0, 2000), task.locked_by]);
      return;
    }
    const finalStatus = status === 'succeeded' ? 'succeeded' : 'failed';
    const safeResult = resultValue == null ? null : JSON.stringify(validatePayload(resultValue));
    await pool.query(`UPDATE plugin_tasks SET status=$2, result=$3::jsonb, last_error=$4, locked_at=NULL, locked_by=NULL, updated_at=now() WHERE id=$1 AND locked_by=$5`, [task.id, finalStatus, safeResult, error ? String(error.message || error).slice(0, 2000) : null, task.locked_by]);
  }

  async function tick() {
    if (busy || !isLoaded()) return;
    busy = true;
    const workerId = `plugin-task:${process.pid}`;
    try {
      await pool.query(`UPDATE plugin_tasks SET status='failed', locked_at=NULL, locked_by=NULL, last_error=COALESCE(last_error,'任务租约过期且已耗尽重试次数'), updated_at=now() WHERE attempts>=max_attempts AND ((status='pending') OR (status='running' AND locked_at<=now()-($1::int * interval '1 millisecond')))`, [TASK_LEASE_MS]);
      for (let i = 0; i < 5; i++) {
        const task = await claim(workerId);
        if (!task) break;
        const handler = getHandlers(task.plugin_id)?.get(task.task_name);
        if (!isLoaded(task.plugin_id) || !handler) {
          await settle(task, 'failed', null, new Error('插件已停用或任务处理器未注册'));
          continue;
        }
        let timeout;
        const controller = new AbortController();
        running.set(task.id, { pluginId: task.plugin_id, controller });
        try {
          const value = handler?.isolated
            ? await require('../plugins/task-sandbox').runTaskInBwrap({ pluginId: task.plugin_id, pluginDir: getPluginDir(task.plugin_id), taskName: task.task_name, payload: task.payload, taskId: task.id, attempt: task.attempts, timeoutMs: TASK_TIMEOUT_MS, signal: controller.signal })
            : await Promise.race([
                Promise.resolve().then(() => handler(task.payload, { taskId: task.id, attempt: task.attempts, signal: controller.signal })),
                new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('插件任务执行超时')), TASK_TIMEOUT_MS); }),
              ]);
          if (!isLoaded(task.plugin_id) || getHandlers(task.plugin_id)?.get(task.task_name) !== handler) {
            await settle(task, 'failed', null, new Error('插件在任务执行期间已停用或重载'));
          } else {
            await settle(task, 'succeeded', value, null);
          }
        } catch (error) {
          const wasAborted = controller.signal.aborted;
          if (!wasAborted) controller.abort(error);
          if (wasAborted) {
            await pool.query(`UPDATE plugin_tasks SET status='cancelled', locked_at=NULL, locked_by=NULL, updated_at=now() WHERE id=$1 AND locked_by=$2`, [task.id, task.locked_by]);
          } else {
            await settle(task, task.attempts < task.max_attempts ? 'retry' : 'failed', null, error);
          }
        } finally { clearTimeout(timeout); running.delete(task.id); }
      }
    } catch (error) {
      logger.warn(`[plugins] 后台任务 worker 出错: ${error.message}`);
    } finally { busy = false; }
  }

  function cancelPlugin(pluginId) {
    for (const [, entry] of running) {
      if (entry.pluginId === pluginId) entry.controller.abort(new Error('插件已停用'));
    }
    return pool.query(`UPDATE plugin_tasks SET status='cancelled', locked_at=NULL, locked_by=NULL, updated_at=now() WHERE plugin_id=$1 AND status IN ('pending','running')`, [pluginId]);
  }

  function scheduleTick() {
    if (tickPromise) return tickPromise;
    tickPromise = tick().finally(() => { tickPromise = null; });
    return tickPromise;
  }
  function start() {
    if (!timer) { timer = setInterval(() => { void scheduleTick(); }, 1000); timer.unref?.(); void scheduleTick(); }
    return timer;
  }
  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const entry of running.values()) entry.controller.abort(new Error('任务 worker 已停止'));
    if (tickPromise) await tickPromise;
  }
  return { ensureSchema: () => ensureSchema(pool), enqueue, get, cancel, cancelPlugin, tick, start, stop };
}

module.exports = { createTaskQueue, ensureSchema, validatePayload, TASK_LEASE_MS, TASK_TIMEOUT_MS };
