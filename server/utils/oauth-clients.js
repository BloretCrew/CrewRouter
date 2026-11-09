'use strict';

/**
 * OAuth 客户端注册表（内置 + config.oauth.clients + oauth_clients 表）
 *
 * 设计目标：
 *  - 保持三个内置首方客户端的行为完全不变（公共客户端、无 secret、任意回环路径）；
 *  - 允许管理员在数据库中登记第三方客户端，或在 config.oauth.clients 中声明；
 *  - 公共客户端强制 PKCE、无 secret；机密客户端必须提供 client_secret；
 *  - 回调地址只做精确匹配；原生应用的 loopback 地址允许任意端口。
 */

const crypto = require('node:crypto');

const BUILTIN_CLIENTS = Object.freeze([
  Object.freeze({
    client_id: 'crewrouter-desktop',
    name: 'CrewRouter Desktop',
    type: 'public',
    first_party: true,
    enabled: true,
    scopes: Object.freeze(['events:report']),
    redirect_uris: Object.freeze([]),
    allow_loopback_any_path: true,
    description: 'CrewRouter 桌面客户端',
    source: 'builtin',
    editable: false,
    builtin: true,
  }),
  Object.freeze({
    client_id: 'crewrouter-helper',
    name: 'CrewRouter Helper',
    type: 'public',
    first_party: true,
    enabled: true,
    scopes: Object.freeze(['events:report']),
    redirect_uris: Object.freeze([]),
    allow_loopback_any_path: true,
    description: 'CrewRouter 客户端事件上报 Helper',
    source: 'builtin',
    editable: false,
    builtin: true,
  }),
  Object.freeze({
    client_id: 'crewrouter-cli',
    name: 'CrewRouter CLI',
    type: 'public',
    first_party: true,
    enabled: true,
    scopes: Object.freeze(['gateway:invoke']),
    redirect_uris: Object.freeze([]),
    allow_loopback_any_path: true,
    description: 'CrewRouter 命令行客户端',
    source: 'builtin',
    editable: false,
    builtin: true,
  }),
]);

const BUILTIN_BY_ID = new Map(BUILTIN_CLIENTS.map((client) => [client.client_id, client]));

const SCOPE_DEFINITIONS = Object.freeze({
  'events:report': Object.freeze({ description: '仅向 CrewRouter 上报客户端使用事件', assignable: true }),
  'gateway:invoke': Object.freeze({ description: '通过网关调用模型接口', assignable: true }),
  'console:read': Object.freeze({ description: '读取控制台数据（预留）', assignable: false }),
});

const ASSIGNABLE_SCOPES = Object.freeze(
  Object.entries(SCOPE_DEFINITIONS).filter(([, item]) => item.assignable).map(([scope]) => scope)
);

