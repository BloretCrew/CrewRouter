'use strict';

const crypto = require('node:crypto');
const { ProfileStore } = require('./profile-store');
const { validateRemoteUrl, redactUrl } = require('./url-policy');

function parseInstanceResponse(body) {
  if (!body || typeof body !== 'object') throw new Error('实例响应不是 JSON 对象');
  const edition = String(body.edition || body.data?.edition || '').toLowerCase();
  if (!['personal', 'team'].includes(edition)) throw new Error('实例 edition 缺失或无效');
  return {
    edition,
    capabilities: body.capabilities || body.data?.capabilities || {},
    protocolVersion: body.protocolVersion || body.protocol_version || body.data?.protocolVersion || null
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
    return { ...parseInstanceResponse(body), url: result.url.toString() };
  }

  async connect({ id = crypto.randomUUID(), name = 'CrewRouter', url, mode = 'remote', allowLocalhost = false } = {}) {
    const instance = await this.inspect(url, { allowLocalhost });
    const profile = { id, name, url: instance.url, mode, edition: instance.edition, capabilities: instance.capabilities, protocolVersion: instance.protocolVersion, lastConnectedAt: new Date(this.now()).toISOString() };
    this.store.upsert(profile); this.store.setActive(id);
    return profile;
  }

  listProfiles() { return this.store.load().profiles; }
  switchProfile(id) { return this.store.setActive(id); }
  activeProfile() { return this.store.getActive(); }
}

module.exports = { ConnectionManager, parseInstanceResponse };
