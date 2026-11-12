'use strict';

const net = require('net');
const { extractPromptCorpus } = require('../request-source');

function escapeRegex(text) {
  return String(text).replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob) {
  const text = String(glob || '').trim();
  if (!text) return null;
  const body = text.split('*').map(escapeRegex).join('.*').replace(/\?/g, '.');
  try {
    return new RegExp(`^${body}$`, 'i');
  } catch (_) {
    return null;
  }
}

function anyGlobMatch(globs, values) {
  if (!Array.isArray(globs) || !globs.length) return false;
  const list = Array.isArray(values) ? values.filter(Boolean) : [values].filter(Boolean);
  if (!list.length) return false;
  for (const glob of globs) {
    const re = glob.isRegex ? glob : globToRegex(glob);
    if (!re) continue;
    for (const value of list) {
      if (re.test(String(value))) return true;
    }
  }
  return false;
}

function buildBlockList(cidrs) {
  const v4 = new net.BlockList();
  const v6 = new net.BlockList();
  let has = false;
  for (const cidr of cidrs || []) {
    const [ip, prefixText] = String(cidr).split('/');
    const family = net.isIP(ip);
    if (!family) continue;
    const prefix = prefixText === undefined ? (family === 4 ? 32 : 128) : Number(prefixText);
    try {
      if (family === 4) v4.addSubnet(ip, prefix, 'ipv4');
      else v6.addSubnet(ip, prefix, 'ipv6');
      has = true;
    } catch (_) { /* ignore invalid */ }
  }
  return has ? { v4, v6 } : null;
}

function compileConditions(conditions) {
  const out = { ...(conditions || {}) };
  if (out.models) {
    out.models = [...out.models];
    out.models._modelRegex = out.models.map(globToRegex).filter(Boolean);
  }
  if (out.providers) {
    out.providers = [...out.providers];
    out.providers._providerRegex = out.providers.map(globToRegex).filter(Boolean);
  }
  if (out.oauth_clients) {
    out.oauth_clients = [...out.oauth_clients];
    out.oauth_clients._oauthRegex = out.oauth_clients.map(globToRegex).filter(Boolean);
  }
  if (out.mcp_servers) {
    out.mcp_servers = [...out.mcp_servers];
    out.mcp_servers._mcpRegex = out.mcp_servers.map(globToRegex).filter(Boolean);
  }
  if (out.ips) {
    out.ips = [...out.ips];
    out.ips._blockList = buildBlockList(out.ips);
  }
  if (out.tools?.names) out.tools = { ...out.tools, _nameRegex: out.tools.names.map(globToRegex).filter(Boolean) };
  if (out.session?.cwd_prefix) out.session = { ...out.session, _cwdPrefixes: out.session.cwd_prefix.map(String) };
  if (out.prompt?.regex) out.prompt = { ...out.prompt, _regex: out.prompt.regex.map(p => { try { return new RegExp(p, 'i'); } catch (_) { return null; } }).filter(Boolean) };
  if (out.endpoints) out.endpoints = out.endpoints.map(item => ({ ...item, _pathRe: globToRegex(item.path) }));
  if (Array.isArray(out.all)) out.all = out.all.map(compileConditions);
  if (Array.isArray(out.any)) out.any = out.any.map(compileConditions);
  if (out.not) out.not = compileConditions(out.not);
  return out;
}

function compilePolicy(policy) {
  return { ...policy, _compiled: compileConditions(policy.conditions) };
}

const WEEKDAY_MAP = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };

function zonedClock(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const get = type => parts.find(p => p.type === type)?.value || '';
    return {
      weekday: WEEKDAY_MAP[get('weekday')] || '',
      date: `${get('year')}-${get('month')}-${get('day')}`,
      minutes: Number(get('hour')) * 60 + Number(get('minute')),
    };
  } catch (_) {
    return null;
  }
}

function timeToMinutes(text) {
  const [h, m] = String(text || '').split(':').map(Number);
  return h * 60 + m;
}

function matchSchedule(schedule, now) {
  if (!schedule) return true;
  const clock = zonedClock(now, schedule.timezone || 'Asia/Shanghai');
  if (!clock) return false;
  if (Array.isArray(schedule.exclude_dates) && schedule.exclude_dates.includes(clock.date)) return false;
  if (Array.isArray(schedule.dates) && schedule.dates.length && !schedule.dates.includes(clock.date)) return false;
  const weekly = schedule.weekly || {};
  if (!Object.keys(weekly).length) return true;
  const ranges = weekly[clock.weekday] || [];
  for (const [startText, endText] of ranges) {
    const start = timeToMinutes(startText);
    const end = timeToMinutes(endText);
    if (start < end) {
      if (clock.minutes >= start && clock.minutes < end) return true;
    } else {
      // 跨午夜：22:00-06:00。凌晨部分命中当天窗口的 end 之前。
      if (clock.minutes >= start || clock.minutes < end) return true;
    }
  }
  return false;
}

