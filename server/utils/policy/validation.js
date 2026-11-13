'use strict';

const net = require('net');
const { REQUEST_SOURCES } = require('../request-source');

const MAX_CONDITIONS_BYTES = 64 * 1024;
const MAX_ARRAY = 200;
const MAX_STRING = 200;

const SCOPES = new Set(['global', 'team', 'member']);
const EFFECTS = new Set(['deny', 'allow']);
const ACTIONS = new Set([
  'block', 'warn', 'shadow', 'notify', 'throttle', 'queue', 'downgrade',
  'approval', 'step_up', 'suspend', 'revoke_key', 'custom'
]);
const CATEGORIES = new Set([
  'client', 'identity', 'model', 'provider', 'network', 'time',
  'usage', 'capacity', 'content', 'session', 'combined'
]);
const STATUSES = new Set(['draft', 'published', 'archived']);
const PROTOCOLS = new Set(['openai', 'anthropic', 'responses', 'gemini', 'interactions', 'models']);
const SEMANTICS = new Set([
  'primary', 'subagent', 'compaction', 'review', 'plan', 'title',
  'other_automation', 'retry', 'heartbeat'
]);
const USAGE_METRICS = new Set(['requests', 'tokens', 'weighted_tokens', 'cost', 'points']);
const USAGE_WINDOWS = new Set(['1m', '5m', '1h', '24h', '7d', '30d', 'day', 'week', 'month']);
const USAGE_AGGREGATES = new Set(['member', 'team', 'api_key', 'client', 'model', 'provider']);
const USAGE_SCOPES = new Set(['member', 'team', 'api_key']);
const KNOWN_CLIENTS = new Set([...Object.values(REQUEST_SOURCES), 'unknown']);
const CONDITION_KEYS = new Set([
  'clients', 'protocols', 'endpoints', 'semantics', 'models', 'providers',
  'tools', 'mcp_servers', 'ips', 'tags', 'identities', 'api_keys',
  'oauth_clients', 'session', 'prompt', 'output', 'media', 'limits', 'schedule',
  'usage', 'budget', 'concurrency', 'login', 'countries', 'countries_deny', 'asn',
  'all', 'any', 'not'
]);
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class PolicyValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'PolicyValidationError';
    this.details = details;
    this.status = 400;
    this.code = 'policy_invalid';
  }
}

function fail(field, message, details) {
  details.push({ field, message });
}

function asStringArray(value, field, details, { max = MAX_ARRAY, allowed = null } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    fail(field, '必须是数组', details);
    return [];
  }
  if (value.length > max) fail(field, `最多 ${max} 项`, details);
  const out = [];
  for (const item of value) {
    const text = String(item == null ? '' : item).trim();
    if (!text) continue;
    if (text.length > MAX_STRING) fail(field, '单项长度超过上限', details);
    if (allowed && !allowed.has(text)) fail(field, `不支持的取值: ${text}`, details);
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

function asNumber(value, field, details, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value == null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    fail(field, '必须是数字', details);
    return null;
  }
  if (num < min || num > max) fail(field, `必须在 ${min} 到 ${max} 之间`, details);
  return integer ? Math.trunc(num) : num;
}

function asBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeIso(value, field, details) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail(field, '时间格式无效', details);
    return null;
  }
  return date.toISOString();
}

function validateTimezone(value, field, details) {
  if (!value) return 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch (_) {
    fail(field, '无效的 IANA 时区', details);
    return 'Asia/Shanghai';
  }
}

function validateCidr(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const [ip, prefixText] = text.split('/');
  const family = net.isIP(ip);
  if (!family) return false;
  if (prefixText === undefined) return true;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix)) return false;
  return family === 4 ? prefix >= 0 && prefix <= 32 : prefix >= 0 && prefix <= 128;
}

