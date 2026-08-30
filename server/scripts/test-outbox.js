'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const outbox = require('../utils/outbox');

function fakeDb() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (/INSERT INTO outbox_events/.test(text)) {
        return { rows: [{ id: 1, idempotency_key: params[0], topic: params[1], payload: params[2] }] };
      }
      return { rows: [{ id: 1, status: 'acked', attempts: 1 }] };
    },
  };
}

(async () => {
  const migration = fs.readFileSync(path.join(__dirname, 'migrations/001-outbox.sql'), 'utf8');
  const audit = fs.readFileSync(path.join(__dirname, '..', 'utils/audit-log.js'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS outbox_events/);
  assert.match(migration, /DROP TABLE IF EXISTS outbox_events/);
  assert.match(migration, /idempotency_key VARCHAR\(255\) NOT NULL UNIQUE/);
  assert.match(audit, /OUTBOX_ENABLED/);
  assert.match(audit, /enqueueOperationLogEvent/);

  const db = fakeDb();
  const first = await outbox.enqueue({ topic: 'test.event', payload: { value: 1 }, db });
  const second = await outbox.enqueue({ topic: 'test.event', payload: { value: 1 }, db });
  assert.strictEqual(first.idempotency_key, second.idempotency_key);
  assert.match(db.calls[0].text, /ON CONFLICT \(idempotency_key\)/);

  await outbox.ack(1, { db });
  await outbox.retry(1, new Error('temporary'), { delayMs: 1000, db });
  assert.match(db.calls[2].text, /status = 'acked'/);
  assert.match(db.calls[3].text, /status = 'pending'/);
  console.log('outbox unit assertions passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
