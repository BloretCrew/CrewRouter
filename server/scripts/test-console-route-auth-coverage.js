'use strict';

// Static coverage: every protected /api route must either be session-only or
// have an API Key permission mapping in public/js/api-key-permissions.json.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { matchPermission } = require('../utils/api-key-permissions');
const { SESSION_ONLY, PUBLIC_PREFIXES } = require('../constants/route-access');

const ROUTES_DIR = path.resolve(__dirname, '../routes');

const MOUNTS = {
  'admin.js': ['/api/admin'],
  'admin-model-library.js': ['/api/admin'],
  'admin-oauth-clients.js': ['/api/admin/oauth-clients'],
  'admin-popup-notices.js': ['/api/admin'],
  'admin-custom-instructions.js': ['/api/admin'],
  'teams.js': ['/api/admin'],
  'auth-invites.js': ['/api'],
  'user.js': ['/api/user'],
  'user-custom-instructions.js': ['/api/user'],
  'attribution-view.js': ['/api/user'],
  'sessions-view.js': ['/api/user'],
  'inject-prompts.js': ['/api/user'],
  'notifications.js': ['/api/user'],
  'balance-alert.js': ['/api/user'],
  'hook-notify-rules.js': ['/api/user'],
  'popup-notices.js': ['/api/user'],
  'plugin-pref-optin.js': ['/api/user'],
  'api.js': ['/api', '/v1'],
  'client-events.js': ['/api/client-events'],
  'conversations.js': ['/api/conversations'],
  'playground.js': ['/api/playground'],
  'agent.js': ['/api/agent'],
  'plugins.js': ['/api/plugins'],
  'model-trace.js': ['/api/user/model-trace'],
};


function routePatterns(source) {
  const result = [];
  const re = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = re.exec(source))) result.push({ method: match[1].toUpperCase(), route: match[2] });
  return result;
}

function normalizedPath(prefix, route) {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const suffix = route.startsWith('/') ? route : `/${route}`;
  return suffix === '/' ? base || '/' : `${base}${suffix}`;
}

function skipped(fullPath) {
  return SESSION_ONLY.some((re) => re.test(fullPath)) || PUBLIC_PREFIXES.some((re) => re.test(fullPath));
}

const missing = [];
for (const [file, prefixes] of Object.entries(MOUNTS)) {
  const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
  for (const { method, route } of routePatterns(source)) {
    for (const prefix of prefixes) {
      const fullPath = normalizedPath(prefix, route);
      if (skipped(fullPath)) continue;
      if (!matchPermission(method, fullPath)) missing.push(`${method} ${fullPath} (${file})`);
    }
  }
}

assert.deepEqual([...new Set(missing)].sort(), [], `缺少 API Key 权限映射:\n${[...new Set(missing)].join('\n')}`);
console.log(`API Key route coverage: ${Object.keys(MOUNTS).length} routers checked`);
