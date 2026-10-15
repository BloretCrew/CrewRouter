const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const sourcePath = path.resolve(__dirname, '../utils/usage-compress.js');
const originalLoad = Module._load;
const updates = [];
const records = [
  { id: 1, created_at: '2026-01-01 00:00:00', messages: [{ role: 'user', content: 'x'.repeat(1000) }], storage_mode: 'full', delta_seq: null, plugin_meta: {} },
  { id: 2, created_at: '2026-01-01 00:00:01', messages: [{ role: 'user', content: 'x'.repeat(1000) }, { role: 'assistant', content: 'ok' }], storage_mode: 'full', delta_seq: null, plugin_meta: {} },
  { id: 3, created_at: '2026-01-01 00:00:02', messages: [{ role: 'user', content: 'x'.repeat(1000) }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }], storage_mode: 'full', delta_seq: null, plugin_meta: {} },
];
let metadataReads = 0;
const client = {
  async query(sql, args) {
    if (sql.includes('UPDATE usage_records') && sql.includes('SET messages')) updates.push(args);
    return { rows: [], rowCount: 1 };
  },
  release() {},
};
const pool = {
  async query(sql, args) {
    if (sql.includes('ALTER TABLE')) return { rows: [] };
    if (sql.includes('SELECT id, created_at::text AS created_at, messages')) {
      const [sessionId, afterTs, afterId] = args;
      assert.equal(sessionId, 'session-1');
      const row = records.find((item) => !afterTs ? true : item.created_at > afterTs || (item.created_at === afterTs && item.id > afterId));
      return { rows: row ? [{ ...row }] : [] };
    }
    if (sql.includes('SELECT id, created_at, storage_mode, delta_seq, plugin_meta')) {
      metadataReads++;
      return { rows: records.map(({ id, created_at, storage_mode, delta_seq, plugin_meta }) => ({ id, created_at, storage_mode, delta_seq, plugin_meta })) };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  },
  async connect() { return client; },
};

Module._load = function(request, parent, isMain) {
  if (request === '../models/database' && parent.filename === sourcePath) return { pool };
  if (request === '../logger' && parent.filename === sourcePath) return { error() {} };
  if (request === './retention-log' && parent.filename === sourcePath) return { logRetention() {} };
  if (request === './usage-agg' && parent.filename === sourcePath) return { isHealthy: async () => true, getRetentionConfig: async () => ({}) };
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const { compressSession, expandSessionMessages } = require(sourcePath);
    const dryRun = await compressSession('session-1', { dryRun: true });
    assert.equal(dryRun.recordCount, 3);
    assert.equal(dryRun.compressedCount, 2);
    assert.ok(dryRun.savedBytes > 0);
    assert.equal(updates.length, 0, 'dry-run must not write');
    assert.equal(metadataReads, 1);

    const result = await compressSession('session-1');
    assert.equal(result.recordCount, 3);
    assert.equal(result.compressedCount, 2);
    assert.equal(updates.length, 3);
    const restored = expandSessionMessages(records.map((row, i) => ({ ...row, messages: JSON.parse(updates[i][1]), storage_mode: updates[i][2], delta_seq: updates[i][3], delta_base: updates[i][4] })));
    assert.deepEqual(restored, records.map((row) => row.messages));
    console.log('usage-compress-bounded: 9 checks passed');
  } finally {
    Module._load = originalLoad;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
