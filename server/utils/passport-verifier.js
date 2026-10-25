'use strict';

const { hasPassportCredentials } = require('./passport-credentials');

const VERIFY_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ERROR_MESSAGES = Object.freeze({
  PASSPORT_NOT_CONFIGURED: 'PassPort 应用凭据未配置或无效',
  MISSING_CODE: 'PassPort 授权码无效',
  PASSPORT_URL_REJECTED: 'PassPort 地址必须是无凭据、无查询参数的公网 HTTPS 地址',
  PASSPORT_BAD_RESPONSE: 'PassPort 返回了无效的身份响应',
  PASSPORT_VERIFY_FAILED: 'PassPort 授权验证失败',
  PASSPORT_RESPONSE_TOO_LARGE: 'PassPort 响应超出大小限制',
  PASSPORT_TIMEOUT: 'PassPort 授权验证超时',
  PASSPORT_REQUEST_FAILED: 'PassPort 授权服务请求失败',
});

class PassportVerificationError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function businessFailure(value) {
  return (value.error !== undefined && value.error !== null && value.error !== false && value.error !== '')
    || (value.code !== undefined && value.code !== 0)
    || value.success === false || value.status === 'error';
}

function validString(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength
    && !/[\x00-\x1f\x7f]/.test(value)
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function parseIdentity(text, requireAppToken) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw new PassportVerificationError('PASSPORT_BAD_RESPONSE'); }
  if (!object(data)) throw new PassportVerificationError('PASSPORT_BAD_RESPONSE');
  if (businessFailure(data)) throw new PassportVerificationError('PASSPORT_VERIFY_FAILED');
  const payload = Object.hasOwn(data, 'data') ? data.data : data;
  if (!object(payload)) throw new PassportVerificationError('PASSPORT_BAD_RESPONSE');
  if (businessFailure(payload)) throw new PassportVerificationError('PASSPORT_VERIFY_FAILED');
  if (typeof payload.username !== 'string' || !payload.username.trim() || !validString(payload.username, 255)) {
    throw new PassportVerificationError('PASSPORT_BAD_RESPONSE');
  }
  if (requireAppToken && (!validString(payload.apptoken, MAX_RESPONSE_BYTES) || !payload.apptoken.trim())) {
    throw new PassportVerificationError('PASSPORT_BAD_RESPONSE');
  }
  // Return only fields the application consumes. In particular, the historical
  // provider may include a password hash; it must not enter our logs/errors.
  const identity = { username: payload.username.trim(), admin: payload.admin === true };
  for (const [name, maxLength] of [['nickname', 255], ['email', 255], ['avatar', 2048]]) {
    if (payload[name] !== undefined && payload[name] !== null) {
      if (!validString(payload[name], maxLength)) throw new PassportVerificationError('PASSPORT_BAD_RESPONSE');
      identity[name] = payload[name];
    }
  }
  if (requireAppToken) identity.apptoken = payload.apptoken;
  return identity;
}

// Dependencies are resolved only during a real exchange. Offline tests can use
// the same implementation without loading deployment config, logger or database.
function createPassportVerifier({ validateUrl, pinnedFetchValidated, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  return async function verifyPassportCode(cfg, code, { method = 'POST', requireAppToken = false } = {}) {
    if (!hasPassportCredentials(cfg)) throw new PassportVerificationError('PASSPORT_NOT_CONFIGURED');
    if (typeof code !== 'string' || !code.trim() || code.length > 4096 || /[\x00-\x1f\x7f]/.test(code)) {
      throw new PassportVerificationError('MISSING_CODE');
    }
    if (method !== 'GET' && method !== 'POST') throw new PassportVerificationError('PASSPORT_REQUEST_FAILED');
    const controller = new AbortController();
    let reader;
    let response;
    let timer;
    let timedOut = false;
    function cancelBody() {
      // Never await a hostile/stalled stream's cancellation when enforcing a
      // deadline. Rejections are consumed without logging transport contents.
      try {
        const canceled = reader ? reader.cancel() : response?.body?.cancel();
        Promise.resolve(canceled).catch(() => {});
      } catch (_) {}
    }
    function assertActive() {
      if (controller.signal.aborted) throw new PassportVerificationError('PASSPORT_TIMEOUT');
    }
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        cancelBody();
        reject(new PassportVerificationError('PASSPORT_TIMEOUT'));
      }, timeoutMs);
    });
    const exchange = async () => {
      let endpoint;
      try {
        const base = new URL(cfg.baseUrl || 'https://passport.bloret.net');
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error();
        endpoint = new URL(`${base.toString().replace(/\/$/, '')}/app/verify`);
      } catch { throw new PassportVerificationError('PASSPORT_URL_REJECTED'); }
      const validate = validateUrl || require('./url-validator').validateUrl;
      // Validate the credential-free endpoint. A failed DNS/URL validator must
      // never receive app_secret or code, even in its error text.
      const checked = await validate(endpoint.toString(), { allowPrivate: false });
      assertActive();
      if (!checked?.ok || !checked.url || checked.url.toString() !== endpoint.toString()) {
        throw new PassportVerificationError('PASSPORT_URL_REJECTED');
      }
      const credentials = { app_id: cfg.appId, app_secret: cfg.appSecret, code };
      const requestUrl = new URL(endpoint);
      const options = { method, redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } };
      if (method === 'GET') requestUrl.search = new URLSearchParams(credentials).toString();
      else {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(credentials);
      }
      const fetchValidated = pinnedFetchValidated || require('../proxy-pool').pinnedFetchValidated;
      // Reuse the validated addresses unchanged; only GET query parameters are
      // added. Never retry or change methods for a possibly consumed code.
      response = await fetchValidated({ ...checked, url: requestUrl }, options);
      if (controller.signal.aborted) cancelBody();
      assertActive();
      if (!response.ok) throw new PassportVerificationError('PASSPORT_VERIFY_FAILED');
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
        throw new PassportVerificationError('PASSPORT_RESPONSE_TOO_LARGE');
      }
      if (!response.body?.getReader) throw new PassportVerificationError('PASSPORT_BAD_RESPONSE');
      reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        assertActive();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new PassportVerificationError('PASSPORT_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(value));
      }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
      catch { throw new PassportVerificationError('PASSPORT_BAD_RESPONSE'); }
      return parseIdentity(text, requireAppToken);
    };
    try {
      return await Promise.race([exchange(), deadline]);
    } catch (error) {
      controller.abort();
      cancelBody();
      if (timedOut) throw new PassportVerificationError('PASSPORT_TIMEOUT');
      if (error instanceof PassportVerificationError) throw error;
      // Transport exceptions can carry URLs, request bodies, response data and
      // nested Axios causes. Do not preserve or log any of those properties.
      throw new PassportVerificationError('PASSPORT_REQUEST_FAILED');
    } finally {
      clearTimeout(timer);
      try { reader?.releaseLock(); } catch (_) {}
    }
  };
}

const verifyPassportCode = createPassportVerifier();
module.exports = { verifyPassportCode, createPassportVerifier, VERIFY_TIMEOUT_MS, MAX_RESPONSE_BYTES };
