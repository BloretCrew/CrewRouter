const { pool } = require('../models/database');
const config = require('../config-loader');
const { loadPersistedEdition, normalizeRuntime, normalizeEdition } = require('../utils/instance-edition');

function sessionUserId(req) {
  const value = req.session?.user?.id;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return null;
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? value : null;
}

// 检查用户是否已登录
async function requireAuth(req, res, next) {
  const userId = sessionUserId(req);
  if (userId === null) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const result = await pool.query('SELECT id, is_admin FROM users WHERE id = $1', [userId]);
    if (result.rows.length !== 1) return res.status(401).json({ error: '请先登录' });
    req.session.user.isAdmin = result.rows[0].is_admin === true;
  } catch (err) {
    return res.status(503).json({ error: '权限暂不可用' });
  }
  return next();
}

// 检查用户是否是管理员，并从数据库读取最新权限
async function requireAdmin(req, res, next) {
  const userId = sessionUserId(req);
  if (userId === null) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
    if (result.rows.length !== 1) {
      return res.status(401).json({ error: '请先登录' });
    }
    req.session.user.isAdmin = result.rows[0].is_admin === true;
    if (!req.session.user.isAdmin) {
      return res.status(403).json({ error: '无管理员权限' });
    }
  } catch (err) {
    return res.status(503).json({ error: '权限暂不可用' });
  }
  return next();
}

async function isPersonalProviderInstance() {
  const edition = await loadPersistedEdition(pool);
  if (edition) return edition === 'personal';
  // Local runtime is personal only when no persisted Team edition overrides it.
  return normalizeRuntime(config.runtime) === 'desktop-local'
    && (config.edition == null || config.edition === '' || normalizeEdition(config.edition) === 'personal');
}

async function requireProviderAccessContext(req, res, next) {
  const userId = sessionUserId(req);
  if (userId === null) return res.status(401).json({ error: '请先登录' });
  try {
    const result = await pool.query('SELECT id, is_admin FROM users WHERE id = $1', [userId]);
    if (result.rows.length !== 1) return res.status(401).json({ error: '请先登录' });
    req.session.user.isAdmin = result.rows[0].is_admin === true;
    req.personalProviderManager = await isPersonalProviderInstance();
  } catch (err) {
    return res.status(503).json({ error: '权限暂不可用' });
  }
  return next();
}

async function requireProviderManager(req, res, next) {
  return requireProviderAccessContext(req, res, () => {
    if (req.personalProviderManager) return next();
    return requireAdmin(req, res, next);
  });
}

module.exports = { requireAuth, requireAdmin, requireProviderManager, requireProviderAccessContext };
