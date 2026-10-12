'use strict';
const DEFAULTS = Object.freeze({ enabled: true, mode: 'async', reconciliation_seconds: 60, max_tries: 5, worker_interval_ms: 2000, batch_size: 10, lease_seconds: 120 });
function normalizeRequestQuotaConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的请求额度采集配置');
  const config = { ...DEFAULTS, ...value };
  if (typeof config.enabled !== 'boolean' || !['async', 'strict'].includes(config.mode)) throw new Error('无效的请求额度采集模式');
  for (const [key, min, max] of [['reconciliation_seconds',0,86400],['max_tries',1,20],['worker_interval_ms',500,60000],['batch_size',1,100],['lease_seconds',30,3600]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`${key} 必须是 ${min} 到 ${max} 的整数`);
  }
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULTS,key))) throw new Error('无效的请求额度配置字段');
  return config;
}
module.exports = { DEFAULTS, normalizeRequestQuotaConfig };
