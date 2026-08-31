'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');
const { validateRemoteUrl } = require('./url-policy');

class RedirectFlow {
  constructor({ ttlMs = 10 * 60 * 1000, now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
    this.ttlMs = ttlMs; this.now = now; this.randomBytes = randomBytes; this.states = new Map();
  }

  createState(metadata = {}) {
    const state = this.randomBytes(32).toString('base64url');
    this.states.set(state, { expiresAt: this.now() + this.ttlMs, metadata });
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
    const state = url.searchParams.get('state');
    if (!state) throw new Error('回调缺少 state');
    const metadata = this.consumeState(state);
    if (url.protocol === 'crewrouter:') {
      if (!['connect', 'oauth'].includes(url.hostname) && url.pathname !== '/oauth/callback') throw new Error('不支持的回调类型');
    } else if (!['http:', 'https:'].includes(url.protocol)) throw new Error('不支持的回调协议');
    const target = url.searchParams.get('serverUrl') || url.searchParams.get('redirect') || url.searchParams.get('url');
    if (!target) throw new Error('回调缺少目标服务器');
    return validateRemoteUrl(target, { allowLocalhost: options.allowLocalhost === true }).then((result) => {
      if (!result.ok) throw new Error(result.error);
      return { state, metadata, serverUrl: result.url.toString() };
    });
  }

  buildDemoUrl(baseUrl, params = {}) {
    const url = new URL(baseUrl);
    const state = this.createState(params.metadata || {});
    url.searchParams.set('state', state);
    return { url: url.toString(), state };
  }
}

module.exports = { RedirectFlow };
