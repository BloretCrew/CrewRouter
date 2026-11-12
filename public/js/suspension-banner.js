'use strict';

/**
 * 团队版成员暂停提示：全屏遮罩（scope=all）或顶部条（scope=api）。
 * 独立运行，不依赖 AdminApp/App。
 */
(function () {
  if (window.CRSuspension) return;

  let timer = null;
  let overlay = null;
  let banner = null;

  function ensureStyle() {
    if (document.getElementById('cr-suspension-style')) return;
    const style = document.createElement('style');
    style.id = 'cr-suspension-style';
    style.textContent = `
      .cr-suspension-overlay{position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;
        padding:24px;background:rgba(10,12,18,.55);backdrop-filter:blur(8px)}
      .cr-suspension-card{width:min(480px,100%);padding:28px;border-radius:18px;
        border:1px solid var(--border,rgba(120,120,120,.28));background:var(--card,#fff);color:var(--foreground,#111);
        box-shadow:0 24px 60px rgba(0,0,0,.28);text-align:center}
      .cr-suspension-card h2{margin:0 0 8px;font-size:20px}
      .cr-suspension-card p{margin:6px 0;color:var(--muted-foreground,#6b7280);font-size:13px;line-height:1.6}
      .cr-suspension-card .cr-suspension-reason{margin:14px 0;padding:10px 12px;border-radius:10px;
        background:var(--muted,rgba(120,120,120,.08));color:var(--foreground,#111);text-align:left;white-space:pre-wrap}
      .cr-suspension-actions{display:flex;gap:10px;justify-content:center;margin-top:18px}
      .cr-suspension-banner{position:sticky;top:0;z-index:1500;padding:10px 16px;text-align:center;font-size:13px;
        background:var(--destructive,#b91c1c);color:#fff}
      .cr-suspension-banner button{margin-left:10px;border:0;border-radius:6px;padding:2px 10px;cursor:pointer}
    `;
    document.head.appendChild(style);
  }

  function removeOverlay() {
    overlay?.remove();
    overlay = null;
    document.documentElement.style.overflow = '';
  }

  function renderOverlay(user) {
    removeOverlay();
    overlay = document.createElement('div');
    overlay.className = 'cr-suspension-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    const until = user.suspended_until
      ? (window.CRTime ? window.CRTime.formatTime(user.suspended_until, { seconds: true }) : new Date(user.suspended_until).toLocaleString())
      : '管理员手动恢复';
    overlay.innerHTML = `
      <div class="cr-suspension-card">
        <h2>账号已被暂停</h2>
        <p>你的团队管理员已暂停你的账号使用权限。</p>
        ${user.suspended_reason ? `<div class="cr-suspension-reason">${escapeHtml(user.suspended_reason)}</div>` : ''}
        <p>恢复时间：${escapeHtml(until)}</p>
        <p>你仍可查看通知；如有疑问，请联系团队管理员或提交申诉。</p>
        <div class="cr-suspension-actions">
          <button type="button" class="blora-button" data-variant="secondary" id="crSuspensionAppeal">提交申诉</button>
          <button type="button" class="blora-button" data-variant="primary" id="crSuspensionLogout">退出登录</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
    overlay.querySelector('#crSuspensionLogout')?.addEventListener('click', () => {
      fetch('/auth/logout', { credentials: 'same-origin' }).finally(() => { window.location.href = '/'; });
    });
    overlay.querySelector('#crSuspensionAppeal')?.addEventListener('click', () => {
      window.location.href = '/console';
    });
  }

  function renderBanner(user) {
    if (banner) return;
    banner = document.createElement('div');
    banner.className = 'cr-suspension-banner';
    const until = user.suspended_until
      ? (window.CRTime ? window.CRTime.formatTime(user.suspended_until, { seconds: true }) : new Date(user.suspended_until).toLocaleString())
      : '管理员手动恢复';
    banner.innerHTML = `API 访问已被暂停，恢复时间：${escapeHtml(until)} <button type="button" id="crSuspensionBannerLogout">退出登录</button>`;
    document.body.prepend(banner);
    banner.querySelector('#crSuspensionBannerLogout')?.addEventListener('click', () => {
      fetch('/auth/logout', { credentials: 'same-origin' }).finally(() => { window.location.href = '/'; });
    });
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  async function apply(user) {
    ensureStyle();
    if (!user || user.suspended !== true) {
      removeOverlay();
      banner?.remove();
      banner = null;
      return;
    }
    if (user.suspended_scope === 'api') {
      removeOverlay();
      renderBanner(user);
    } else {
      banner?.remove();
      banner = null;
      renderOverlay(user);
    }
  }

  async function refresh() {
    try {
      const response = await fetch('/auth/me', { credentials: 'same-origin' });
      if (!response.ok) return;
      const user = await response.json();
      await apply(user);
    } catch (_) { /* ignore */ }
  }

  function start() {
    refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, 60_000);
  }

  window.CRSuspension = { refresh, start };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
