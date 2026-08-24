'use strict';

/**
 * 内置 http/https 薄封装：仅 POST（JSON / 表单），带超时，
 * 返回 { status, body }；网络层异常向上抛出，由调用方决定是否吞错。
 */

const http = require('http');
const https = require('https');

function post(fullUrl, data, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(fullUrl);
    } catch (err) {
      return reject(err);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': data.length },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function postJson(fullUrl, payload, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  return post(fullUrl, Buffer.from(JSON.stringify(payload), 'utf8'), headers, opts.timeoutMs || 3000);
}

async function postForm(fullUrl, form, opts = {}) {
  const body = Buffer.from(new URLSearchParams(form).toString(), 'utf8');
  return post(fullUrl, body, { 'Content-Type': 'application/x-www-form-urlencoded' }, opts.timeoutMs || 10000);
}

module.exports = { post, postJson, postForm };
