'use strict';

const { request, errorMessage, errorCode } = require('./http');
const { cookieHeader, updateJar } = require('./cookies');
const { normalizeBaseUrl } = require('./config');
const { version } = require('../../package.json');

const USER_AGENT = `crewrouter-cli/${version}`;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

class ApiError extends Error {
  constructor(message, { statusCode = 0, code = '', body = null, url = '', kind = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.body = body;
    this.url = url;
    this.kind = kind || (statusCode === 401 ? 'auth' : statusCode === 403 ? 'permission' : 'api');
  }
}

class CliClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || 'http://127.0.0.1:20003');
    this.cookieJar = Array.isArray(options.cookieJar) ? options.cookieJar.slice() : [];
    this.csrfToken = typeof options.csrfToken === 'string' ? options.csrfToken : '';
    this.apiKey = typeof options.apiKey === 'string' ? options.apiKey : '';
    this.username = options.username || '';
    this.isAdmin = options.isAdmin === true ? true : options.isAdmin === false ? false : null;
    this.authWarning = typeof options.authWarning === 'string' ? options.authWarning : '';
    this.timeoutMs = Number(options.timeoutMs) || 15000;
  }

  setBaseUrl(value) {
    const next = normalizeBaseUrl(value);
    if (next !== this.baseUrl) {
      this.cookieJar = [];
      this.csrfToken = '';
    }
    this.baseUrl = next;
    return this;
  }

  setSession({ cookieJar, csrfToken, username, isAdmin } = {}) {
    this.apiKey = '';
    this.authWarning = '';
    this.cookieJar = Array.isArray(cookieJar) ? cookieJar.slice() : [];
    this.csrfToken = typeof csrfToken === 'string' ? csrfToken : '';
    if (username !== undefined) this.username = username || '';
    if (isAdmin !== undefined) this.isAdmin = isAdmin === true ? true : isAdmin === false ? false : null;
    return this;
  }

  setApiKey(value) {
    this.apiKey = String(value || '');
    this.authWarning = '';
    this.cookieJar = [];
    this.csrfToken = '';
    return this;
  }

  clearAuth() {
    this.apiKey = '';
    this.cookieJar = [];
    this.csrfToken = '';
    this.username = '';
    this.isAdmin = null;
    this.authWarning = '';
    return this;
  }

  authType() {
    return this.apiKey ? 'api-key' : 'session';
  }

  sessionSnapshot() {
    return {
      authType: this.authType(),
      ...(this.apiKey ? { apiKey: this.apiKey } : { cookieJar: this.cookieJar, csrfToken: this.csrfToken }),
      baseUrl: this.baseUrl,
      username: this.username,
      isAdmin: this.isAdmin,
      savedAt: Date.now(),
    };
  }

  async request(path, options = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new ApiError('API 路径无效');
    }
    const method = String(options.method || 'GET').toUpperCase();
    const query = options.query && typeof options.query === 'object' ? options.query : null;
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
    }
    const headers = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (!SAFE_METHODS.has(method)) {
      headers.Origin = new URL(this.baseUrl).origin;
      headers.Referer = `${this.baseUrl}/console`;
    }
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    else {
      const cookie = cookieHeader(this.cookieJar, url.toString());
      if (cookie) headers.Cookie = cookie;
      if (this.csrfToken && !SAFE_METHODS.has(method)) headers['X-CSRF-Token'] = this.csrfToken;
    }
    let body;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await request(url.toString(), {
        method,
        headers,
        body,
        timeoutMs: options.timeoutMs || this.timeoutMs,
        maxBytes: options.maxBytes,
        request: options.request,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.message || '网络请求失败', { code: error.code || '', url: url.toString() });
    }
    const setCookie = response.headers && response.headers['set-cookie'];
    if (setCookie) this.cookieJar = updateJar(this.cookieJar, setCookie, url.toString());
    if (options.raw) return response;
    const data = response.json;
    if (response.statusCode >= 200 && response.statusCode < 300) return data;
    if (response.statusCode === 403 && data && data.type === 'csrf_failed' && !options.skipCsrfRetry && !this.apiKey) {
      await this.refreshCsrfToken();
      return this.request(path, { ...options, skipCsrfRetry: true });
    }
    const message = errorMessage(data, `HTTP ${response.statusCode}`);
    throw new ApiError(message, {
      statusCode: response.statusCode,
      code: errorCode(data),
      body: data,
      url: url.toString(),
    });
  }

  get(path, options = {}) { return this.request(path, { ...options, method: 'GET' }); }
  post(path, body, options = {}) { return this.request(path, { ...options, method: 'POST', body }); }
  put(path, body, options = {}) { return this.request(path, { ...options, method: 'PUT', body }); }
  delete(path, options = {}) { return this.request(path, { ...options, method: 'DELETE' }); }

  async refreshCsrfToken() {
    const data = await this.request('/api/csrf-token', { method: 'GET', skipCsrfRetry: true });
    if (data && typeof data.token === 'string' && data.token) this.csrfToken = data.token;
    return this.csrfToken;
  }

  async versionInfo() {
    return this.get('/api/version');
  }

  async instanceInfo() {
    return this.get('/api/instance');
  }

  async setupStatus() {
    return this.get('/api/setup/status');
  }
}

module.exports = { CliClient, ApiError, USER_AGENT, SAFE_METHODS };
