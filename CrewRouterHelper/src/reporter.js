'use strict';
const http = require('http');
const https = require('https');
const { getCredential } = require('./config');
function postEvent(url, token, payload, timeout = 3000) {
  return new Promise((resolve) => {
    try {
      const target = new URL(`${url}/api/client-events`); const transport = target.protocol === 'https:' ? https : http;
      const req = transport.request(target, { method: 'POST', timeout, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300)); });
      req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false)); req.end(JSON.stringify(payload));
    } catch { resolve(false); }
  });
}
async function report(payload) { const { url, token } = getCredential(); return url && token ? postEvent(url, token, payload) : false; }
module.exports = { postEvent, report };