function normalizeSchedule(schedule, field, details) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    fail(field, '日程必须是对象', details);
    return null;
  }
  const timezone = validateTimezone(schedule.timezone, `${field}.timezone`, details);
  const weekly = {};
  if (schedule.weekly != null) {
    if (typeof schedule.weekly !== 'object' || Array.isArray(schedule.weekly)) {
      fail(`${field}.weekly`, '必须是按星期的对象', details);
    } else {
      for (const [day, ranges] of Object.entries(schedule.weekly)) {
        if (!WEEKDAYS.includes(day)) {
          fail(`${field}.weekly`, `未知星期: ${day}`, details);
          continue;
        }
        if (!Array.isArray(ranges)) {
          fail(`${field}.weekly.${day}`, '必须是时间段数组', details);
          continue;
        }
        weekly[day] = [];
        for (const range of ranges) {
          if (!Array.isArray(range) || range.length !== 2) {
            fail(`${field}.weekly.${day}`, '时间段格式应为 ["HH:mm","HH:mm"]', details);
            continue;
          }
          const [start, end] = range.map(item => String(item || '').trim());
          if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
            fail(`${field}.weekly.${day}`, '时间必须是 HH:mm', details);
            continue;
          }
          if (start === end) {
            fail(`${field}.weekly.${day}`, '开始与结束时间不能相同', details);
            continue;
          }
          weekly[day].push([start, end]);
        }
      }
    }
  }
  const dates = asStringArray(schedule.dates, `${field}.dates`, details, { max: 366 });
  for (const date of dates) if (!DATE_RE.test(date)) fail(`${field}.dates`, `日期格式无效: ${date}`, details);
  const exclude_dates = asStringArray(schedule.exclude_dates, `${field}.exclude_dates`, details, { max: 366 });
  for (const date of exclude_dates) if (!DATE_RE.test(date)) fail(`${field}.exclude_dates`, `日期格式无效: ${date}`, details);
  const result = { timezone, weekly, dates, exclude_dates };
  if (schedule.calendar_id != null) result.calendar_id = asNumber(schedule.calendar_id, `${field}.calendar_id`, details, { min: 1, integer: true });
  return result;
}

function normalizeUsage(usage, field, details) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    fail(field, '用量条件必须是对象', details);
    return null;
  }
  const metric = String(usage.metric || '');
  if (!USAGE_METRICS.has(metric)) fail(`${field}.metric`, '不支持的用量指标', details);
  const window = String(usage.window || '');
  if (!USAGE_WINDOWS.has(window)) fail(`${field}.window`, '不支持的时间窗口', details);
  const aggregate = String(usage.aggregate || 'member');
  if (!USAGE_AGGREGATES.has(aggregate)) fail(`${field}.aggregate`, '不支持的聚合维度', details);
  const gte = asNumber(usage.gte, `${field}.gte`, details, { min: 0 });
  if (gte == null) fail(`${field}.gte`, '必须设置阈值', details);
  return { metric, window, aggregate, gte: gte == null ? 0 : gte };
}

function normalizeBudget(budget, field, details) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    fail(field, '预算条件必须是对象', details);
    return null;
  }
  const metric = String(budget.metric || 'cost');
  if (!['cost', 'points', 'tokens', 'weighted_tokens'].includes(metric)) {
    fail(`${field}.metric`, '不支持的预算指标', details);
  }
  const period = String(budget.period || 'month');
  if (!['day', 'week', 'month'].includes(period)) fail(`${field}.period`, '不支持的预算周期', details);
  const aggregate = String(budget.aggregate || 'team');
  if (!['member', 'team'].includes(aggregate)) fail(`${field}.aggregate`, '不支持的预算聚合', details);
  const gte = asNumber(budget.gte, `${field}.gte`, details, { min: 0 });
  if (gte == null) fail(`${field}.gte`, '必须设置阈值', details);
  return { metric, period, aggregate, gte: gte == null ? 0 : gte };
}

function normalizeConcurrency(value, field, details) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, '并发条件必须是对象', details);
    return null;
  }
  const max = asNumber(value.max, `${field}.max`, details, { min: 1, max: 1000, integer: true });
  if (max == null) fail(`${field}.max`, '必须设置并发上限', details);
  const aggregate = String(value.aggregate || 'member');
  if (!['member', 'team', 'api_key', 'model'].includes(aggregate)) {
    fail(`${field}.aggregate`, '不支持的并发聚合', details);
  }
  return { max: max || 1, aggregate };
}

