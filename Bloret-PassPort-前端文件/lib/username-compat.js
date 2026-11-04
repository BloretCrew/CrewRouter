/**
 * 临时兼容模块（旧用户名登录 → 弹窗提示）
 *
 * 独立、可整体移除：删除本文件、删除 index.js 中的一处钩子调用
 * （/login 里 usernameCompat.resolve 相关）、删除 /login 中渲染
 * generateRenameNoticeHtml 的分支，即可下线，不触碰永久的大小写不敏感登录。
 *
 * 只覆盖「不透明改名」的 7 个旧用户名：它们的新用户名不是旧名的
 * 简单大小写变体，无法被大小写不敏感登录直接命中，因此需要这张表桥接。
 */
const escapeHtml = require('../security').escapeHtml;

const COMPAT_MAP = {
    'wedqwdqdw@outlook.com': 'wedqwdqdw',
    'xXYxxdMC-Copy': 'xxyxxdmc_copy',
    '宇曦Chihyu': 'chiyu',
    '任耀': 'renyao',
    '巧乐兹不是屑': 'qlzbsx',
    '杰弟': 'jiedi',
    '积水成渊': 'jishuichengyuan'
};

/** 按旧用户名查新用户名（大小写不敏感），未命中返回 null */
function compatGet(oldUsername) {
    if (!oldUsername) return null;
    const key = String(oldUsername);
    if (Object.prototype.hasOwnProperty.call(COMPAT_MAP, key)) return COMPAT_MAP[key];
    const lower = key.toLowerCase();
    for (const [old, mapped] of Object.entries(COMPAT_MAP)) {
        if (old.toLowerCase() === lower) return mapped;
    }
    return null;
}

function compatEntries() {
    return Object.entries(COMPAT_MAP);
}

/**
 * 弹出确认页：必须点击「确认」按钮关闭，之后跳转到 redirectUri。
 */
function generateRenameNoticeHtml({ old: oldUser, new: newUser, redirectUri }) {
    const safeOld = escapeHtml(String(oldUser || ''));
    const safeNew = escapeHtml(String(newUser || ''));
    const safeRedirect = escapeHtml(String(redirectUri || '/'));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>用户名变更提示 - Bloret PassPort</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; background: rgba(0,0,0,.45); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .modal { background: #fff; border-radius: 16px; box-shadow: 0 32px 110px -38px rgba(15,23,42,.45); max-width: 460px; width: 92%; padding: 28px; text-align: center; }
  .title { font-size: 18px; font-weight: 600; margin-bottom: 14px; }
  .msg { color: #444; line-height: 1.7; margin-bottom: 22px; font-size: 15px; }
  .msg .old { font-weight: 700; color: #c0392b; }
  .msg .new { font-weight: 700; color: #0078d4; }
  .btn { background: #0078d4; color: #fff; border: none; border-radius: 8px; padding: 10px 26px; font-size: 15px; cursor: pointer; }
  .btn:hover { background: #106ebe; }
</style>
</head>
<body>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="nt">
    <div class="title" id="nt">用户名已迁移</div>
    <div class="msg">
      你的用户名已由 <span class="old">${safeOld}</span> 迁移到 <span class="new">${safeNew}</span>。<br>
      旧用户名将于一段时间后失效，请您知悉。
    </div>
    <button class="btn" onclick="window.location.href='${safeRedirect}'">确认</button>
  </div>
</body>
</html>`;
}

module.exports = { COMPAT_MAP, compatGet, compatEntries, generateRenameNoticeHtml };