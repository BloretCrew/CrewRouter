'use strict';

const { ApiError } = require('./client');

class TwoFactorRequired extends Error {
  constructor(userId) {
    super('需要 2FA 验证码');
    this.name = 'TwoFactorRequired';
    this.userId = userId;
  }
}

function permissionHint(error) {
  if (!(error instanceof ApiError)) return '';
  if (error.statusCode === 401) return '登录已失效，请重新执行 cr login。';
  if (error.statusCode === 403 && error.code === 'admin_required') return '该账号不是管理员，或 API Key 所属用户不是管理员。';
  if (error.statusCode === 403 && (error.code === 'permission_denied' || error.code === 'permission_not_configured')) {
    return 'API Key 缺少管理权限；请在 Web 控制台为该 Key 授予 keys.read / providers.read / usage.read 等权限，或改用密码会话登录。';
  }
  if (error.statusCode === 403 && error.code === 'session_required') return '该接口只接受登录会话，请使用 cr login（密码登录）。';
  if (error.statusCode === 429) return '尝试过于频繁，请稍后再试。';
  return '';
}

async function loginPassword(client, { login, password, otp } = {}) {
  if (!login || !password) throw new Error('需要用户名和密码');
  await client.refreshCsrfToken();
  let result = await client.post('/auth/login', { login, password }, { skipCsrfRetry: true });
  if (result && result.require2FA) {
    if (!otp) throw new TwoFactorRequired(result.userId);
    await client.refreshCsrfToken();
    result = await client.post('/auth/login/2fa', { userId: result.userId, code: String(otp) }, { skipCsrfRetry: true });
  }
  await client.refreshCsrfToken();
  const me = await client.get('/auth/me');
  client.username = me && me.username ? me.username : login;
  client.isAdmin = me && me.isAdmin === true;
  return me;
}

async function completeTwoFactor(client, userId, code) {
  await client.refreshCsrfToken();
  await client.post('/auth/login/2fa', { userId, code: String(code) }, { skipCsrfRetry: true });
  await client.refreshCsrfToken();
  const me = await client.get('/auth/me');
  client.username = me && me.username ? me.username : client.username;
  client.isAdmin = me && me.isAdmin === true;
  return me;
}

function apiKeyRestricted(error) {
  if (!(error instanceof ApiError)) return false;
  if (error.statusCode !== 403) return false;
  return error.code === 'permission_denied' || error.code === 'permission_not_configured' || error.code === 'admin_required';
}

async function probeApiKey(client) {
  const viaBalance = async () => {
    try {
      await client.get('/api/user/balance');
      client.authWarning = '';
      return true;
    } catch (fallback) {
      if (fallback instanceof ApiError && fallback.statusCode === 401) return false;
      if (apiKeyRestricted(fallback)) {
        client.authWarning = 'API Key 有效，但缺少管理接口权限；请授予 account.profile.read、keys.read、usage.read 等权限，或改用密码会话登录。';
        return true;
      }
      throw fallback;
    }
  };
  try {
    await client.get('/v1/models');
    client.authWarning = '';
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) return false;
    if (error instanceof ApiError && (error.statusCode === 403 || error.statusCode === 404 || error.statusCode === 405)) {
      return viaBalance();
    }
    throw error;
  }
}

async function detectAdmin(client) {
  try {
    await client.get('/api/admin/providers', { query: { page: 1, limit: 1 } });
    return true;
  } catch (error) {
    if (!(error instanceof ApiError)) return null;
    if (error.statusCode === 401) throw error;
    if (error.statusCode === 403) {
      if (error.code === 'admin_required') return false;
      return null;
    }
    if (error.statusCode === 404 || error.statusCode === 501) return null;
    return null;
  }
}

async function loginApiKey(client, apiKey) {
  if (!apiKey) throw new Error('需要 API Key');
  client.setApiKey(apiKey);
  client.authWarning = '';
  const valid = await probeApiKey(client);
  if (!valid) {
    client.clearAuth();
    throw Object.assign(new Error('API Key 无效、已停用或已过期'), { statusCode: 401, code: 'invalid_api_key' });
  }
  const isAdmin = await detectAdmin(client);
  let username = '';
  try {
    const keys = await client.get('/api/user/api-keys');
    if (Array.isArray(keys)) {
      const owner = keys.find(row => row && row.owner && row.is_owner)?.owner;
      if (owner && owner.username) username = owner.username;
    }
  } catch (_) { /* optional */ }
  client.username = username ? `${username}（API Key）` : 'API Key 用户';
  client.isAdmin = isAdmin;
  return { username: client.username, isAdmin, authType: 'api-key', warning: client.authWarning || '' };
}

async function logout(client) {
  if (!client.apiKey) {
    try { await client.request('/auth/logout', { method: 'GET', raw: true }); } catch (_) { /* best effort */ }
  }
  client.clearAuth();
}

async function verifySession(client) {
  try {
    const me = await client.get('/auth/me');
    if (!me || typeof me !== 'object') return null;
    client.username = me.username || client.username;
    client.isAdmin = me.isAdmin === true;
    return me;
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) return null;
    throw error;
  }
}

async function verifyApiKey(client) {
  const valid = await probeApiKey(client);
  if (!valid) return false;
  client.isAdmin = await detectAdmin(client);
  return true;
}

module.exports = {
  TwoFactorRequired,
  loginPassword,
  completeTwoFactor,
  loginApiKey,
  logout,
  verifySession,
  verifyApiKey,
  detectAdmin,
  probeApiKey,
  permissionHint,
};