function normalizePrompt(prompt, field, details) {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) {
    fail(field, '提示词条件必须是对象', details);
    return null;
  }
  const contains = asStringArray(prompt.contains, `${field}.contains`, details, { max: 50 });
  const regex = asStringArray(prompt.regex, `${field}.regex`, details, { max: 20 });
  for (const pattern of regex) {
    if (pattern.length > MAX_STRING) {
      fail(`${field}.regex`, '正则长度超过上限', details);
      continue;
    }
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern, 'i');
    } catch (_) {
      fail(`${field}.regex`, `无效的正则: ${pattern}`, details);
    }
  }
  return { contains, regex };
}

function normalizeTools(tools, field, details) {
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    fail(field, '工具条件必须是对象', details);
    return null;
  }
  return {
    names: asStringArray(tools.names, `${field}.names`, details, { max: 100 }),
    max_count: asNumber(tools.max_count, `${field}.max_count`, details, { min: 0, max: 10000, integer: true }),
    forbid_any: tools.forbid_any === true,
  };
}

function normalizeIdentities(identities, field, details) {
  if (!identities || typeof identities !== 'object' || Array.isArray(identities)) {
    fail(field, '身份条件必须是对象', details);
    return null;
  }
  const roles = asStringArray(identities.roles, `${field}.roles`, details, { max: 10, allowed: new Set(['admin', 'member']) });
  return {
    roles,
    tags: asStringArray(identities.tags, `${field}.tags`, details, { max: 50 }),
    admin: typeof identities.admin === 'boolean' ? identities.admin : null,
    new_member_days: asNumber(identities.new_member_days, `${field}.new_member_days`, details, { min: 0, max: 3650, integer: true }),
  };
}

function normalizeApiKeys(value, field, details) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, 'API Key 条件必须是对象', details);
    return null;
  }
  const ids = Array.isArray(value.ids)
    ? value.ids.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0)
    : [];
  return {
    ids: ids.slice(0, MAX_ARRAY),
    names: asStringArray(value.names, `${field}.names`, details, { max: 50 }),
    older_than_days: asNumber(value.older_than_days, `${field}.older_than_days`, details, { min: 0, max: 3650, integer: true }),
    shared: typeof value.shared === 'boolean' ? value.shared : null,
  };
}

function normalizeSession(value, field, details) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, '会话条件必须是对象', details);
    return null;
  }
  return {
    subagent: typeof value.subagent === 'boolean' ? value.subagent : null,
    compaction: typeof value.compaction === 'boolean' ? value.compaction : null,
    cwd_prefix: asStringArray(value.cwd_prefix, `${field}.cwd_prefix`, details, { max: 50 }),
  };
}

function normalizeMedia(value, field, details) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, '媒体条件必须是对象', details);
    return null;
  }
  return {
    max_images: asNumber(value.max_images, `${field}.max_images`, details, { min: 0, max: 1000, integer: true }),
    forbid_attachments: value.forbid_attachments === true,
  };
}

function normalizeLimits(value, field, details) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, '限制条件必须是对象', details);
    return null;
  }
  return {
    max_tokens: asNumber(value.max_tokens, `${field}.max_tokens`, details, { min: 0 }),
    max_messages: asNumber(value.max_messages, `${field}.max_messages`, details, { min: 0, integer: true }),
    max_body_bytes: asNumber(value.max_body_bytes, `${field}.max_body_bytes`, details, { min: 0, integer: true }),
  };
}

function normalizeEndpoints(value, field, details) {
  if (!Array.isArray(value)) {
    fail(field, '必须是数组', details);
    return [];
  }
  const out = [];
  for (const item of value.slice(0, 50)) {
    if (!item || typeof item !== 'object') {
      fail(field, '端点项必须是对象', details);
      continue;
    }
    const methods = Array.isArray(item.methods)
      ? item.methods.map(m => String(m || '').toUpperCase()).filter(m => /^[A-Z]{3,10}$/.test(m))
      : [];
    const path = String(item.path || '').trim();
    if (!path) {
      fail(field, '端点必须包含 path', details);
      continue;
    }
    out.push({ methods, path });
  }
  return out;
}

