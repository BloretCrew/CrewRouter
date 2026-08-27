'use strict';

const crypto = require('crypto');
const Logger = require('../logger');
const { logRetention } = require('./retention-log');

let running = false;
const tasks = new Map();
const MAX_TASKS = 100;

function getTask(taskId) {
  return tasks.get(taskId) || null;
}

function startTask(kind, fn, { dryRun = false } = {}) {
  if (running) return { conflict: true, taskId: null };
  const taskId = crypto.randomUUID();
  const task = { taskId, kind, dryRun, status: 'queued', createdAt: new Date().toISOString(), result: null, error: null };
  tasks.set(taskId, task);
  while (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value);
  running = true;
  Promise.resolve().then(async () => {
    task.status = 'running';
    try {
      task.result = await fn({ dryRun });
      task.status = 'completed';
      logRetention(`[后台任务] ${kind} ${taskId} 完成`);
    } catch (error) {
      task.error = { code: error.code || 'RETENTION_TASK_FAILED', message: error.message };
      task.status = 'failed';
      Logger.error(`[后台任务] ${kind} ${taskId} 失败: ${error.message}`);
      logRetention(`[后台任务] ${kind} ${taskId} 失败: ${error.message}`);
    } finally {
      running = false;
      task.finishedAt = new Date().toISOString();
    }
  });
  return { conflict: false, taskId };
}

async function runExclusive(kind, fn) {
  if (running) {
    logRetention(`[保留任务] ${kind} 跳过：已有任务运行中`);
    return { skipped: 'busy', kind };
  }
  running = true;
  try {
    return await fn();
  } finally {
    running = false;
  }
}

function isRunning() { return running; }

module.exports = { startTask, getTask, runExclusive, isRunning };
