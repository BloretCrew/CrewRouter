'use strict';

/**
 * API Key 权限目录与路由匹配。
 *
 * 唯一事实来源是 public/js/api-key-permissions.json；后端直接加载同一文件，
 * 前端通过静态资源加载，避免权限名称、分组和路由映射两处漂移。
 */

const fs = require('node:fs');
const path = require('node:path');

const METHOD_SET = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const PERMISSION_ID_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;

function catalogPath() {
  const candidates = [
    path.join(__dirname, '../../public/js/api-key-permissions.json'),
    path.join(__dirname, '../public/js/api-key-permissions.json'),
    path.join(process.cwd(), 'public/js/api-key-permissions.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 api-key-permissions.json');
}

function loadCatalog() {
  const raw = JSON.parse(fs.readFileSync(catalogPath(), 'utf8'));
  if (!raw || !Array.isArray(raw.groups)) throw new Error('API Key 权限目录格式无效');
  const groups = [];
  const byId = new Map();
  for (const group of raw.groups) {
    if (!group || typeof group.id !== 'string' || !Array.isArray(group.permissions)) continue;
    const permissions = [];
    for (const permission of group.permissions) {
      if (!permission || typeof permission.id !== 'string' || !PERMISSION_ID_RE.test(permission.id)) continue;
      if (byId.has(permission.id)) throw new Error(`API Key 权限 ID 重复: ${permission.id}`);
      const normalized = {
        id: permission.id,
        name: String(permission.name || permission.id),
        description: String(permission.description || ''),
        adminOnly: permission.adminOnly === true,
        group: group.id,
        groupName: String(group.name || group.id),
        routes: Array.isArray(permission.routes) ? permission.routes : [],
      };
      permissions.push(normalized);
      byId.set(normalized.id, normalized);
    }
    if (permissions.length) {
      groups.push({
        id: group.id,
        name: String(group.name || group.id),
        description: String(group.description || ''),
        permissions,
      });
    }
  }
  return { version: Number(raw.version) || 1, groups, byId };
}

const CATALOG = loadCatalog();
const ALL_PERMISSION_IDS = [...CATALOG.byId.keys()];

// 新建 Key 与历史 Key 的默认权限：网关调用能力默认开启，避免升级后请求全被拦截。
// 控制台/管理类权限仍然默认关闭，按需授予。
const DEFAULT_GRANT_GROUPS = new Set(['gateway']);
const DEFAULT_PERMISSION_IDS = ALL_PERMISSION_IDS.filter(
  (id) => DEFAULT_GRANT_GROUPS.has(CATALOG.byId.get(id)?.group)
);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternToRegex(pattern) {
  const normalized = `/${String(pattern || '').replace(/^\/+|\/+$/g, '')}`;
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === '*') {
      source += '.*';
      continue;
    }
    if (char === ':' && (i === 0 || normalized[i - 1] === '/')) {
      // :id / :id(\d+) 都匹配一个路径段；约束不参与匹配，避免依赖具体写法。
      let end = i + 1;
      while (end < normalized.length && normalized[end] !== '/') end++;
      source += '[^/]+';
      i = end - 1;
      continue;
    }
    source += escapeRegex(char);
  }
  return new RegExp(`^${source}/?$`);
}

function specificity(pattern) {
  const literal = String(pattern || '').replace(/:[^/]+/g, '').replace(/\*/g, '');
  return literal.length * 10 + (String(pattern).includes('*') ? 0 : 5);
}

const ROUTE_RULES = [];
for (const permission of CATALOG.byId.values()) {
  for (const route of permission.routes) {
    const methods = Array.isArray(route.methods) ? route.methods.map((m) => String(m).toUpperCase()) : ['*'];
    const validMethods = methods.filter((m) => m === '*' || METHOD_SET.has(m));
    if (!validMethods.length) continue;
    ROUTE_RULES.push({
      permission,
      methods: new Set(validMethods),
      pattern: String(route.path || ''),
      regex: patternToRegex(route.path),
      specificity: specificity(route.path),
    });
  }
}
ROUTE_RULES.sort((a, b) => b.specificity - a.specificity);

function normalizePath(pathname) {
  const value = String(pathname || '/').split('?')[0];
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function matchPermission(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const target = normalizePath(pathname);
  // 独立签名端点沿用个人资料权限；旧目录缓存也可正确鉴权。
  if (target === '/api/user/signature') {
    if (verb === 'GET') return CATALOG.byId.get('account.profile.read');
    if (verb === 'PUT') return CATALOG.byId.get('account.profile.write');
  }
  for (const rule of ROUTE_RULES) {
    if (!rule.methods.has('*') && !rule.methods.has(verb)) continue;
    if (rule.regex.test(target)) return rule.permission;
  }
  return null;
}

function permissionIds() {
  return [...ALL_PERMISSION_IDS];
}

/** 默认授予的权限（目前为 gateway 组全部权限）。 */
function defaultPermissions() {
  return [...DEFAULT_PERMISSION_IDS];
}

function permissionById(id) {
  return CATALOG.byId.get(String(id || '')) || null;
}

function normalizePermissions(input, { allowed = null } = {}) {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: '权限必须是数组' };
  const allowedSet = allowed ? new Set(allowed) : null;
  const value = [];
  const seen = new Set();
  for (const item of input) {
    if (typeof item !== 'string') return { ok: false, error: '权限项必须是字符串' };
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    if (!CATALOG.byId.has(id)) return { ok: false, error: `未知权限: ${id}` };
    if (allowedSet && !allowedSet.has(id)) return { ok: false, error: `无权授予权限: ${id}` };
    seen.add(id);
    value.push(id);
  }
  return { ok: true, value };
}

function isPermissionSubset(requested, granted) {
  const set = new Set(granted || []);
  return (requested || []).every((id) => set.has(id));
}

function grantablePermissions({ isAdmin = false, currentPermissions = null, actorType = 'session' } = {}) {
  const source = actorType === 'api_key' && Array.isArray(currentPermissions)
    ? new Set(currentPermissions)
    : null;
  return ALL_PERMISSION_IDS.filter((id) => {
    const permission = CATALOG.byId.get(id);
    if (!permission) return false;
    if (permission.adminOnly && !isAdmin) return false;
    if (source && !source.has(id)) return false;
    return true;
  });
}

function validateGrant(requested, context = {}) {
  const allowed = grantablePermissions(context);
  return normalizePermissions(requested, { allowed });
}

function publicCatalog() {
  return {
    version: CATALOG.version,
    groups: CATALOG.groups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      permissions: group.permissions.map((permission) => ({
        id: permission.id,
        name: permission.name,
        description: permission.description,
        adminOnly: permission.adminOnly,
      })),
    })),
  };
}

module.exports = {
  CATALOG,
  ALL_PERMISSION_IDS,
  DEFAULT_PERMISSION_IDS,
  defaultPermissions,
  permissionIds,
  permissionById,
  matchPermission,
  normalizePermissions,
  isPermissionSubset,
  grantablePermissions,
  validateGrant,
  publicCatalog,
};
