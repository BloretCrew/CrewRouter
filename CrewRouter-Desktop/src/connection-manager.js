'use strict';

const crypto = require('node:crypto');
const { ProfileStore } = require('./profile-store');
const { validateRemoteUrl, redactUrl } = require('./url-policy');

function parseInstanceResponse(body, { allowLocalRuntime = false } = {}) {
  if (!body || typeof body !== 'object') throw new Error('实例响应不是 JSON 对象');
  const source = body.data && typeof body.data === 'object' ? body.data : body;
  const edition = String(source.edition || '').toLowerCase();
  const runtime = String(source.runtime || (allowLocalRuntime ? 'desktop-local' : '')).toLowerCase();
  const auth = source.auth && typeof source.auth === 'object'
    ? source.auth
    : (allowLocalRuntime ? { required: false, methods: ['local'] } : null);
  const methods = Array.isArray(auth?.methods) ? auth.methods.filter((method) => typeof method === 'string') : null;
  if (!['personal', 'team'].includes(edition)) throw new Error('实例 edition 缺失或无效');
  if (!['server', 'desktop-local'].includes(runtime)) throw new Error('实例 runtime 缺失或无效');
  if (!auth || typeof auth.required !== 'boolean' || !methods || methods.length === 0) throw new Error('实例 auth capabilities 缺失或无效');
  if (methods.some((method) => !['password', 'passport', 'feishu', 'local'].includes(method))) throw new Error('实例 auth.methods 含无效方式');
  if (runtime === 'desktop-local' && (auth.required !== false || JSON.stringify(methods) !== JSON.stringify(['local']))) throw new Error('Desktop Local 必须使用本地免交互认证');
  if (runtime === 'server' && methods.includes('local')) throw new Error('远程 server 不得声明 local 认证');
  if (runtime === 'server' && edition === 'personal' && (auth.required !== true || JSON.stringify(methods) !== JSON.stringify(['passport']))) throw new Error('Personal Server 必须只启用 Passport');
  return {
    runtime,
    edition,
    auth: { required: auth.required, methods: [...methods] },
    capabilities: source.capabilities && typeof source.capabilities === 'object' ? source.capabilities : {},
    protocolVersion: source.protocolVersion || source.protocol_version || null
  };
}

class ConnectionManager {
  constructor({ store, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    if (!store) throw new Error('需要 ProfileStore');
    this.store = store; this.fetch = fetchImpl; this.now = now;
  }

  async inspect(url, options = {}) {
    const result = await validateRemoteUrl(url, options);
    if (!result.ok) throw new Error(result.error);
    let response;
    try { response = await this.fetch(new URL('/api/instance', result.url), { headers: { accept: 'application/json' } }); }
    catch (error) { throw new Error(`连接失败（${redactUrl(url)}）：${error.message}`); }
    if (!response.ok) throw new Error(`/api/instance 返回 HTTP ${response.status}`);
    let body; try { body = await response.json(); } catch { throw new Error('/api/instance 返回无效 JSON'); }
    return { ...parseInstanceResponse(body, { allowLocalRuntime: options.allowLocalhost }), url: result.url.toString() };
  }

  async connect({ id = crypto.randomUUID(), name = 'CrewRouter', displayName = null, localIdentityId = null, url, mode = 'remote', allowLocalhost = false } = {}) {
    const instance = await this.inspect(url, { allowLocalhost });
    const profile = { id, name, ...(displayName ? { displayName } : {}), ...(localIdentityId ? { localIdentityId } : {}), url: instance.url, mode, runtime: instance.runtime, edition: instance.edition, auth: instance.auth, capabilities: instance.capabilities, protocolVersion: instance.protocolVersion, lastConnectedAt: new Date(this.now()).toISOString() };
    this.store.upsert(profile); this.store.setActive(id);
    return profile;
  }

  listProfiles() { return this.store.load().profiles; }
  switchProfile(id) { return this.store.setActive(id); }
  activeProfile() { return this.store.getActive(); }
}

module.exports = { ConnectionManager, parseInstanceResponse };