const MAX_REDIRECT_URIS = 20;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{3,128}$/;
const CUSTOM_SCHEME_RE = /^[a-z][a-z0-9+.-]*:$/;
const FORBIDDEN_SCHEMES = new Set([
  'javascript:', 'data:', 'file:', 'blob:', 'about:', 'chrome:', 'vbscript:',
  'ftp:', 'ws:', 'wss:',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const CLIENT_TYPES = new Set(['public', 'confidential']);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function asStringArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeScopes(value, { allowReserved = false } = {}) {
  const list = [...new Set(asStringArray(value).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!list.every((scope) => Object.hasOwn(SCOPE_DEFINITIONS, scope))) return null;
  if (!allowReserved && list.some((scope) => !SCOPE_DEFINITIONS[scope].assignable)) return null;
  return list;
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());
}

function parseRedirectUri(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) return null;
  if (value.trim() !== value || /[\u0000- \u007f]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // 自定义 scheme 必须带 authority（如 myapp://callback），避免 mailto:/tel:
    // 这类会把授权码塞进邮件或短信的地址。
    if (!CUSTOM_SCHEME_RE.test(url.protocol) || !url.hostname || FORBIDDEN_SCHEMES.has(url.protocol)) return null;
  }
  return url;
}

function redirectUriMatches(registered, requested) {
  if (registered.protocol !== requested.protocol) return false;
  if (registered.hostname !== requested.hostname) return false;
  if (registered.pathname !== requested.pathname) return false;
  if (registered.search !== requested.search) return false;
  // RFC 8252：原生应用的回环地址允许任意端口。
  const loopback = registered.protocol === 'http:' && isLoopbackHostname(registered.hostname);
  if (!loopback && registered.port !== requested.port) return false;
  return true;
}

/**
 * 校验请求中的 redirect_uri：
 *  - 内置客户端：任意 http://127.0.0.1|localhost|[::1]:<port>/<path>
 *  - 注册客户端：严格匹配登记的协议、主机、路径与查询；回环地址忽略端口
 */
function matchRedirectUri(client, value) {
  const requested = parseRedirectUri(value);
  if (!requested) return null;
  if (client.allow_loopback_any_path === true) {
    if (requested.protocol !== 'http:' || !isLoopbackHostname(requested.hostname)) return null;
    return requested.toString();
  }
  for (const raw of client.redirect_uris || []) {
    const registered = parseRedirectUri(raw);
    if (registered && redirectUriMatches(registered, requested)) return requested.toString();
  }
  return null;
}

function normalizeRedirectUris(value) {
  const list = [...new Set(asStringArray(value).map((item) => String(item || '').trim()).filter(Boolean))];
  if (list.length > MAX_REDIRECT_URIS) return { ok: false, error: `回调地址最多 ${MAX_REDIRECT_URIS} 个` };
  for (const item of list) {
    if (!parseRedirectUri(item)) return { ok: false, error: `回调地址无效：${item.slice(0, 120)}` };
  }
  // 统一使用 URL 规范化后的形式，避免大小写/默认端口差异。
  return { ok: true, value: list.map((item) => parseRedirectUri(item).toString()) };
}

function normalizeScopeRequest(scopeStr, client) {
  const requested = String(scopeStr || '').split(/[\s+]+/).filter(Boolean);
  const list = requested.length > 0 ? [...new Set(requested)] : [...(client.scopes || [])];
  if (list.length === 0) return null;
  if (!list.every((scope) => (client.scopes || []).includes(scope))) return null;
  return list.join(' ');
}

function normalizeClientRecord(input, { source = 'database', editable = true, builtin = false } = {}) {
  const clientId = String(input.client_id || input.clientId || '').trim();
  if (!CLIENT_ID_RE.test(clientId) || clientId.length > MAX_CLIENT_ID_LENGTH) return null;
  const name = String(input.name || clientId).trim().slice(0, MAX_NAME_LENGTH);
  if (!name) return null;
  const type = CLIENT_TYPES.has(input.type) ? input.type : 'public';
  const scopes = normalizeScopes(input.scopes);
  if (!scopes) return null;
  const redirectUris = normalizeRedirectUris(input.redirect_uris || input.redirectUris || []);
  if (!redirectUris.ok) return null;
  const secretValue = typeof input.secret === 'string'
    ? input.secret
    : (typeof input.clientSecret === 'string' ? input.clientSecret : '');
  if (type === 'confidential' && source !== 'database') {
    if (!secretValue && !input.secret_hash) return null;
    // 配置文件的明文密钥也必须是高熵值，避免弱口令直接成为客户端凭据。
    if (secretValue && secretValue.length < 32) return null;
  }
  return {
    client_id: clientId,
    name,
    type,
    first_party: input.first_party === true,
    enabled: input.enabled !== false,
    scopes,
    redirect_uris: redirectUris.value,
    allow_loopback_any_path: input.allow_loopback_any_path === true || input.allowLoopbackAnyPath === true,
    secret_hash: input.secret_hash || (secretValue ? sha256Hex(secretValue) : null),
    secret_hint: input.secret_hint || (secretValue ? secretValue.slice(0, 6) : null),
    description: String(input.description || '').slice(0, MAX_DESCRIPTION_LENGTH),
    created_at: input.created_at || null,
    updated_at: input.updated_at || null,
    source,
    editable,
    builtin,
  };
}

function normalizeDbRow(row) {
  return normalizeClientRecord({
    client_id: row.client_id,
    name: row.name,
    type: row.client_type,
    first_party: row.first_party === true,
    enabled: row.enabled !== false,
    scopes: row.scopes,
    redirect_uris: row.redirect_uris,
    allow_loopback_any_path: row.allow_loopback_any_path === true,
    secret_hash: row.secret_hash,
    secret_hint: row.secret_hint,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }, { source: 'database', editable: true, builtin: false });
}

function configClients(config) {
  const raw = config && config.oauth && config.oauth.clients;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const client = normalizeClientRecord(item, { source: 'config', editable: false, builtin: false });
    if (!client || seen.has(client.client_id) || BUILTIN_BY_ID.has(client.client_id)) continue;
    seen.add(client.client_id);
    result.push(client);
  }
  return result;
}

