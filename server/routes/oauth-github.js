'use strict';

const router = require('express').Router();

// No supported edition advertises GitHub login. The obsolete router bypassed
// auth-mode policy and linked existing accounts by email without local proof.
// Keep an explicit response for old bookmarks, with no code exchange or DB write.
router.use((req, res) => {
  res.status(410).json({
    error: '旧版 GitHub 登录已停用，请使用当前实例提供的登录方式',
    type: 'auth_method_disabled',
  });
});

module.exports = router;
