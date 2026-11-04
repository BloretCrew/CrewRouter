/**
 * 双重提交 Cookie CSRF 防护
 * - Cookie: __Host-bp_csrf（可读，供前端 JS 放入 Header/表单）
 * - 校验：X-CSRF-Token 或 body._csrf 与 Cookie 一致
 */
const { t } = require('./i18n');
const crypto = require('crypto');

const CSRF_COOKIE = '__Host-bp_csrf';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Only routes which authenticate without browser cookies are exempt.
const { parseCookieHeader, safeEqualString } = require('./security');
const csrfSecret = crypto.randomBytes(32);
const MACHINE_ROUTES = new Set([
    '/oauth/token', '/oauth/device/code', '/app/verify', '/app/oauthapp/validate',
    '/app/oauthapp/username-mapping', '/app/data/save', '/app/data/read', '/app/data/delete',
    '/app/minecraftaccounts', '/v1/chat/completions', '/v1/models',
    '/api/2fa/app/pending', '/api/2fa/app/approve', '/api/admin/set-user-tags'
]);

function tokenSignature(nonce, binding) {
    return crypto.createHmac('sha256', csrfSecret).update(JSON.stringify([nonce, binding])).digest('hex');
}
function generateCsrfToken(binding = '') {
    const nonce = crypto.randomBytes(32).toString('hex');
    return nonce + '.' + tokenSignature(nonce, binding);
}
function validToken(token, binding) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) return false;
    const [nonce, signature] = token.split('.');
    return safeEqualString(signature, tokenSignature(nonce, binding));
}

function getCookieOptions() {
    return {
        httpOnly: false, // 前端需读取
        sameSite: 'lax',
        path: '/',
        secure: true,
        maxAge: CSRF_MAX_AGE_MS
    };
}

function ensureCsrfToken(req, res) {
    const cookies = parseCookieHeader(req.headers.cookie || '');
    let token = cookies[CSRF_COOKIE];
    if (!validToken(token, req.sessionToken || '')) {
        token = generateCsrfToken(req.sessionToken || '');
        res.cookie(CSRF_COOKIE, token, getCookieOptions());
    }
    req.csrfToken = token;
    return token;
}

const CSRF_NEVER_EXEMPT = ['/app/oauth/accept', '/app/oauth/deny', '/oauth/authorize/consent', '/oauth/device/authorize', '/v1/keys'];
function canonicalPath(path) {
    return typeof path === 'string' ? path.split('?')[0].toLowerCase().replace(/\/+$/, '') : '';
}
function isNeverExemptPath(path) {
    const normalized = canonicalPath(path);
    return CSRF_NEVER_EXEMPT.some(p => normalized === p || normalized.startsWith(p + '/'));
}
function isExemptPath(path) {
    return !isNeverExemptPath(path) && MACHINE_ROUTES.has(canonicalPath(path));
}
function looksLikeAppCredentialAuth(req) {
    return isExemptPath(req.path || req.url || '');
}

/**
 * CSRF 中间件：为所有响应确保 Cookie；对非安全方法校验 token
 */
function csrfMiddleware(options = {}) {

    return function csrf(req, res, next) {
        try {
            ensureCsrfToken(req, res);

            const method = (req.method || 'GET').toUpperCase();
            if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
                return next();
            }

            const path = req.path || req.url || '';
            if (isExemptPath(path)) {
                return next();
            }
            if (looksLikeAppCredentialAuth(req)) {
                return next();
            }

            // 未登录的状态变更仍校验 CSRF（防登录 CSRF），但 login/register 已在白名单

            const submitted =
                req.headers[CSRF_HEADER] ||
                (req.body && (req.body._csrf || req.body.csrf)) ||
                null;

            const crossSite = req.headers['sec-fetch-site'] === 'cross-site';
            if (crossSite || !safeEqualString(submitted, req.csrfToken)) {
                const wantsJson =
                    req.xhr ||
                    (req.headers.accept && req.headers.accept.includes('application/json')) ||
                    (req.headers['content-type'] && req.headers['content-type'].includes('application/json'));

                if (wantsJson) {
                    return res.status(403).json({
                        success: false,
                        message: t('CSRF 校验失败，请刷新页面后重试')
                    });
                }
                return res.status(403).send(t('CSRF 校验失败，请刷新页面后重试'));
            }

            next();
        } catch (err) {
            next(err);
        }
    };
}

/** 前端自动注入：patch fetch + 表单 hidden 字段 */
const CSRF_CLIENT_JS = `/*! bloret-passport csrf client */
(function () {
  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\\[\\]\\\\/+^])/g, '\\\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function csrfToken() {
    return getCookie('${CSRF_COOKIE}');
  }
  window.getCsrfToken = csrfToken;
  function injectForms() {
    var token = csrfToken();
    if (!token) return;
    document.querySelectorAll('form').forEach(function (form) {
      if (form.method && form.method.toUpperCase() === 'GET') return;
      try { if (new URL(form.action || location.href, location.href).origin !== location.origin) return; } catch (_) { return; }
      if (form.querySelector('input[name="_csrf"]')) {
        form.querySelector('input[name="_csrf"]').value = token;
        return;
      }
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = '_csrf';
      input.value = token;
      form.appendChild(input);
    });
  }
  if (window.fetch) {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      init = init || {};
      var target = typeof input === 'string' || input instanceof URL ? input : input.url;
      try { if (new URL(target, location.href).origin !== location.origin) return _fetch.call(this, input, init); } catch (_) { return _fetch.call(this, input, init); }
      var headers = new Headers(init.headers || (input && input.headers) || {});
      if (!headers.has('X-CSRF-Token')) {
        var t = csrfToken();
        if (t) headers.set('X-CSRF-Token', t);
      }
      init.headers = headers;
      if (init.credentials === undefined) init.credentials = 'same-origin';
      return _fetch.call(this, input, init).then(function (response) {
        if (response.status === 428) {
          return response.clone().json().then(function (data) {
            if (data.error === 'reauthentication_required') location.assign('/account/reauth?returnTo=' + encodeURIComponent(location.pathname + location.search));
            return response;
          }, function () { return response; });
        }
        return response;
      });
    };
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectForms);
  } else {
    injectForms();
  }
  // 动态表单
  setInterval(injectForms, 2000);
})();
`;

function csrfClientScriptTag() {
    return '<script src="/csrf-client.js"></script>';
}

module.exports = {
    CSRF_COOKIE,
    CSRF_HEADER,
    csrfMiddleware,
    ensureCsrfToken,
    generateCsrfToken,
    CSRF_CLIENT_JS,
    csrfClientScriptTag,
    isExemptPath,
    isNeverExemptPath,
    looksLikeAppCredentialAuth
};
