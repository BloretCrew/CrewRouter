'use strict';

// Declarative route mount table.
//
// `server/index.js` is the runtime source of truth for now; this table mirrors
// its non-demo mounts in the same order and is consumed by the SDK contract
// generator, route coverage checks and (from Phase 2a) the app factory itself.
//
// Fields:
//   id          stable identifier used by generated docs/tests
//   mount       Express mount prefix
//   module      route module, relative to server/routes
//   feature     SDK feature preset (gateway | management | events | tools | console | oauth | plugins | public | demo)
//   runtime     'index'  -> mounted directly by server/index.js
//               'nested' -> mounted by its parent route module
//               'demo'   -> demo-only mount
//   parent      parent mount id for nested entries
//   sameInstance shared router instance mounted at more than one prefix
//   create      factory name for routers that cannot be required directly

const REAL_MOUNTS = [
  { id: 'setup', mount: '/api', module: './setup', feature: 'console', runtime: 'index' },
  { id: 'i18n', mount: '/api/i18n', module: './i18n', feature: 'public', runtime: 'index' },
  { id: 'auth', mount: '/auth', module: './auth', feature: 'console', runtime: 'index' },
  { id: 'oauth-github-legacy', mount: '/auth/github-legacy', module: './oauth-github', feature: 'console', runtime: 'index' },
  { id: 'feishu', mount: '/auth', module: './feishu', feature: 'console', runtime: 'index' },
  { id: 'passport-auth', mount: '/auth', module: './passport-auth', feature: 'console', runtime: 'index' },
  { id: 'auth-invites', mount: '/api', module: './auth-invites', feature: 'console', runtime: 'index' },
  { id: 'api', mount: '/api', module: './api', feature: 'gateway', runtime: 'index', sameInstance: 'api-core' },
  { id: 'admin', mount: '/api/admin', module: './admin', feature: 'management', runtime: 'index' },
  { id: 'admin-model-library', mount: '/api/admin', module: './admin-model-library', feature: 'management', runtime: 'nested', parent: 'admin' },
  { id: 'admin-oauth-clients', mount: '/api/admin/oauth-clients', module: './admin-oauth-clients', feature: 'management', runtime: 'index' },
  { id: 'admin-popup-notices', mount: '/api/admin', module: './admin-popup-notices', feature: 'management', runtime: 'index' },
  { id: 'admin-custom-instructions', mount: '/api/admin', module: './admin-custom-instructions', feature: 'management', runtime: 'index' },
  { id: 'update', mount: '/api/admin/update', module: './update', feature: 'console', runtime: 'index' },
  { id: 'teams', mount: '/api/admin', module: './teams', feature: 'management', runtime: 'index' },
  { id: 'admin-policies', mount: '/api/admin', module: './admin-policies', feature: 'management', runtime: 'index' },
  { id: 'model-trace', mount: '/api/user/model-trace', module: './model-trace', feature: 'tools', runtime: 'index', factory: 'getRouter' },
  { id: 'user', mount: '/api/user', module: './user', feature: 'management', runtime: 'index' },
  { id: 'balance-alert', mount: '/api/user', module: './balance-alert', feature: 'management', runtime: 'index' },
  { id: 'notifications', mount: '/api/user', module: './notifications', feature: 'management', runtime: 'index' },
  { id: 'popup-notices', mount: '/api/user', module: './popup-notices', feature: 'management', runtime: 'index' },
  { id: 'plugin-pref-optin', mount: '/api/user', module: './plugin-pref-optin', feature: 'management', runtime: 'index' },
  { id: 'hook-notify-rules', mount: '/api/user', module: './hook-notify-rules', feature: 'management', runtime: 'index' },
  { id: 'user-custom-instructions', mount: '/api/user', module: './user-custom-instructions', feature: 'management', runtime: 'index' },
  { id: 'attribution-view', mount: '/api/user', module: './attribution-view', feature: 'management', runtime: 'index' },
  { id: 'sessions-view', mount: '/api/user', module: './sessions-view', feature: 'management', runtime: 'index' },
  { id: 'inject-prompts', mount: '/api/user', module: './inject-prompts', feature: 'management', runtime: 'index' },
  { id: 'client-events', mount: '/api/client-events', module: './client-events', feature: 'events', runtime: 'index' },
  { id: 'playground', mount: '/api/playground', module: './playground', feature: 'tools', runtime: 'index' },
  { id: 'conversations', mount: '/api/conversations', module: './conversations', feature: 'tools', runtime: 'index' },
  { id: 'agent', mount: '/api/agent', module: './agent', feature: 'tools', runtime: 'index' },
  { id: 'two-factor', mount: '/api/2fa', module: './two-factor', feature: 'console', runtime: 'index' },
  { id: 'passkey', mount: '/api/passkey', module: './passkey', feature: 'console', runtime: 'index' },
  { id: 'oauth', mount: '/', module: './oauth', feature: 'oauth', runtime: 'index' },
  { id: 'api-v1', mount: '/v1', module: './api', feature: 'gateway', runtime: 'index', sameInstance: 'api-core' },
  { id: 'gemini-v1beta', mount: '/v1beta', module: './gemini', feature: 'gateway', runtime: 'index' },
  { id: 'gemini-v1', mount: '/v1', module: './gemini', feature: 'gateway', runtime: 'index' },
  { id: 'admin-plugins', mount: '/api/admin/plugins', module: './plugins', feature: 'plugins', runtime: 'index', factory: 'createPluginsRoutes:adminRouter' },
  { id: 'public-plugins', mount: '/api/plugins', module: './plugins', feature: 'plugins', runtime: 'index', factory: 'createPluginsRoutes:publicRouter' },
];

const DEMO_MOUNTS = [
  { id: 'demo-client-events', mount: '/api/client-events', module: '../demo/client-events', feature: 'demo', runtime: 'demo' },
  { id: 'demo-extra', mount: '/api/user', module: '../demo/extra', feature: 'demo', runtime: 'demo' },
  { id: 'demo-routes-user', mount: '/api/user', module: '../demo/routes', feature: 'demo', runtime: 'demo' },
  { id: 'demo-routes-admin', mount: '/api/admin', module: '../demo/routes', feature: 'demo', runtime: 'demo' },
  { id: 'demo-playground', mount: '/api/playground', module: '../demo/playground', feature: 'demo', runtime: 'demo' },
  { id: 'demo-conversations', mount: '/api/conversations', module: '../demo/conversations', feature: 'demo', runtime: 'demo' },
  { id: 'demo-auth', mount: '/auth', module: '../demo/auth', feature: 'demo', runtime: 'demo' },
  { id: 'store', mount: '/store', module: './store', feature: 'demo', runtime: 'demo', factory: 'createStoreRoutes' },
];

module.exports = { REAL_MOUNTS, DEMO_MOUNTS };