function matchIp(blockList, ip) {
  if (!blockList || !ip) return false;
  const address = String(ip).replace(/^::ffff:/, '');
  const family = net.isIP(address);
  try {
    if (family === 4) return blockList.v4.check(address, 'ipv4');
    if (family === 6) return blockList.v6.check(address, 'ipv6');
  } catch (_) { /* ignore */ }
  return false;
}

function matchEndpoint(endpoints, method, path) {
  if (!Array.isArray(endpoints) || !endpoints.length) return false;
  return endpoints.some(item => {
    if (Array.isArray(item.methods) && item.methods.length && !item.methods.includes(String(method || '').toUpperCase())) return false;
    return item._pathRe ? item._pathRe.test(String(path || '')) : String(path || '') === item.path;
  });
}

function modelCandidates(ctx) {
  const values = new Set();
  if (ctx.request?.model) values.add(ctx.request.model);
  for (const id of ctx.request?.modelCandidates || []) if (id) values.add(id);
  for (const id of ctx.actor?.harnessModels ? Object.values(ctx.actor.harnessModels) : []) if (id) values.add(id);
  if (ctx.actor?.currentModelId) values.add(ctx.actor.currentModelId);
  if (ctx.actor?.customModelName) values.add(ctx.actor.customModelName);
  return [...values];
}

function usageSubject(ctx, aggregate) {
  if (aggregate === 'team') return { type: 'team', id: ctx.actor?.teamId };
  if (aggregate === 'api_key') return { type: 'api_key', id: ctx.actor?.keyId };
  if (aggregate === 'client') return { type: 'client', id: ctx.identity?.harness };
  if (aggregate === 'model') return { type: 'model', id: ctx.request?.model };
  if (aggregate === 'provider') return { type: 'provider', id: ctx.resolvedProviderId || null };
  return { type: 'user', id: ctx.actor?.userId };
}

async function matchOneCondition(key, cond, ctx, deps) {
  switch (key) {
    case 'clients':
      return Array.isArray(cond) && cond.length ? cond.includes(ctx.identity?.harness || 'unknown') : true;
    case 'protocols':
      return Array.isArray(cond) && cond.length ? cond.includes(ctx.identity?.protocol) : true;
    case 'endpoints':
      return cond.length ? matchEndpoint(cond, ctx.identity?.method, ctx.identity?.path) : true;
    case 'semantics':
      return Array.isArray(cond) && cond.length ? cond.includes(ctx.semantics?.type) : true;
    case 'models':
      return cond._modelRegex?.length ? cond._modelRegex.some(re => modelCandidates(ctx).some(value => re.test(String(value)))) : true;
    case 'providers':
      return cond._providerRegex?.length ? cond._providerRegex.some(re => {
        const values = [ctx.request?.providerId, ...(ctx.request?.providerCandidates || [])].filter(Boolean);
        return values.some(value => re.test(String(value)));
      }) : true;
    case 'tools': {
      const names = ctx.request?.tools || [];
      if (cond.forbid_any === true && names.length) return true;
      if (cond._nameRegex?.length && names.some(name => cond._nameRegex.some(re => re.test(String(name))))) return true;
      if (cond.max_count != null && names.length > cond.max_count) return true;
      return false;
    }
    case 'mcp_servers': {
      const servers = ctx.request?.mcpServers || [];
      if (!cond._mcpRegex?.length) return true;
      return cond._mcpRegex.some(re => servers.some(server => re.test(String(server))));
    }
    case 'ips':
      return cond._blockList ? matchIp(cond._blockList, ctx.network?.ip) : true;
    case 'tags': {
      if (!Array.isArray(cond) || !cond.length) return true;
      const tags = ctx.actor?.tags || [];
      return cond.some(tag => tags.includes(tag));
    }
    case 'identities': {
      const actor = ctx.actor || {};
      if (cond.admin != null && Boolean(actor.isAdmin) !== cond.admin) return false;
      if (Array.isArray(cond.roles) && cond.roles.length) {
        const role = actor.isAdmin ? 'admin' : 'member';
        if (!cond.roles.includes(role)) return false;
      }
      if (Array.isArray(cond.tags) && cond.tags.length) {
        const tags = actor.tags || [];
        if (!cond.tags.some(tag => tags.includes(tag))) return false;
      }
      if (cond.new_member_days != null) {
        const createdAt = actor.createdAt ? new Date(actor.createdAt).getTime() : null;
        if (createdAt == null) return false;
        if ((Date.now() - createdAt) / 86400000 > cond.new_member_days) return false;
      }
      return true;
    }
    case 'api_keys': {
      const actor = ctx.actor || {};
      if (Array.isArray(cond.ids) && cond.ids.length && !cond.ids.includes(Number(actor.keyId))) return false;
      if (cond.names?.length) {
        const regexes = cond.names.map(globToRegex).filter(Boolean);
        if (!regexes.some(re => re.test(String(actor.keyName || '')))) return false;
      }
      if (cond.older_than_days != null) {
        const createdAt = actor.keyCreatedAt ? new Date(actor.keyCreatedAt).getTime() : null;
        if (createdAt == null) return false;
        if ((Date.now() - createdAt) / 86400000 <= cond.older_than_days) return false;
      }
      if (cond.shared != null && Boolean(actor.keyShared) !== cond.shared) return false;
      return true;
    }
    case 'oauth_clients':
      return cond._oauthRegex?.length ? cond._oauthRegex.some(re => re.test(String(ctx.actor?.oauthClientId || ''))) : true;
    case 'session': {
      const session = ctx.session || {};
      if (cond.subagent != null && Boolean(session.subagentId || session.parentSessionId) !== cond.subagent) return false;
      if (cond.compaction != null && Boolean(session.compaction) !== cond.compaction) return false;
      if (cond._cwdPrefixes?.length) {
        const cwd = String(session.cwd || '');
        if (!cond._cwdPrefixes.some(prefix => cwd.startsWith(prefix))) return false;
      }
      return true;
    }
    case 'prompt': {
      if (!cond.contains?.length && !cond._regex?.length) return true;
      const corpus = ctx.getPromptCorpus ? ctx.getPromptCorpus() : extractPromptCorpus(ctx.body || {});
      if (!corpus) return false;
      if (cond.contains?.length && !cond.contains.some(word => corpus.toLowerCase().includes(word.toLowerCase()))) return false;
      if (cond._regex?.length && !cond._regex.some(re => re.test(corpus))) return false;
      return true;
    }
    case 'media': {
      const request = ctx.request || {};
      if (cond.max_images != null && (request.imageCount || 0) > cond.max_images) return true;
      if (cond.forbid_attachments === true && request.hasAttachments) return true;
      return false;
    }
    case 'limits': {
      const request = ctx.request || {};
      if (cond.max_tokens != null && (request.maxTokens || 0) > cond.max_tokens) return true;
      if (cond.max_messages != null && (request.messageCount || 0) > cond.max_messages) return true;
      if (cond.max_body_bytes != null && (request.bodyBytes || 0) > cond.max_body_bytes) return true;
      return false;
    }
    case 'schedule':
      return matchSchedule(cond, ctx.now || new Date());
    case 'usage': {
      if (!deps.queryUsage) return false;
      const subject = usageSubject(ctx, cond.aggregate);
      if (!subject.id) return false;
      const value = await deps.queryUsage({ ...cond, subject });
      return Number(value || 0) >= Number(cond.gte);
    }
    case 'budget': {
      if (!deps.queryUsage) return false;
      const subject = usageSubject(ctx, cond.aggregate);
      if (!subject.id) return false;
      const value = await deps.queryUsage({
        metric: cond.metric, window: cond.period, aggregate: cond.aggregate, subject
      });
      return Number(value || 0) >= Number(cond.gte);
    }
    case 'concurrency': {
      if (!deps.getConcurrency) return false;
      const active = await deps.getConcurrency(ctx, cond.aggregate);
      return Number(active || 0) >= Number(cond.max);
    }
    default:
      return true;
  }
}