function normalizeLogin(value, field, details) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, '登录条件必须是对象', details);
    return null;
  }
  const methods = asStringArray(value.methods, `${field}.methods`, details, {
    allowed: new Set(['password', 'password+2fa', 'passkey', 'feishu', 'passport']),
  });
  return {
    methods,
    require_mfa: value.require_mfa === true,
    max_failed_attempts: asNumber(value.max_failed_attempts, `${field}.max_failed_attempts`, details, { min: 1, max: 1000, integer: true }),
    window_minutes: asNumber(value.window_minutes, `${field}.window_minutes`, details, { min: 1, max: 1440, integer: true }) || 30,
  };
}

function normalizeConditionObject(raw) {
  const details = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyValidationError('策略条件必须是对象', [{ field: 'conditions', message: '必须是对象' }]);
  }
  for (const key of Object.keys(raw)) {
    if (!CONDITION_KEYS.has(key)) fail('conditions', `未知条件字段: ${key}`, details);
  }
  const out = {};
  if (raw.clients !== undefined) out.clients = asStringArray(raw.clients, 'conditions.clients', details, { allowed: KNOWN_CLIENTS });
  if (raw.protocols !== undefined) out.protocols = asStringArray(raw.protocols, 'conditions.protocols', details, { allowed: PROTOCOLS });
  if (raw.endpoints !== undefined) out.endpoints = normalizeEndpoints(raw.endpoints, 'conditions.endpoints', details);
  if (raw.semantics !== undefined) out.semantics = asStringArray(raw.semantics, 'conditions.semantics', details, { allowed: SEMANTICS });
  if (raw.models !== undefined) out.models = asStringArray(raw.models, 'conditions.models', details);
  if (raw.providers !== undefined) out.providers = asStringArray(raw.providers, 'conditions.providers', details);
  if (raw.tools !== undefined) out.tools = normalizeTools(raw.tools, 'conditions.tools', details);
  if (raw.mcp_servers !== undefined) out.mcp_servers = asStringArray(raw.mcp_servers, 'conditions.mcp_servers', details);
  if (raw.ips !== undefined) {
    out.ips = asStringArray(raw.ips, 'conditions.ips', details);
    for (const cidr of out.ips) if (!validateCidr(cidr)) fail('conditions.ips', `无效的 IP/CIDR: ${cidr}`, details);
  }
  if (raw.tags !== undefined) out.tags = asStringArray(raw.tags, 'conditions.tags', details);
  if (raw.identities !== undefined) out.identities = normalizeIdentities(raw.identities, 'conditions.identities', details);
  if (raw.api_keys !== undefined) out.api_keys = normalizeApiKeys(raw.api_keys, 'conditions.api_keys', details);
  if (raw.oauth_clients !== undefined) out.oauth_clients = asStringArray(raw.oauth_clients, 'conditions.oauth_clients', details);
  if (raw.session !== undefined) out.session = normalizeSession(raw.session, 'conditions.session', details);
  if (raw.prompt !== undefined) out.prompt = normalizePrompt(raw.prompt, 'conditions.prompt', details);
  if (raw.output !== undefined) out.output = normalizePrompt(raw.output, 'conditions.output', details);
  if (raw.media !== undefined) out.media = normalizeMedia(raw.media, 'conditions.media', details);
  if (raw.limits !== undefined) out.limits = normalizeLimits(raw.limits, 'conditions.limits', details);
  if (raw.schedule !== undefined) out.schedule = normalizeSchedule(raw.schedule, 'conditions.schedule', details);
  if (raw.usage !== undefined) out.usage = normalizeUsage(raw.usage, 'conditions.usage', details);
  if (raw.budget !== undefined) out.budget = normalizeBudget(raw.budget, 'conditions.budget', details);
  if (raw.concurrency !== undefined) out.concurrency = normalizeConcurrency(raw.concurrency, 'conditions.concurrency', details);
  if (raw.login !== undefined) out.login = normalizeLogin(raw.login, 'conditions.login', details);
  if (raw.countries !== undefined) {
    out.countries = asStringArray(raw.countries, 'conditions.countries', details, { max: 250 })
      .map(code => code.toUpperCase());
    for (const code of out.countries) if (!/^[A-Z]{2}$/.test(code)) fail('conditions.countries', `国家代码无效: ${code}`, details);
  }
  if (raw.countries_deny !== undefined) {
    out.countries_deny = asStringArray(raw.countries_deny, 'conditions.countries_deny', details, { max: 250 })
      .map(code => code.toUpperCase());
    for (const code of out.countries_deny) if (!/^[A-Z]{2}$/.test(code)) fail('conditions.countries_deny', `国家代码无效: ${code}`, details);
  }
  if (raw.asn !== undefined) out.asn = asStringArray(raw.asn, 'conditions.asn', details, { max: 100 });
  if (raw.all !== undefined) out.all = normalizeConditionTree(raw.all, 'conditions.all', details, 1);
  if (raw.any !== undefined) out.any = normalizeConditionTree(raw.any, 'conditions.any', details, 1);
  if (raw.not !== undefined) out.not = normalizeConditionTree([raw.not], 'conditions.not', details, 1)[0] || null;

  const meaningful = Object.keys(out).filter(key => key !== 'all' && key !== 'any' && key !== 'not');
  if (!meaningful.length && !out.all?.length && !out.any?.length && !out.not) {
    fail('conditions', '至少需要一个有效条件', details);
  }
  const serialized = JSON.stringify(out);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONDITIONS_BYTES) {
    fail('conditions', '条件体积超过 64KB', details);
  }
  if (details.length) throw new PolicyValidationError('策略条件无效', details);
  return out;
}

