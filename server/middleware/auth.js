const { pool } = require('../models/database');

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

module.exports = { requireAuth, requireAdmin };
