const { pool } = require('../models/database');
const config = require('../config-loader');
const { loadPersistedEdition, normalizeRuntime, normalizeEdition } = require('../utils/instance-edition');

// 检查用户是否已登录
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  next();
}

// 检查用户是否是管理员，并从数据库读取最新权限
async function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.session.user.id]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '请先登录' });
    }
    if (!result.rows[0].is_admin) {
      return res.status(403).json({ error: '无管理员权限' });
    }
    req.session.user.isAdmin = true;
    next();
  } catch (err) {
    return res.status(503).json({ error: '权限暂不可用' });
  }
}

async function isPersonalProviderInstance() {
  const edition = await loadPersistedEdition(pool);
  if (edition) return edition === 'personal';
  // Local runtime is personal only when no persisted Team edition overrides it.
  return normalizeRuntime(config.runtime) === 'desktop-local'
    && (config.edition == null || config.edition === '' || normalizeEdition(config.edition) === 'personal');
}

async function requireProviderAccessContext(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: '请先登录' });
  try {
    const result = await pool.query('SELECT id FROM users WHERE id = $1', [req.session.user.id]);
    if (!result.rows.length) return res.status(401).json({ error: '请先登录' });
    req.personalProviderManager = await isPersonalProviderInstance();
    return next();
  } catch (err) {
    return res.status(503).json({ error: '权限暂不可用' });
  }
}

async function requireProviderManager(req, res, next) {
  return requireProviderAccessContext(req, res, () => {
    if (req.personalProviderManager) return next();
    return requireAdmin(req, res, next);
  });
}

module.exports = { requireAuth, requireAdmin, requireProviderManager, requireProviderAccessContext };
