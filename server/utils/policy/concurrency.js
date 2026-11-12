'use strict';

/**
 * 进程内并发/排队管理器。
 * 多进程部署时为近似值；精确多实例计数可在后续阶段接入数据库。
 */

const groups = new Map(); // key -> { active: number, queue: [{ resolve, reject, timer }] }
const MAX_GROUPS = 5000;

function subjectKey(ctx, aggregate) {
  const actor = ctx.actor || {};
  if (aggregate === 'team') return `team:${actor.teamId}`;
  if (aggregate === 'api_key') return `key:${actor.keyId}`;
  if (aggregate === 'model') return `model:${ctx.request?.model || 'unknown'}`;
  return `user:${actor.userId}`;
}

function getGroup(key) {
  let group = groups.get(key);
  if (!group) {
    group = { active: 0, queue: [] };
    groups.set(key, group);
    if (groups.size > MAX_GROUPS) {
      for (const [k, value] of groups) {
        if (value.active === 0 && value.queue.length === 0) groups.delete(k);
        if (groups.size <= MAX_GROUPS) break;
      }
    }
  }
  return group;
}

function getActive(ctx, aggregate) {
  return getGroup(subjectKey(ctx, aggregate)).active;
}

function acquire(ctx, { max = 1, aggregate = 'member', waitMs = 30000, maxQueue = 100 } = {}) {
  const key = subjectKey(ctx, aggregate);
  const group = getGroup(key);
  if (group.active < max) {
    group.active += 1;
    let released = false;
    return Promise.resolve(() => {
      if (released) return;
      released = true;
      release(key);
    });
  }
  if (group.queue.length >= maxQueue) {
    return Promise.reject(Object.assign(new Error('policy_queue_full'), { code: 'policy_queue_full' }));
  }
  return new Promise((resolve, reject) => {
    const entry = {
      resolve: () => {
        clearTimeout(entry.timer);
        group.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          release(key);
        });
      },
      reject,
      timer: setTimeout(() => {
        const index = group.queue.indexOf(entry);
        if (index >= 0) group.queue.splice(index, 1);
        reject(Object.assign(new Error('policy_queue_timeout'), { code: 'policy_queue_timeout' }));
      }, Math.max(0, waitMs)),
    };
    entry.timer.unref?.();
    group.queue.push(entry);
  });
}

function release(key) {
  const group = groups.get(key);
  if (!group) return;
  group.active = Math.max(0, group.active - 1);
  while (group.queue.length && group.active >= 0) {
    const next = group.queue.shift();
    next.resolve();
    return;
  }
  if (group.active === 0 && group.queue.length === 0) groups.delete(key);
}

function stats() {
  let active = 0;
  let queued = 0;
  for (const group of groups.values()) {
    active += group.active;
    queued += group.queue.length;
  }
  return { groups: groups.size, active, queued };
}

module.exports = { acquire, getActive, release, stats, subjectKey };
