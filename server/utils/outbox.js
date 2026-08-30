'use strict';

const crypto = require('crypto');

const OUTBOX_TOPIC_OPERATION_LOG = 'operation_log.created';

function defaultPool() {
  return require('../models/database').pool;
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function createIdempotencyKey(topic, payload) {
  const digest = crypto.createHash('sha256')
    .update(`${topic}:${JSON.stringify(payload)}`)
    .digest('hex');
  return `${topic}:${digest}`;
}

async function enqueue({ topic, payload, idempotencyKey, availableAt = null, db = null }) {
  db = db || defaultPool();
  if (!topic) throw new TypeError('outbox topic is required');
  const key = String(idempotencyKey || createIdempotencyKey(topic, payload));
  const result = await db.query(
    `INSERT INTO outbox_events (idempotency_key, topic, payload, available_at)
     VALUES ($1, $2, $3::jsonb, COALESCE($4, CURRENT_TIMESTAMP))
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id, idempotency_key, topic, payload, status, attempts, available_at`,
    [key, topic, json(payload || {}), availableAt]
  );
  return result.rows[0] || null;
}

async function claim({ limit = 10, workerId = `worker:${process.pid}`, leaseMs = 300000, db = null } = {}) {
  db = db || defaultPool();
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const ownsClient = client !== db;
  try {
    if (ownsClient) await client.query('BEGIN');
    const result = await client.query(
      `WITH candidates AS (
         SELECT id FROM outbox_events
         WHERE status = 'pending' AND available_at <= CURRENT_TIMESTAMP
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE outbox_events e
       SET status = 'processing', attempts = e.attempts + 1,
           locked_at = CURRENT_TIMESTAMP, locked_by = $2, updated_at = CURRENT_TIMESTAMP
       FROM candidates c
       WHERE e.id = c.id
       RETURNING e.id, e.idempotency_key, e.topic, e.payload, e.status, e.attempts,
                 e.available_at, e.locked_at, e.locked_by`,
      [Math.max(1, Number(limit) || 10), String(workerId).slice(0, 255)]
    );
    if (ownsClient) await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    if (ownsClient) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

async function ack(id, { db = null } = {}) {
  db = db || defaultPool();
  const result = await db.query(
    `UPDATE outbox_events
     SET status = 'acked', locked_at = NULL, locked_by = NULL,
         last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'processing'
     RETURNING id, status, attempts, updated_at`,
    [id]
  );
  return result.rows[0] || null;
}

async function retry(id, error, { delayMs = 0, db = null } = {}) {
  db = db || defaultPool();
  const result = await db.query(
    `UPDATE outbox_events
     SET status = 'pending', available_at = CURRENT_TIMESTAMP + ($2 * INTERVAL '1 millisecond'),
         locked_at = NULL, locked_by = NULL, last_error = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'processing'
     RETURNING id, status, attempts, available_at`,
    [id, Math.max(0, Number(delayMs) || 0), error ? String(error.message || error).slice(0, 2000) : null]
  );
  return result.rows[0] || null;
}

async function enqueueOperationLogEvent(entry, options = {}) {
  return enqueue({
    topic: OUTBOX_TOPIC_OPERATION_LOG,
    payload: entry,
    idempotencyKey: options.idempotencyKey || createIdempotencyKey(OUTBOX_TOPIC_OPERATION_LOG, entry),
    db: options.db || defaultPool(),
  });
}

module.exports = {
  OUTBOX_TOPIC_OPERATION_LOG,
  createIdempotencyKey,
  enqueue,
  claim,
  ack,
  retry,
  enqueueOperationLogEvent,
};