function normalizeConditionTree(value, field, details, depth) {
  if (depth > 5) {
    fail(field, '条件嵌套超过 5 层', details);
    return [];
  }
  if (!Array.isArray(value)) {
    fail(field, '必须是条件数组', details);
    return [];
  }
  const out = [];
  for (const item of value.slice(0, 100)) {
    try {
      out.push(normalizeConditionObject(item));
    } catch (error) {
      details.push(...(error.details || []));
    }
  }
  return out;
}

function normalizeLadder(ladder, details) {
  if (ladder == null) return [];
  if (!Array.isArray(ladder)) {
    fail('ladder', '必须是数组', details);
    return [];
  }
  const out = [];
  let previous = -1;
  for (const item of ladder.slice(0, 20)) {
    if (!item || typeof item !== 'object') {
      fail('ladder', '阶梯项必须是对象', details);
      continue;
    }
    const after = asNumber(item.after_hits, 'ladder.after_hits', details, { min: 0, max: 100000, integer: true });
    if (after == null) {
      fail('ladder.after_hits', '必须设置 after_hits', details);
      continue;
    }
    if (after <= previous) fail('ladder.after_hits', '必须严格递增', details);
    previous = after;
    const action = String(item.action || '');
    if (!ACTIONS.has(action)) fail('ladder.action', `不支持的动作: ${action}`, details);
    out.push({
      after_hits: after,
      action,
      options: item.options && typeof item.options === 'object' && !Array.isArray(item.options) ? item.options : {},
    });
  }
  return out;
}