function clientFromDbRow(row) {
  return normalizeDbRow(row) || {
    client_id: row.client_id,
    name: row.name || row.client_id,
    type: row.client_type === 'confidential' ? 'confidential' : 'public',
    first_party: row.first_party === true,
    enabled: false,
    scopes: [],
    redirect_uris: [],
    allow_loopback_any_path: row.allow_loopback_any_path === true,
    secret_hash: null,
    secret_hint: null,
    description: row.description || '',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    source: 'database',
    editable: true,
    builtin: false,
  };
}

async function resolveClient(pool, config, clientId) {
  if (typeof clientId !== 'string' || !clientId) return null;
  const builtin = BUILTIN_BY_ID.get(clientId);
  if (builtin) return builtin;
  const configured = configClients(config).find((client) => client.client_id === clientId);
  if (configured) return configured;
  try {
    const result = await pool.query(
      `SELECT client_id, name, first_party, client_type, redirect_uris, scopes,
              allow_loopback_any_path, secret_hash, secret_hint, description, enabled,
              created_at, updated_at
         FROM oauth_clients WHERE client_id = $1 LIMIT 1`,
      [clientId]
    );
    return result.rows[0] ? clientFromDbRow(result.rows[0]) : null;
  } catch (error) {
    // 旧库或离线测试尚未创建 oauth_clients 时，内置/配置客户端仍然可用。
    if (error && error.code === '42P01') return null;
    throw error;
  }
}

async function listClients(pool, config) {
  const result = new Map();
  for (const client of BUILTIN_CLIENTS) result.set(client.client_id, client);
  for (const client of configClients(config)) {
    if (!result.has(client.client_id)) result.set(client.client_id, client);
  }
  try {
    const db = await pool.query(
      `SELECT client_id, name, first_party, client_type, redirect_uris, scopes,
              allow_loopback_any_path, secret_hash, secret_hint, description, enabled,
              created_at, updated_at
         FROM oauth_clients ORDER BY created_at ASC, client_id ASC`
    );
    for (const row of db.rows) {
      if (!result.has(row.client_id)) result.set(row.client_id, clientFromDbRow(row));
    }
  } catch (error) {
    if (!error || error.code !== '42P01') throw error;
  }
  return [...result.values()];
}

function parseBasicAuth(req) {
  const header = req && req.headers && req.headers.authorization;
  if (typeof header !== 'string' || !/^Basic\s+/i.test(header)) return null;
  let decoded;
  try { decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8'); } catch { return null; }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  const decodeForm = (value) => {
    try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; }
  };
  return {
    clientId: decodeForm(decoded.slice(0, separator)),
    clientSecret: decodeForm(decoded.slice(separator + 1)),
  };
}

function clientCredentials(req, body) {
  const basic = parseBasicAuth(req);
  return {
    basic,
    clientId: basic ? basic.clientId : (body && body.client_id),
    clientSecret: basic ? basic.clientSecret : (body && body.client_secret),
  };
}

function authenticateClient(client, req, body) {
  const credentials = clientCredentials(req, body);
  if (credentials.basic && body && body.client_id && body.client_id !== credentials.basic.clientId) return false;
  if (credentials.clientId && credentials.clientId !== client.client_id) return false;
  if (client.type !== 'confidential') return true;
  if (!client.secret_hash || typeof credentials.clientSecret !== 'string' || !credentials.clientSecret) return false;
  return timingSafeEqualHex(client.secret_hash, sha256Hex(credentials.clientSecret));
}

function publicClientView(client) {
  return {
    client_id: client.client_id,
    name: client.name,
    type: client.type,
    first_party: client.first_party === true,
    enabled: client.enabled !== false,
    scopes: [...(client.scopes || [])],
    redirect_uris: [...(client.redirect_uris || [])],
    allow_loopback_any_path: client.allow_loopback_any_path === true,
    description: client.description || '',
    source: client.source,
    editable: client.editable === true,
    builtin: client.builtin === true,
    has_secret: Boolean(client.secret_hash),
    secret_hint: client.secret_hint || null,
  };
}

function adminClientView(client) {
  return {
    ...publicClientView(client),
    created_at: client.created_at || null,
    updated_at: client.updated_at || null,
  };
}

module.exports = {
  BUILTIN_CLIENTS,
  SCOPE_DEFINITIONS,
  ASSIGNABLE_SCOPES,
  MAX_REDIRECT_URIS,
  normalizeScopes,
  normalizeRedirectUris,
  normalizeScopeRequest,
  matchRedirectUri,
  parseRedirectUri,
  resolveClient,
  listClients,
  configClients,
  parseBasicAuth,
  clientCredentials,
  authenticateClient,
  publicClientView,
  adminClientView,
  sha256Hex,
  timingSafeEqualHex,
};
