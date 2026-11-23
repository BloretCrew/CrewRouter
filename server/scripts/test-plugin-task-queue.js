'use strict';
const assert = require('node:assert/strict');
const { createTaskQueue, validatePayload } = require('../utils/plugin-task-queue');

function fixture() {
  const tasks = new Map();
  let nextId = 1;
  const pool = {
    async query(sql, p = []) {
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [] };
      if (/INSERT INTO plugin_tasks/.test(sql)) {
        const key = `${p[0]}:${p[3]}`;
        let task = [...tasks.values()].find(t => t.key === key);
        if (!task) {
          task = { id: nextId++, key, plugin_id: p[0], task_name: p[1], payload: JSON.parse(p[2]), status: 'pending', attempts: 0, max_attempts: p[4], available_at: new Date(), locked_by: null };
          tasks.set(task.id, task);
        }
        return { rows: [{ ...task }] };
      }
      if (/SELECT id, task_name/.test(sql)) {
        const task = tasks.get(p[1]);
        return { rows: task?.plugin_id === p[0] ? [{ ...task }] : [] };
      }
      if (/UPDATE plugin_tasks SET status='cancelled'/.test(sql)) {
        const task = tasks.get(p[1]);
        if (!task || task.plugin_id !== p[0] || task.status !== 'pending') return { rows: [] };
        task.status = 'cancelled'; return { rows: [{ id: task.id, status: task.status }] };
      }
      if (/UPDATE plugin_tasks SET status='failed'/.test(sql)) return { rows: [] };
      if (/WITH candidate AS/.test(sql)) {
        const task = [...tasks.values()].find(t => t.status === 'pending' && t.available_at <= new Date());
        if (!task) return { rows: [] };
        task.status = 'running'; task.attempts += 1; task.locked_by = p[0]; task.locked_at = Date.now();
        return { rows: [{ ...task }] };
      }
      if (/UPDATE plugin_tasks SET status='pending'/.test(sql)) {
        const task = tasks.get(p[0]); task.status = 'pending'; task.last_error = p[2]; task.locked_by = null; task.available_at = new Date(Date.now() + p[1]);
        return { rows: [] };
      }
      if (/UPDATE plugin_tasks SET status=\$2/.test(sql)) {
        const task = tasks.get(p[0]); task.status = p[1]; task.result = p[2] ? JSON.parse(p[2]) : null; task.last_error = p[3]; task.locked_by = null;
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const loaded = new Set(['plugin-a']);
  const handlers = new Map([['plugin-a', new Map()]]);
  const queue = createTaskQueue({ pool, isLoaded: id => id === undefined ? loaded.size > 0 : loaded.has(id), getHandlers: id => handlers.get(id), logger: { warn() {} } });
  return { queue, tasks, handlers, loaded };
}

(async () => {
  assert.deepEqual(validatePayload({ a: 1 }), { a: 1 });
  assert.throws(() => validatePayload([]), /JSON 对象/);
  assert.throws(() => validatePayload({ x: 'a'.repeat(65540) }), /64 KiB/);
  const { queue, tasks, handlers, loaded } = fixture();
  let calls = 0;
  handlers.get('plugin-a').set('work', async payload => { calls++; return { accepted: payload.value }; });
  const one = await queue.enqueue('plugin-a', 'work', { value: 7 }, { idempotencyKey: 'same-key' });
  const duplicate = await queue.enqueue('plugin-a', 'work', { value: 8 }, { idempotencyKey: 'same-key' });
  assert.equal(one.id, duplicate.id);
  assert.equal(tasks.size, 1);
  await Promise.all([queue.tick(), queue.tick()]);
  assert.equal(calls, 1, 'parallel worker ticks claim a task only once');
  assert.equal(tasks.get(one.id).status, 'succeeded');
  assert.deepEqual(tasks.get(one.id).result, { accepted: 7 });
  assert.equal((await queue.get('another-plugin', one.id)), null, 'task status is plugin-scoped');

  let attempts = 0;
  handlers.get('plugin-a').set('retry', async () => { attempts++; throw new Error('expected failure'); });
  const retryTask = await queue.enqueue('plugin-a', 'retry', {}, { idempotencyKey: 'retry-key', maxAttempts: 2 });
  await queue.tick();
  assert.equal(tasks.get(retryTask.id).status, 'pending');
  tasks.get(retryTask.id).available_at = new Date(Date.now() - 1);
  await queue.tick();
  assert.equal(tasks.get(retryTask.id).status, 'failed');
  assert.equal(attempts, 2);

  const cancelTask = await queue.enqueue('plugin-a', 'work', {}, { idempotencyKey: 'cancel-key' });
  assert.equal((await queue.cancel('plugin-a', cancelTask.id)).status, 'cancelled');
  assert.equal(await queue.cancel('plugin-a', cancelTask.id), null);
  await assert.rejects(queue.enqueue('plugin-a', 'missing', {}, { idempotencyKey: 'x' }), /未注册/);
  await assert.rejects(queue.enqueue('plugin-a', 'work', { bad: 'x'.repeat(65540) }, { idempotencyKey: 'large' }), /64 KiB/);
  loaded.delete('plugin-a');
  await assert.rejects(queue.enqueue('plugin-a', 'work', {}, { idempotencyKey: 'stopped' }), /未启用/);
  console.log('PASS plugin task queue idempotency, scope, concurrent claim, retry, cancellation and bounds');
})().catch(error => { console.error(error); process.exitCode = 1; });
