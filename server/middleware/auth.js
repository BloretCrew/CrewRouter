// 检查用户是否已登录
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  next();
}

// 检查用户是否是管理员
function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  if (!req.session.user.isAdmin) {
    return res.status(403).json({ error: '无管理员权限' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
