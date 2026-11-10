'use strict';

const { spawn } = require('node:child_process');
const {
  loadConfig,
  activeProfile,
  normalizeBaseUrl,
  localProfile,
  getSession,
  saveSession,
  clearSession,
} = require('./config');
const { CliClient } = require('./client');
const { verifySession, verifyApiKey } = require('./auth');

function resolveTarget(args = {}, cfg = loadConfig()) {
  const envUrl = process.env.CREWROUTER_URL || process.env.CR_URL;
  if (args.url) {
    return {
      name: args.profile || 'custom',
      profile: { name: '自定义', type: 'remote', baseUrl: normalizeBaseUrl(args.url) },
      baseUrl: normalizeBaseUrl(args.url),
      adHoc: true,
    };
  }
  if (!args.profile && envUrl) {
    const baseUrl = normalizeBaseUrl(envUrl);
    return { name: 'env', profile: { name: '环境变量', type: 'remote', baseUrl }, baseUrl, adHoc: true };
  }
  if (args.profile) {
    if (!cfg.profiles[args.profile]) throw new Error(`profile 不存在：${args.profile}`);
    return { name: args.profile, profile: cfg.profiles[args.profile], baseUrl: cfg.profiles[args.profile].baseUrl, adHoc: false };
  }
  const profile = activeProfile(cfg);
  if (profile) return { name: cfg.currentProfile, profile, baseUrl: profile.baseUrl, adHoc: false };
  const local = localProfile();
  return { name: 'local', profile: local, baseUrl: local.baseUrl, adHoc: true };
}

function createContext(args = {}) {
  const cfg = loadConfig();
  const target = resolveTarget(args, cfg);
  const client = new CliClient({
    baseUrl: target.baseUrl,
    timeoutMs: args.timeout || 15000,
  });
  let saved = null;
  const apiKeyArg = args['api-key'] !== undefined ? args['api-key'] : (args.apiKey || process.env.CREWROUTER_API_KEY || process.env.CR_API_KEY);
  if (apiKeyArg) client.setApiKey(apiKeyArg);
  else if (!target.adHoc) {
    saved = getSession(target.name);
    if (saved && saved.baseUrl === target.baseUrl) {
      if (saved.authType === 'api-key' && saved.apiKey) client.setApiKey(saved.apiKey);
      else if (saved.authType === 'session') {
        client.setSession({ cookieJar: saved.cookieJar, csrfToken: saved.csrfToken, username: saved.username, isAdmin: saved.isAdmin });
      }
    }
  }
  return { cfg, target, profile: target.profile, profileName: target.name, client, saved };
}

function persistClientSession(context, extra = {}) {
  if (!context || context.target.adHoc) return null;
  if (!context.client.apiKey && !(context.client.cookieJar && context.client.cookieJar.length)) return null;
  return saveSession(context.profileName, { ...context.client.sessionSnapshot(), ...extra });
}

async function ensureAuthenticated(context, { revalidate = true } = {}) {
  if (context.client.apiKey) {
    if (!revalidate) return true;
    const ok = await verifyApiKey(context.client);
    if (!ok) {
      context.client.clearAuth();
      if (!context.target.adHoc) clearSession(context.profileName);
      throw Object.assign(new Error('API Key 已失效，请重新登录'), { statusCode: 401, code: 'auth_required' });
    }
    return true;
  }
  if (!context.client.cookieJar || !context.client.cookieJar.length) {
    throw Object.assign(new Error('尚未登录，请先执行 cr login'), { statusCode: 401, code: 'auth_required' });
  }
  if (!revalidate) return true;
  const me = await verifySession(context.client);
  if (!me) {
    context.client.clearAuth();
    if (!context.target.adHoc) clearSession(context.profileName);
    throw Object.assign(new Error('登录会话已失效，请重新执行 cr login'), { statusCode: 401, code: 'auth_required' });
  }
  return true;
}

function openBrowser(url) {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) return false;
  try {
    const platform = process.platform;
    const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', target] : [target];
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    if (typeof child.unref === 'function') child.unref();
    return true;
  } catch (_) { return false; }
}

module.exports = {
  resolveTarget,
  createContext,
  persistClientSession,
  ensureAuthenticated,
  openBrowser,
};
