'use strict';

// Isolated PostgreSQL only; no production config or database is read.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const {
  normalizeMultiplierBatch,
  draftProblem,
  applyMultiplierBatch,
  toApprovalPreview,
  round4
} = require('../utils/agent-multiplier');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('  PASS', name);
}

async function fixture(cluster) {
  const pool = new Pool({ ...cluster.connection, max: 4 });
  await pool.query(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, is_admin BOOLEAN);
    INSERT INTO users VALUES (1, TRUE);
    CREATE TABLE providers(id TEXT PRIMARY KEY, name TEXT, enabled BOOLEAN);
    INSERT INTO providers VALUES ('p1','Provider One',TRUE),('p2','Provider Two',FALSE);
    CREATE TABLE models(
      id TEXT PRIMARY KEY, name TEXT, alias TEXT, upstream_model_id TEXT, provider TEXT,
      enabled BOOLEAN, output_kind TEXT, model_multiplier NUMERIC,
      completion_multiplier NUMERIC, input_price_per_1k_tokens NUMERIC,
      output_price_per_1k_tokens NUMERIC, cached_output_price_per_1k_tokens NUMERIC
    );
    INSERT INTO models VALUES
      ('m1','Model One','','up-1','p1',TRUE,'chat',1.0,1.0,0.002,0.008,0.0002),
      ('m2','Model Two','alias-two','up-2','p1',TRUE,'chat',2.0,2.0,0.002,0.008,0.0002),
      ('m3','Model Three','','up-3','p2',FALSE,'chat',0.5,0.5,0.01,0.02,0.001);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value JSONB);
    INSERT INTO settings VALUES ('billing_points_currency','"CNY"');
    CREATE TABLE agent_threads(id INTEGER PRIMARY KEY, user_id INTEGER, mode TEXT);
    INSERT INTO agent_threads VALUES (1,1,'manage');
    CREATE TABLE agent_attachments(
      id INTEGER PRIMARY KEY, user_id INTEGER, thread_id INTEGER,
      filename TEXT, source TEXT, meta JSONB
    );
    INSERT INTO agent_attachments VALUES (1,1,1,'prices.csv','upload','{}');
  `);
  return pool;
}

async function main() {
  const cluster = createIsolatedPostgres('agent-multiplier');
  const pool = await fixture(cluster);
  try {
    await cluster.assertIsolation(pool);

    assert.equal(round4(1.20965), 1.2097);
    assert.equal(round4(0.00004), 0);

    const cny = {
      basis: 'input',
      currency: 'CNY',
      markup: 1.2,
      changes: [
        { model_ref: 'm1', source_price: 2, price_unit: 'per_1m' },
        { model_ref: 'alias-two', source_price: 0.002, price_unit: 'per_1k' }
      ]
    };
    const normalized = await normalizeMultiplierBatch(pool, cny, { requireExpected: true });
    assert.equal(normalized.ok, true);
    assert.ok(normalized.errors.some(item => item.reason === 'expected_multiplier_required'));
    assert.equal(draftProblem(normalized).ok, false);
    ok('write drafts require an expected current multiplier');

    const preview = await normalizeMultiplierBatch(pool, {
      ...cny,
      changes: cny.changes.map(item => ({ ...item, expected_current_multiplier: item.model_ref === 'm1' ? 1 : 2 }))
    }, { requireExpected: true });
    assert.equal(preview.ok, true);
    assert.equal(preview.changes.length, 2);
    assert.equal(preview.changes[0].new_multiplier, 2.4);
    assert.equal(preview.changes[1].new_multiplier, 2.4);
    assert.equal(preview.summary.changed, 2);
    assert.equal(draftProblem(preview).ok, true);
    const shaped = toApprovalPreview(preview);
    assert.equal(shaped.rows[0].current_multiplier, 1);
    assert.equal(shaped.rows[0].proposed_multiplier, 2.4);
    ok('CNY per-1m and per-1k prices both compute correctly');

    const usd = await normalizeMultiplierBatch(pool, {
      basis: 'input',
      currency: 'USD',
      markup: 1.2,
      changes: [{ model_ref: 'm1', source_price: 1, price_unit: 'per_1m', fx_rate: 7.2, expected_current_multiplier: 1 }]
    }, { requireExpected: true });
    assert.equal(usd.ok, true);
    assert.equal(usd.changes[0].new_multiplier, 8.64);
    assert.equal(usd.changes[0].source_currency, 'USD');
    ok('foreign currency uses the supplied exchange rate');

    const noFx = await normalizeMultiplierBatch(pool, {
      basis: 'input',
      currency: 'USD',
      markup: 1.2,
      changes: [{ model_ref: 'm1', source_price: 1, price_unit: 'per_1m', expected_current_multiplier: 1 }]
    }, { requireExpected: true });
    assert.equal(noFx.ok, true);
    assert.equal(noFx.errors[0].reason, 'fx_required');
    ok('foreign currency without an exchange rate is rejected');

    const mismatch = await normalizeMultiplierBatch(pool, {
      basis: 'input',
      currency: 'CNY',
      markup: 1.2,
      changes: [{ model_ref: 'm1', source_price: 2, price_unit: 'per_1m', new_multiplier: 99, expected_current_multiplier: 1 }]
    }, { requireExpected: true });
    assert.equal(mismatch.errors[0].reason, 'multiplier_mismatch');
    ok('model-supplied multipliers must match the server calculation');

    const duplicate = await normalizeMultiplierBatch(pool, {
      basis: 'input',
      currency: 'CNY',
      markup: 1.2,
      changes: [
        { model_ref: 'm1', source_price: 2, price_unit: 'per_1m' },
        { model_ref: 'm1', source_price: 3, price_unit: 'per_1m' }
      ]
    });
    assert.equal(duplicate.errors[0].reason, 'duplicate_model');
    assert.equal(draftProblem(duplicate).code, 'draft_invalid');
    ok('duplicate model entries are rejected');

    const stale = await normalizeMultiplierBatch(pool, {
      basis: 'input',
      currency: 'CNY',
      markup: 1.2,
      changes: [{ model_ref: 'm1', source_price: 2, price_unit: 'per_1m', expected_current_multiplier: 999 }]
    }, { requireExpected: true });
    assert.equal(stale.changes[0].stale, true);
    assert.equal(draftProblem(stale).code, 'stale_multiplier');
    ok('a stale expected multiplier is detected before approval');

    const missing = await normalizeMultiplierBatch(pool, {
      basis: 'input',
      currency: 'CNY',
      markup: 1.2,
      changes: [{ model_ref: 'does-not-exist', source_price: 2, price_unit: 'per_1m' }]
    });
    assert.equal(missing.unmatched[0].reason, 'model_not_found');
    assert.equal(draftProblem(missing).code, 'unmatched_models');
    ok('unknown model references are reported instead of guessed');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const applied = await applyMultiplierBatch(client, {
        ...cny,
        changes: cny.changes.map(item => ({ ...item, expected_current_multiplier: item.model_ref === 'm1' ? 1 : 2 }))
      });
      assert.equal(applied.updated, 2);
      assert.equal(applied.unchanged, 0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const after = await pool.query('SELECT id, model_multiplier, completion_multiplier FROM models ORDER BY id');
    assert.equal(Number(after.rows[0].model_multiplier), 2.4);
    assert.equal(Number(after.rows[1].model_multiplier), 2.4);
    assert.equal(Number(after.rows[0].completion_multiplier), 1.0, 'completion_multiplier must not change');
    ok('batch update only changes model_multiplier');

    const beforeRollback = await pool.query('SELECT id, model_multiplier FROM models ORDER BY id');
    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query('BEGIN');
      await assert.rejects(
        applyMultiplierBatch(rollbackClient, {
          ...cny,
          changes: [
            { model_ref: 'm1', source_price: 1, price_unit: 'per_1m', expected_current_multiplier: Number(beforeRollback.rows[0].model_multiplier) },
            { model_ref: 'm2', source_price: 1, price_unit: 'per_1m', expected_current_multiplier: 999 }
          ]
        }),
        error => error.code === 'stale_multiplier'
      );
      await rollbackClient.query('ROLLBACK');
    } finally {
      rollbackClient.release();
    }
    const afterRollback = await pool.query('SELECT id, model_multiplier FROM models ORDER BY id');
    assert.deepEqual(afterRollback.rows, beforeRollback.rows, 'one stale item rolls back the whole batch');
    ok('a stale item rolls back the entire batch');

    const idempotentClient = await pool.connect();
    try {
      await idempotentClient.query('BEGIN');
      const current = Number((await idempotentClient.query("SELECT model_multiplier FROM models WHERE id='m1'")).rows[0].model_multiplier);
      const result = await applyMultiplierBatch(idempotentClient, {
        basis: 'input',
        currency: 'CNY',
        markup: 1,
        changes: [{ model_ref: 'm1', source_price: current, price_unit: 'per_1m', expected_current_multiplier: current }]
      });
      assert.equal(result.updated, 0);
      assert.equal(result.unchanged, 1);
      await idempotentClient.query('COMMIT');
    } finally {
      idempotentClient.release();
    }
    ok('unchanged values are idempotent');

    const { validateToolCall, runToolCall, resolveToolDecision } = require('../utils/agent-tools');
    const currentRows = await pool.query("SELECT id, model_multiplier FROM models WHERE id IN ('m1','m2') ORDER BY id");
    const writeArgs = {
      basis: 'input',
      currency: 'CNY',
      markup: 1.2,
      changes: currentRows.rows.map(row => ({
        model_id: row.id,
        expected_current_multiplier: Number(row.model_multiplier),
        source_price: 2.5,
        price_unit: 'per_1m',
        source_currency: 'CNY',
        fx_rate: 1,
        markup: 1.2,
        basis: 'input',
        new_multiplier: 3,
        reason: 'tool-path test'
      }))
    };
    const validation = await validateToolCall(pool, {
      name: 'batch_set_model_multipliers', arguments: writeArgs
    }, {});
    assert.equal(validation.ok, true);
    const pending = await runToolCall(pool, {
      name: 'batch_set_model_multipliers', arguments: writeArgs
    }, { approved: false });
    assert.equal(pending.status, 'pending');
    const toolClient = await pool.connect();
    try {
      await toolClient.query('BEGIN');
      const output = await resolveToolDecision(toolClient, {
        name: 'batch_set_model_multipliers', arguments: writeArgs
      }, 'allow', { approved: true, userId: 1, threadId: 1 });
      assert.equal(output.error, undefined);
      assert.equal(output.updated, 2);
      await toolClient.query('COMMIT');
    } finally {
      toolClient.release();
    }
    const appliedRows = await pool.query("SELECT model_multiplier FROM models WHERE id IN ('m1','m2')");
    assert.ok(appliedRows.rows.every(row => Number(row.model_multiplier) === 3));
    ok('the tool path validates, waits for approval, and applies the batch');

    const { buildApprovalPreview } = require('../utils/agent-approval-preview');
    const previewArgs = {
      ...writeArgs,
      changes: writeArgs.changes.map(change => ({ ...change, source_attachment_ids: [1] }))
    };
    const approvalPreview = await buildApprovalPreview(pool, {
      toolName: 'batch_set_model_multipliers',
      args: previewArgs,
      userId: 1,
      threadId: 1
    });
    assert.equal(approvalPreview.type, 'model_multiplier_batch');
    assert.equal(approvalPreview.rows.length, 2);
    assert.equal(approvalPreview.summary.count, 2);
    assert.equal(approvalPreview.sources[0].filename, 'prices.csv');
    assert.ok(approvalPreview.rows[0].current_multiplier > 0);
    ok('approval previews include rows, summary and source attachments');

    console.log(`\n${passed} assertions passed`);
  } finally {
    await pool.end();
    cluster.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