function normalizePolicyInput(input, { partial = false } = {}) {
  const details = [];
  const source = input && typeof input === 'object' ? input : {};
  const out = {};

  if (!partial || source.name !== undefined) {
    const name = String(source.name == null ? '' : source.name).trim();
    if (!name) fail('name', '名称不能为空', details);
    if (name.length > 120) fail('name', '名称最多 120 个字符', details);
    out.name = name;
  }
  if (!partial || source.description !== undefined) {
    out.description = String(source.description == null ? '' : source.description).slice(0, 4000);
  }
  if (!partial || source.scope_type !== undefined) {
    const scope = String(source.scope_type || 'team');
    if (!SCOPES.has(scope)) fail('scope_type', '作用域必须是 global/team/member', details);
    out.scope_type = scope;
  }
  if (!partial || source.scope_id !== undefined) {
    const scope = out.scope_type || source.scope_type;
    if (scope === 'global') {
      out.scope_id = null;
    } else {
      const id = asNumber(source.scope_id, 'scope_id', details, { min: 1, integer: true });
      if (id == null) fail('scope_id', '必须指定作用域 ID', details);
      out.scope_id = id;
    }
  }
  if (!partial || source.effect !== undefined) {
    const effect = String(source.effect || 'deny');
    if (!EFFECTS.has(effect)) fail('effect', '效果必须是 deny/allow', details);
    out.effect = effect;
  }
  if (!partial || source.action !== undefined) {
    const action = String(source.action || 'block');
    if (!ACTIONS.has(action)) fail('action', '不支持的动作', details);
    out.action = action;
  }
  if (!partial || source.action_options !== undefined) {
    out.action_options = source.action_options && typeof source.action_options === 'object' && !Array.isArray(source.action_options)
      ? source.action_options : {};
    const options = out.action_options;
    if (options.throttle_ms != null) options.throttle_ms = asNumber(options.throttle_ms, 'action_options.throttle_ms', details, { min: 0, max: 60000, integer: true });
    if (options.queue_wait_ms != null) options.queue_wait_ms = asNumber(options.queue_wait_ms, 'action_options.queue_wait_ms', details, { min: 0, max: 120000, integer: true });
    if (options.queue_max != null) options.queue_max = asNumber(options.queue_max, 'action_options.queue_max', details, { min: 1, max: 1000, integer: true });
    if (options.queue_max_length != null) options.queue_max_length = asNumber(options.queue_max_length, 'action_options.queue_max_length', details, { min: 1, max: 10000, integer: true });
    if (options.queue_aggregate != null) options.queue_aggregate = String(options.queue_aggregate);
    if (options.rpm != null) options.rpm = asNumber(options.rpm, 'action_options.rpm', details, { min: 0, max: 1000000, integer: true });
    if (options.tpm != null) options.tpm = asNumber(options.tpm, 'action_options.tpm', details, { min: 0, max: 1000000000, integer: true });
    if (options.ladder_window_seconds != null) options.ladder_window_seconds = asNumber(options.ladder_window_seconds, 'action_options.ladder_window_seconds', details, { min: 60, max: 2592000, integer: true });
    if (options.approval_ttl_seconds != null) options.approval_ttl_seconds = asNumber(options.approval_ttl_seconds, 'action_options.approval_ttl_seconds', details, { min: 60, max: 604800, integer: true });
    if (options.suspend_seconds != null) options.suspend_seconds = asNumber(options.suspend_seconds, 'action_options.suspend_seconds', details, { min: 60, max: 31536000, integer: true });
    if (options.suspend_scope != null) options.suspend_scope = options.suspend_scope === 'api' ? 'api' : 'all';
    if (options.custom_status != null) options.custom_status = asNumber(options.custom_status, 'action_options.custom_status', details, { min: 100, max: 599, integer: true });
    if (options.downgrade_to != null) options.downgrade_to = String(options.downgrade_to).trim().slice(0, 200);
    if (options.custom_message != null) options.custom_message = String(options.custom_message).slice(0, 2000);
  }
  if (!partial || source.ladder !== undefined) out.ladder = normalizeLadder(source.ladder, details);
  if (!partial || source.priority !== undefined) {
    out.priority = asNumber(source.priority, 'priority', details, { min: 0, max: 1000, integer: true }) ?? 100;
  }
  if (!partial || source.category !== undefined) {
    const category = String(source.category || 'combined');
    if (!CATEGORIES.has(category)) fail('category', '不支持的分类', details);
    out.category = category;
  }
  if (!partial || source.conditions !== undefined) out.conditions = normalizeConditionObject(source.conditions || {});
  if (!partial || source.status !== undefined) {
    const status = String(source.status || 'published');
    if (!STATUSES.has(status)) fail('status', '状态必须是 draft/published/archived', details);
    out.status = status;
  }
  if (!partial || source.group_id !== undefined) out.group_id = asNumber(source.group_id, 'group_id', details, { min: 1, integer: true });
  if (!partial || source.tags !== undefined) out.tags = asStringArray(source.tags, 'tags', details, { max: 50 });
  if (!partial || source.rollout_percent !== undefined) {
    out.rollout_percent = asNumber(source.rollout_percent, 'rollout_percent', details, { min: 0, max: 100, integer: true }) ?? 100;
  }
  if (!partial || source.status_code !== undefined) {
    const statusCode = asNumber(source.status_code, 'status_code', details, { min: 400, max: 599, integer: true }) ?? 403;
    if (![403, 429].includes(statusCode)) fail('status_code', '仅支持 403 或 429', details);
    out.status_code = statusCode;
  }
  if (!partial || source.message_template !== undefined) {
    out.message_template = String(source.message_template == null ? '' : source.message_template).slice(0, 2000);
  }
  if (!partial || source.notify_channels !== undefined) {
    out.notify_channels = source.notify_channels && typeof source.notify_channels === 'object' && !Array.isArray(source.notify_channels)
      ? source.notify_channels : {};
  }
  if (!partial || source.starts_at !== undefined) out.starts_at = normalizeIso(source.starts_at, 'starts_at', details);
  if (!partial || source.ends_at !== undefined) out.ends_at = normalizeIso(source.ends_at, 'ends_at', details);
  if (!partial || source.auto_publish_at !== undefined) out.auto_publish_at = normalizeIso(source.auto_publish_at, 'auto_publish_at', details);
  if (!partial || source.bypass_until !== undefined) out.bypass_until = normalizeIso(source.bypass_until, 'bypass_until', details);
  if (!partial || source.enabled !== undefined) out.enabled = source.enabled == null ? true : asBoolean(source.enabled);

  if (out.starts_at && out.ends_at && new Date(out.ends_at) <= new Date(out.starts_at)) {
    fail('ends_at', '结束时间必须晚于开始时间', details);
  }
  if (out.effect === 'allow' && !['warn', 'shadow', 'notify'].includes(out.action)) {
    out.action = 'warn';
  }
  if (details.length) throw new PolicyValidationError('策略无效', details);
  return out;
}

function normalizePolicySettingsInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const details = [];
  const out = {};
  const enforcement = String(source.enforcement_mode || 'enforce');
  if (!['enforce', 'shadow'].includes(enforcement)) fail('enforcement_mode', '执行模式无效', details);
  out.enforcement_mode = enforcement;
  const failMode = String(source.fail_mode || 'open');
  if (!['open', 'closed'].includes(failMode)) fail('fail_mode', '失败模式无效', details);
  out.fail_mode = failMode;
  out.kill_switch = source.kill_switch === true;
  out.kill_switch_until = normalizeIso(source.kill_switch_until, 'kill_switch_until', details);
  out.default_timezone = validateTimezone(source.default_timezone || 'Asia/Shanghai', 'default_timezone', details);
  out.allowlist_dimensions = asStringArray(source.allowlist_dimensions, 'allowlist_dimensions', details, {
    allowed: new Set(['clients', 'models', 'providers', 'ips', 'protocols'])
  });
  out.require_approval_for_publish = source.require_approval_for_publish === true;
  out.require_approval_for_delete = source.require_approval_for_delete === true;
  out.notify_admins = source.notify_admins !== false;
  out.notify_member = source.notify_member !== false;
  out.alert_email_enabled = source.alert_email_enabled === true;
  out.alert_email_to = String(source.alert_email_to || '').slice(0, 1000);
  out.hit_retention_days = asNumber(source.hit_retention_days, 'hit_retention_days', details, { min: 1, max: 3650, integer: true }) ?? 90;
  out.metrics_retention_days = asNumber(source.metrics_retention_days, 'metrics_retention_days', details, { min: 1, max: 3650, integer: true }) ?? 365;
  out.max_policies_per_team = asNumber(source.max_policies_per_team, 'max_policies_per_team', details, { min: 1, max: 10000, integer: true }) ?? 500;
  if (details.length) throw new PolicyValidationError('策略设置无效', details);
  return out;
}

module.exports = {
  PolicyValidationError,
  normalizePolicyInput,
  normalizePolicySettingsInput,
  normalizeConditionObject,
  validateCidr,
  validateTimezone,
  MAX_CONDITIONS_BYTES,
  ACTIONS,
  EFFECTS,
  CATEGORIES,
  PROTOCOLS,
  USAGE_METRICS,
  USAGE_WINDOWS,
  USAGE_AGGREGATES,
};
