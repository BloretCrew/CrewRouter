'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');
const { validateRemoteUrl } = require('./url-policy');

const SENSITIVE_CALLBACK_PARAM = /^(?:access_token|refresh_token|token|api_key|apikey|secret|code|ticket|auth)$/i;

class RedirectFlow {
  constructor({ ttlMs = 10 * 60 * 1000, now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
    this.ttlMs = ttlMs; this.now = now; this.randomBytes = randomBytes; this.states = new Map();
  }

  createState(metadata = {}) {
    const state = this.randomBytes(32).toString('base64url');
    this.states.set(state, { expiresAt: this.now() + this.ttlMs, metadata: { ...metadata } });
    return state;
  }

  consumeState(state) {
    const entry = this.states.get(state);
    if (!entry) throw new Error('state 无效或已被使用');
    this.states.delete(state);
    if (entry.expiresAt <= this.now()) throw new Error('state 已过期');
    return entry.metadata;
  }

  parseCallback(input, options = {}) {
    let url;
    try { url = new URL(input); } catch { throw new Error('回调 URL 无效'); }
    if (url.protocol === 'crewrouter:') {
      if (!((url.hostname === 'oauth' && url.pathname === '/callback') || (url.hostname === 'connect' && url.pathname === '/') || (url.hostname === 'connect' && url.pathname === ''))) throw new Error('不支持的回调类型');
    } else if (!['http:', 'https:'].includes(url.protocol)) throw new Error('不支持的回调协议');
    for (const key of url.searchParams.keys()) if (SENSITIVE_CALLBACK_PARAM.test(key)) throw new Error('回调不得携带凭据或授权码');
    const state = url.searchParams.get('state');
    if (!state) throw new Error('回调缺少 state');
    const targets = ['serverUrl', 'redirect', 'url'].filter((key) => url.searchParams.has(key));
    if (targets.length > 1) throw new Error('回调只能包含一个目标服务器参数');
    const metadata = this.consumeState(state);
    const target = targets.length ? url.searchParams.get(targets[0]) : metadata.serverUrl;
    if (!target) throw new Error('回调缺少目标服务器');
    return validateRemoteUrl(target, { allowLocalhost: options.allowLocalhost === true }).then((result) => {
      if (!result.ok) throw new Error(result.error);
      const expectedOrigin = metadata.targetOrigin;
      if (expectedOrigin && result.url.origin !== expectedOrigin) throw new Error('回调目标与发起连接的服务器不一致');
      return { state, metadata, serverUrl: result.url.toString() };
    });
  }

  buildDemoUrl(baseUrl, params = {}) {
    const state = this.createState(params.metadata || {});
    const target = params.target || params.metadata?.serverUrl || '';
    const template = String(baseUrl);
    const expanded = template.replaceAll('{state}', encodeURIComponent(state)).replaceAll('{target}', encodeURIComponent(target));
    let url;
    try { url = new URL(expanded); } catch { this.states.delete(state); throw new Error('Demo URL 格式无效'); }
    if (!template.includes('{state}')) url.searchParams.set('state', state);
    if (target && !template.includes('{target}')) url.searchParams.set('serverUrl', target);
    return { url: url.toString(), state };
  }
}

module.exports = { RedirectFlow };
