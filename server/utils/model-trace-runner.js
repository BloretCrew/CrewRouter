'use strict';

const { Worker } = require('worker_threads');
const path = require('path');

async function analyze(outputs) {
  const worker = new Worker(path.join(__dirname, 'model-trace-worker.js'), { workerData: { outputs }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('归因计算超时')), 15000);
      worker.once('message', data => data.error ? reject(new Error(data.error)) : resolve(data.result));
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error('归因计算中断')); });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

function createRunner({ store, loadCore, transport, score = analyze }) {
  const queue = [];
  const running = new Map();
  let stopped = false;
  const shutdown = new AbortController();
  const shutdownError = new Error('ModelTrace runner stopped');

  async function untilShutdown(operation) {
    if (stopped) throw shutdownError;
    let onStop;
    const interrupted = new Promise((_, reject) => {
      onStop = () => reject(shutdownError);
      shutdown.signal.addEventListener('abort', onStop, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(() => { if (stopped) throw shutdownError; return operation(); }), interrupted]); }
    finally { shutdown.signal.removeEventListener('abort', onStop); }
  }

  async function retrySettlement(id, operation) {
    let recovered = false;
    let delay = 500;
    while (!stopped) {
      try {
        await untilShutdown(operation);
        return { done: true, recovered };
      } catch (_) {
        if (stopped) break;
        recovered = true;
        try { await untilShutdown(() => store.markSettlementPending(id)); }
        catch (_) { if (stopped) break; }
        let timer;
        try { await untilShutdown(() => new Promise(resolve => { timer = setTimeout(resolve, delay); })); }
        catch (_) { if (stopped) break; }
        finally { clearTimeout(timer); }
        delay = Math.min(delay * 2, 30000);
      }
    }
    return { done: false, recovered };
  }

  async function run(id, controller) {
    const job = await store.claim(id);
    if (!job) return;
    const outputs = [];
    try {
      const core = await loadCore();
      const challenges = core.generateChallenges(3);
      for (let index = 0; index < challenges.length; index++) {
        if (controller.signal.aborted) break;
        const challenge = challenges[index];
        const reserved = await store.reserve(id, index + 1, challenge.expected_count);
        if (!reserved) break;
        const timeout = setTimeout(() => controller.abort(), job.target.timeout_ms);
        let diagnostic;
        let knownUsage = null;
        try {
          const response = await transport({ ...reserved, target: job.target, prompt: challenge.prompt, signal: controller.signal,
            beforeSend: () => store.markSent(id, index + 1) });
          knownUsage = response.usage;
          const text = response.text || '';
          // Responses are only retained in this bounded in-memory scoring input.
          const numbers = core.parseNumbers(text);
          const valid = !response.error && numbers.length >= Math.max(80, Math.ceil(challenge.expected_count * 0.55));
          diagnostic = { usage: response.usage, definite_rejection: response.definite_rejection, response_model: response.response_model, number_count: numbers.length, valid,
            error: response.error || (valid ? null : '回答拒绝、截断或有效数字不足') };
          if (valid) outputs.push({ text, expected_count: challenge.expected_count });
        } catch (_) {
          diagnostic = { usage: knownUsage, error: controller.signal.aborted ? '检测已取消或超时，上游可能仍在生成' : '上游传输或响应失败，用量可能未知' };
        } finally { clearTimeout(timeout); }
        const settlement = await retrySettlement(id, () => store.settle(id, index + 1, diagnostic));
        if (!settlement.done) return;
        // A settlement outage ends generation even after the database recovers.
        if (settlement.recovered || controller.signal.aborted || diagnostic.definite_rejection) break;
      }
      if (stopped) return;
      let result = outputs.length ? await score(outputs) : null;
      if (result) result = { ...result, model_ranking: result.results, bank_version: job.version.algorithm_version, version: job.version };
      const status = controller.signal.aborted ? 'interrupted' : outputs.length === 3 ? 'completed' : outputs.length ? 'partial' : 'failed';
      await retrySettlement(id, () => store.finish(id, status, result, outputs.length ? null : '没有可用回答'));
    } catch (_) {
      if (!stopped) await retrySettlement(id, () => store.finish(id, 'failed', null, '任务失败：目标授权、配置、余额或计算状态不可用'));
    }
  }

  function pump() {
    if (stopped) return;
    while (running.size < 2 && queue.length) {
      const id = queue.shift();
      const controller = new AbortController();
      const promise = run(id, controller).catch(() => {}).finally(() => { running.delete(id); pump(); });
      running.set(id, { controller, promise });
    }
  }

  function enqueue(id) {
    if (stopped || running.has(id) || queue.includes(id)) return;
    queue.push(id);
    pump();
  }

  function cancel(id) { running.get(id)?.controller.abort(); }

  async function stop() {
    stopped = true;
    shutdown.abort();
    queue.length = 0;
    for (const item of running.values()) item.controller.abort();
    await Promise.all([...running.values()].map(item => item.promise));
  }

  return { enqueue, cancel, stop, idle: () => !queue.length && !running.size };
}

module.exports = { createRunner, analyze };
