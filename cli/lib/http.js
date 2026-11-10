'use strict';

const http = require('node:http');
const https = require('node:https');

class HttpError extends Error {
  constructor(message, { statusCode = 0, code = '', body = null, headers = null, url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.body = body;
    this.headers = headers;
    this.url = url;
  }
}

function parseBody(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"') && trimmed !== 'true' && trimmed !== 'false' && trimmed !== 'null')) return text;
  try { return JSON.parse(trimmed); } catch (_) { return text; }
}

function request(urlValue, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 15000,
  maxBytes = 16 * 1024 * 1024,
  request = null,
} = {}) {
  let url;
  try { url = new URL(urlValue); }
  catch (_) { return Promise.reject(new HttpError('URL 无效', { url: String(urlValue) })); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return Promise.reject(new HttpError('只支持 http/https', { url: url.toString() }));
  }
  const transport = request || (url.protocol === 'https:' ? https.request : http.request);
  const payload = body === undefined || body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  const requestHeaders = { Accept: 'application/json', ...headers };
  if (payload) requestHeaders['Content-Length'] = String(payload.length);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = transport(url, { method, headers: requestHeaders, agent: false }, (res) => {
      const chunks = [];
      let bytes = 0;
      const onData = (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          res.destroy();
          finish(reject, new HttpError('响应过大', { statusCode: res.statusCode, headers: res.headers, url: url.toString() }));
          return;
        }
        chunks.push(chunk);
      };
      res.on('data', onData);
      res.on('error', error => finish(reject, new HttpError(error.message, { statusCode: res.statusCode, headers: res.headers, url: url.toString() })));
      res.on('aborted', () => finish(reject, new HttpError('连接被中断', { statusCode: res.statusCode, headers: res.headers, url: url.toString() })));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        finish(resolve, {
          statusCode: res.statusCode || 0,
          headers: res.headers,
          text,
          json: parseBody(text),
          url: url.toString(),
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new HttpError(`请求超时（${timeoutMs}ms）`, { url: url.toString() })));
    req.on('error', error => {
      if (error instanceof HttpError) finish(reject, error);
      else finish(reject, new HttpError(error.message || '网络请求失败', { code: error.code || '', url: url.toString() }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function errorMessage(body, fallback) {
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string' && body.error) return body.error;
    if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') return body.error.message;
    if (typeof body.message === 'string' && body.message) return body.message;
    if (typeof body.error === 'string' && body.error) return body.error;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300);
  return fallback;
}

function errorCode(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.code === 'string') return body.code;
  if (typeof body.type === 'string') return body.type;
  return '';
}

module.exports = { HttpError, request, parseBody, errorMessage, errorCode };
