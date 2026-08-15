const express = require('express');
const router = express.Router();
const data = require('./data');

// 获取当前用户信息
router.get('/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  res.json(req.session.user);
});

// 登录（演示模式：直接返回演示用户）
router.post('/login', (req, res) => {
  const user = data.getUser();
  req.session.user = user;
  res.json(user);
});

// 登出
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// 修改密码（演示模式：返回成功但不实际修改）
router.post('/change-password', (req, res) => {
  res.json({ success: true, message: '演示模式下密码不会被修改' });
});

// 飞书登录状态（演示模式：默认不展示）
router.get('/feishu/status', (req, res) => {
  res.json({ enabled: false });
});

module.exports = router;
