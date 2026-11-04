'use strict';
const crypto = require('node:crypto');
const speakeasy = require('speakeasy');
const { verifyPassword } = require('../password');
const { createRateLimiter, escapeHtml, getClientIp } = require('../security');
function requiresRecentAuth(path, method) {
    path = path.toLowerCase().replace(/\/+$/, '');
    if (method === 'GET' || method === 'HEAD') return /^\/(?:edit\/oauthapp|oauthapp|api\/admin\/oauthapp)\/[^/]+$/.test(path) || ['/api/passkey/register/options', '/passkey/register', '/oauth/github/start', '/oauth/lark/start', '/login/minecraft/microsoft/start'].includes(path);
    if (['HEAD', 'OPTIONS'].includes(method)) return false;
    return path === '/change-password' || /^\/api\/2fa\/(generate|enable|disable)$/.test(path) ||
        /^\/api\/passkey\/(register\/verify|delete)$/.test(path) ||
        /^\/api\/admin\//.test(path) || /^\/edit\/(user|oauthapp)\//.test(path) ||
        /^\/api\/oauthapp\/[^/]+\/(regenerate-secret|delete)$/.test(path) ||
        /^\/login\/minecraft\/(remove|offline)$/.test(path) ||
        path === '/api/login/minecraft/microsoft/process' || /^\/v1\/keys(?:\/[^/]+)?$/.test(path);
}
function installRecentAuth(app, { db, passkeyManager, logUserAction }) {
    const rateLimit = createRateLimiter({ max: 30, windowMs: 15 * 60 * 1000 });
    const accountLimit = createRateLimiter({ max: 10, windowMs: 15 * 60 * 1000, keyFn: req => req.authUsername || getClientIp(req) });
    const binding = req => 'reauth:' + crypto.createHash('sha256').update(req.sessionToken).digest('hex');
    const target = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\r\n]/.test(value) && !value.startsWith('/account/reauth') ? value : '/';
    app.get('/account/reauth', (req, res) => {
        if (!req.authUsername) return res.redirect('/');
        res.send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>确认身份</title>
<link rel="stylesheet" href="/index.css"><script src="/csrf-client.js"></script><main style="max-width:440px;margin:10vh auto;padding:24px">
<h1>确认身份</h1><p>此操作需要再次验证。验证在当前会话中有效五分钟。</p>
<form method="post" action="/account/reauth"><input type="hidden" name="_csrf" value="${escapeHtml(req.csrfToken)}"><input type="hidden" name="returnTo" value="${escapeHtml(target(req.query.returnTo))}">
<label>密码 <input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><p><label>验证码（已开启双重认证时必填） <input name="token" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label></p><button>验证并返回</button></form>
<p><button id="passkey">使用通行密钥验证</button></p><p id="status" role="status"></p><script src="/webauthn-browser.js"></script><script>
document.getElementById('passkey').onclick=async()=>{const status=document.getElementById('status');try{const options=await fetch('/account/reauth/passkey/options',{method:'POST'}).then(r=>{if(!r.ok)throw Error();return r.json()});const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:options});const result=await fetch('/account/reauth/passkey/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({response,challenge:options.challenge})});if(!result.ok)throw Error();location.href=document.querySelector('[name=returnTo]').value;}catch(e){status.textContent='验证失败，请重试。';}};
</script></main></html>`);
    });
    app.post('/account/reauth', rateLimit, accountLimit, async (req, res, next) => {
        try {
            if (!req.authUsername) return res.status(401).send('请先登录');
            const user = await db.getUser(req.authUsername);
            const { password, token } = req.body || {};
            const validPassword = typeof password === 'string' && password.length <= 1024 && user && (await verifyPassword(password, user.password)).ok;
            const validTotp = user && (!user.twoFactorEnabled || (typeof token === 'string' && /^\d{6}$/.test(token) && user.totpSecret && speakeasy.totp.verify({ secret: user.totpSecret.base32, encoding: 'base32', token, window: 1 })));
            if (!validPassword || !validTotp) return res.status(403).send('验证失败，请返回重试');
            await db.markSessionVerified(req.sessionToken, user);
            await logUserAction(user.username, 'reauth', '敏感操作身份验证成功', getClientIp(req));
            return res.redirect(303, target(req.body.returnTo));
        } catch (error) { next(error); }
    });
    app.post('/account/reauth/passkey/options', rateLimit, accountLimit, async (req, res, next) => {
        try {
            if (!req.authUsername) return res.status(401).json({ error: 'login_required' });
            const user = await db.getUser(req.authUsername);
            if (!user?.passkeys?.length) return res.status(400).json({ error: 'no_passkey' });
            res.json(await passkeyManager.getAuthenticationOptions(user.passkeys, binding(req)));
        } catch (error) { next(error); }
    });
    app.post('/account/reauth/passkey/verify', rateLimit, accountLimit, async (req, res) => {
        try {
            if (!req.authUsername) return res.status(401).json({ error: 'login_required' });
            const user = await db.getUser(req.authUsername);
            const response = req.body?.response;
            const passkey = user?.passkeys?.find(p => p.credentialID === response?.id);
            if (!passkey) return res.status(403).json({ error: 'verification_failed' });
            const info = await passkeyManager.verifyAuthentication(passkey, response, req.body.challenge, binding(req));
            await db.markSessionVerified(req.sessionToken, user, { credentialID: passkey.credentialID, counter: passkey.counter, newCounter: info.newCounter });
            await logUserAction(user.username, 'reauth_passkey', '敏感操作通行密钥验证成功', getClientIp(req));
            res.json({ success: true });
        } catch { res.status(403).json({ error: 'verification_failed' }); }
    });
    app.use(async (req, res, next) => {
        try {
            if (!req.authUsername || !requiresRecentAuth(req.path, req.method)) return next();
            const user = await db.getUser(req.authUsername);
            if (user && await db.isSessionRecentlyVerified(req.sessionToken, user)) return next();
            const acceptsJson = /application\/json/.test(req.headers.accept || '') || /application\/json/.test(req.headers['content-type'] || '') || req.path.startsWith('/api/');
            const returnTo = target(req.method === 'GET' && !req.path.startsWith('/api/') ? req.originalUrl : '/');
            const url = '/account/reauth?returnTo=' + encodeURIComponent(returnTo);
            if (acceptsJson) return res.status(428).json({ error: 'reauthentication_required', message: '请先确认身份，然后重新操作', reauthenticate: url });
            res.redirect(303, url);
        } catch (error) { next(error); }
    });
}
module.exports = { installRecentAuth, requiresRecentAuth };