async function matchConditions(conditions, ctx, deps) {
  const reasons = [];
  if (!conditions || typeof conditions !== 'object') return { match: true, reasons };

  for (const [key, cond] of Object.entries(conditions)) {
    if (key === 'all' || key === 'any' || key === 'not' || key.startsWith('_')) continue;
    const ok = await matchOneCondition(key, cond, ctx, deps);
    if (!ok) return { match: false, reasons };
    reasons.push(key);
  }
  if (Array.isArray(conditions.all)) {
    for (const child of conditions.all) {
      const result = await matchConditions(child, ctx, deps);
      if (!result.match) return { match: false, reasons };
      reasons.push(...result.reasons);
    }
  }
  if (Array.isArray(conditions.any) && conditions.any.length) {
    let matched = false;
    for (const child of conditions.any) {
      const result = await matchConditions(child, ctx, deps);
      if (result.match) {
        matched = true;
        reasons.push(...result.reasons);
        break;
      }
    }
    if (!matched) return { match: false, reasons };
  }
  if (conditions.not) {
    const result = await matchConditions(conditions.not, ctx, deps);
    if (result.match) return { match: false, reasons };
  }
  return { match: true, reasons };
}

async function matchPolicy(policy, ctx, deps = {}) {
  const conditions = policy._compiled || policy.conditions || {};
  return matchConditions(conditions, ctx, deps);
}

function hasConditionDimension(conditions, dimension) {
  if (!conditions || typeof conditions !== 'object') return false;
  const map = {
    clients: 'clients', models: 'models', providers: 'providers', ips: 'ips', protocols: 'protocols'
  };
  if (conditions[map[dimension]] !== undefined) return true;
  for (const key of ['all', 'any']) {
    if (Array.isArray(conditions[key]) && conditions[key].some(child => hasConditionDimension(child, dimension))) return true;
  }
  return false;
}

module.exports = {
  compilePolicy,
  compileConditions,
  matchPolicy,
  matchConditions,
  hasConditionDimension,
  globToRegex,
  zonedClock,
  matchSchedule,
};
