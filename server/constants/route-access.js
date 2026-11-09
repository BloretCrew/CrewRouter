'use strict';

// Pure route classification constants shared by runtime auth, route coverage
// tests and the SDK contract generator. Keep this module dependency-free: the
// code generator loads it without touching configuration or the database.

// These routes depend on session state or change credentials; API Key must never
// satisfy them, even if the key belongs to an administrator.
const SESSION_ONLY = [
  /^\/auth(?:\/|$)/,
  /^\/api\/2fa(?:\/|$)/,
  /^\/api\/passkey(?:\/|$)/,
  /^\/api\/setup(?:\/|$)/,
  /^\/api\/admin\/update(?:\/|$)/,
  /^\/oauth\/authorize(?:\/|$)/,
  /^\/oauth\/authorizations(?:\/|$)/,
  /^\/api\/user\/model-trace(?:\/|$)/,
];

// Existing oauthBearer endpoints validate raw API keys themselves, including
// gateway-specific quotas/model policy. Avoid resolving the same key twice.
const GATEWAY_OR_EVENTS = [
  /^\/v1\/(?:chat\/completions|models|messages|responses)(?:\/|$)/,
  /^\/api\/(?:chat\/completions|models|messages|responses)(?:\/|$)/,
  /^\/api\/client-events(?:\/|$)/,
];

const PUBLIC_PREFIXES = [
  /^\/api\/i18n(?:\/|$)/,
  /^\/api\/version(?:\/|$)/,
  /^\/api\/config(?:\/|$)/,
  /^\/api\/instance(?:\/|$)/,
  /^\/api\/updates\/latest(?:\/|$)/,
  /^\/api\/csrf-token(?:\/|$)/,
  /^\/api\/login-report(?:\/|$)/,
  /^\/api\/stats-report(?:\/|$)/,
  /^\/api\/user\/docs-content(?:\/|$)/,
  /^\/oauth\/token(?:\/|$)/,
  /^\/oauth\/revoke(?:\/|$)/,
  /^\/oauth\/desktop-session(?:\/|$)/,
  /^\/\.well-known(?:\/|$)/,
  /^\/store(?:\/|$)/,
];

function matches(list, pathname) {
  return list.some((regex) => regex.test(pathname));
}

function isSessionOnly(pathname) {
  return matches(SESSION_ONLY, pathname);
}

function isPublicPath(pathname) {
  return matches(PUBLIC_PREFIXES, pathname);
}

function isGatewayOrEventPath(pathname) {
  return matches(GATEWAY_OR_EVENTS, pathname);
}

module.exports = {
  SESSION_ONLY,
  GATEWAY_OR_EVENTS,
  PUBLIC_PREFIXES,
  matches,
  isSessionOnly,
  isPublicPath,
  isGatewayOrEventPath,
};
