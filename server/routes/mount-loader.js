'use strict';

// Literal lazy requires keep disabled routes unloaded and visible to esbuild.
const routeModules = {
  './setup': () => require('./setup'),
  './i18n': () => require('./i18n'),
  './auth': () => require('./auth'),
  './oauth-github': () => require('./oauth-github'),
  './feishu': () => require('./feishu'),
  './passport-auth': () => require('./passport-auth'),
  './auth-invites': () => require('./auth-invites'),
  './api': () => require('./api'),
  './admin': () => require('./admin'),
  './admin-oauth-clients': () => require('./admin-oauth-clients'),
  './admin-popup-notices': () => require('./admin-popup-notices'),
  './admin-custom-instructions': () => require('./admin-custom-instructions'),
  './update': () => require('./update'),
  './teams': () => require('./teams'),
  './model-trace': () => require('./model-trace'),
  './user': () => require('./user'),
  './balance-alert': () => require('./balance-alert'),
  './notifications': () => require('./notifications'),
  './popup-notices': () => require('./popup-notices'),
  './plugin-pref-optin': () => require('./plugin-pref-optin'),
  './hook-notify-rules': () => require('./hook-notify-rules'),
  './user-custom-instructions': () => require('./user-custom-instructions'),
  './attribution-view': () => require('./attribution-view'),
  './sessions-view': () => require('./sessions-view'),
  './inject-prompts': () => require('./inject-prompts'),
  './client-events': () => require('./client-events'),
  './playground': () => require('./playground'),
  './conversations': () => require('./conversations'),
  './agent': () => require('./agent'),
  './two-factor': () => require('./two-factor'),
  './passkey': () => require('./passkey'),
  './oauth': () => require('./oauth'),
  './gemini': () => require('./gemini'),
  './plugins': () => require('./plugins'),
};

function createMountRouterLoader() {
  const moduleCache = new Map();
  let pluginRoutes = null;

  return (entry) => {
    if (entry.factory === 'getRouter') {
      return routeModules['./model-trace']().getRouter();
    }
    if (entry.factory && entry.factory.startsWith('createPluginsRoutes')) {
      if (!pluginRoutes) pluginRoutes = routeModules['./plugins']().createPluginsRoutes();
      return entry.factory.endsWith('adminRouter') ? pluginRoutes.adminRouter : pluginRoutes.publicRouter;
    }
    if (moduleCache.has(entry.module)) return moduleCache.get(entry.module);
    if (!Object.hasOwn(routeModules, entry.module)) {
      throw new Error(`Unknown route module: ${entry.module}`);
    }
    const router = routeModules[entry.module]();
    moduleCache.set(entry.module, router);
    return router;
  };
}

module.exports = { createMountRouterLoader };
