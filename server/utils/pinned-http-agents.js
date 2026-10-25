'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

function normalizeHostname(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function createPinnedLookup(hostname, addresses) {
  const expectedHost = normalizeHostname(hostname);
  const pinned = addresses.map(({ address, family }) => {
    const detectedFamily = net.isIP(address);
    if (!detectedFamily || (family && family !== detectedFamily)) throw new Error('目标 DNS 地址无效');
    return { address, family: detectedFamily };
  });
  if (!pinned.length) throw new Error('目标 DNS 地址为空');

  return (requestedHostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (normalizeHostname(requestedHostname) !== expectedHost) {
      const error = Object.assign(new Error('请求主机与已校验的 DNS 目标不一致'), { code: 'ENOTFOUND' });
      callback(error);
      return;
    }
    const family = Number(options?.family) || 0;
    const candidates = family ? pinned.filter(item => item.family === family) : pinned;
    if (!candidates.length) {
      const error = Object.assign(new Error('已校验的 DNS 目标不包含请求地址族'), { code: 'ENOTFOUND' });
      callback(error);
      return;
    }
    if (options?.all) {
      callback(null, candidates.map(item => ({ ...item })));
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  };
}

function createPinnedHttpAgents(validation) {
  if (!validation?.ok || !validation.url) throw new Error('缺少已校验的请求目标');
  const url = validation.url instanceof URL ? validation.url : new URL(validation.url);
  const hostname = normalizeHostname(url.hostname);
  const lookup = net.isIP(hostname) ? undefined : createPinnedLookup(hostname, validation.addresses || []);
  const options = { lookup, keepAlive: false, autoSelectFamily: true };
  const httpAgent = new http.Agent(options);
  const httpsAgent = new https.Agent(options);
  return {
    httpAgent,
    httpsAgent,
    destroy() {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}

module.exports = { createPinnedHttpAgents };
