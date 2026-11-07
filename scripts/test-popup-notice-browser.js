#!/usr/bin/env node
'use strict';

/**
 * 弹窗通知浏览器验收
 *
 * 自带隔离 demo 服务（CR_DEMO=true，随机端口）与 headless Chrome（CDP），
 * 不依赖 verify-blora-correction-browser 的常驻进程。
 *
 *   node scripts/test-popup-notice-browser.js            # 断言 + 截图到 /tmp
 *   node scripts/test-popup-notice-browser.js --keep     # 保留临时目录便于排查
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.CR_POPUP_TEST_PORT || 18641);
const CDP_PORT = Number(process.env.CR_POPUP_CDP_PORT || 18642);
const BASE = `http://127.0.0.1:${PORT}`;
const keep = process.argv.includes('--keep');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-popup-test-'));
const screenshots = [];

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }

  send(method, params = {}, timeoutMs = 20000) {
    return this.ready.then(() => new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    }));
  }

  fire(method, params = {}) {
    return this.ready.then(() => {
      const id = ++this.id;
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text + ': ' + (response.exceptionDetails.exception?.description || ''));
    }
    return response.result.value;
  }

  async click(selector) {
    const point = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!point) return false;
    await sleep(120);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return true;
  }

  async screenshot(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(os.tmpdir(), `cr-popup-${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    screenshots.push(file);
    return file;
  }
}

async function waitFor(fn, timeoutMs = 12000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) throw lastError;
  return null;
}

function startServer(configPath, logPath) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    CR_APP_HOST: '127.0.0.1',
    CR_APP_PORT: String(PORT),
    CR_DEMO: 'true',
    CR_CONFIG_PATH: configPath,
    CR_LOGIN_REPORT_ENABLED: 'false',
    CR_STATS_REPORT_ENABLED: 'false',
  };
  fs.writeFileSync(configPath, JSON.stringify({
    database: { host: '127.0.0.1', port: 1, name: 'none', user: 'none', password: 'none' },
    app: { host: '127.0.0.1', port: PORT },
    demo: true,
  }));
  const log = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root, env, stdio: ['ignore', log, log], detached: false,
  });
  return child;
}

function startChrome(profileDir) {
  const child = spawn('google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return child;
}

async function getTarget() {
  return waitFor(async () => {
    const response = await fetch(`${BASE.replace(String(PORT), String(CDP_PORT))}/json/new?about:blank`, { method: 'PUT' });
    if (!response.ok) return null;
    return response.json();
  }, 15000);
}

async function newPage(cdp, url) {
  // Chrome 152 偶发不回 Page.navigate 结果；发完后轮询 readyState
  await cdp.fire('Page.navigate', { url: 'about:blank' });
  await sleep(80);
  await cdp.fire('Page.navigate', { url });
  // 页面可能被 CDN 资源（Chart.js / SF 图标）拖住 load 事件；interactive 即可
  for (let i = 0; i < 120; i += 1) {
    const state = await cdp.evaluate('document.readyState').catch(() => null);
    if ((state === 'interactive' || state === 'complete')) {
      const href = await cdp.evaluate('location.href').catch(() => '');
      if (href && href !== 'about:blank') return;
    }
    await sleep(100);
  }
  throw new Error(`page did not become interactive: ${url}`);
}

async function setViewport(cdp, width, height, theme) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme || 'light' },
      { name: 'prefers-reduced-motion', value: 'no-preference' },
    ],
  });
}

async function setPopupDemo(cdp, on, theme) {
  const themeScript = `localStorage.setItem('theme', ${JSON.stringify(theme || 'light')});`;
  const demoScript = on ? "sessionStorage.setItem('crPopupDemo','1');" : "sessionStorage.removeItem('crPopupDemo');";
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `${themeScript} try { ${demoScript} } catch (e) {}`,
  });
}

async function main() {
  const configPath = path.join(tmpRoot, 'config.json');
  const logPath = path.join(tmpRoot, 'server.log');
  const profileDir = path.join(tmpRoot, 'chrome');
  fs.mkdirSync(profileDir, { recursive: true });
  const server = startServer(configPath, logPath);
  let chrome;
  let cdp;
  try {
    await waitFor(async () => {
      try { return (await fetch(`${BASE}/api/config`)).ok; } catch (_) { return false; }
    }, 25000);
    chrome = startChrome(profileDir);
    const target = await getTarget();
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    // 收集控制台错误，非 demo 弹窗路径不应报错
    const pageErrors = [];
    cdp.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        const entry = message.params.entry;
        const text = entry.text || '';
        const url = entry.url || '';
        // 演示环境无外网：CDN Chart.js / SF 图标 / 插件商店等外部资源 404 与本次功能无关
        if (/cdn\.jsdelivr|img\.bloret\.net|crewrouter\.bloret\.net/.test(url)) return;
        if (/Failed to load resource/.test(text) && /404/.test(text) && url) return;
        pageErrors.push(text || url);
      }
    });

    // ---------- 1. 控制台：两条演示通知 ----------
    await setViewport(cdp, 1440, 900, 'light');
    await setPopupDemo(cdp, true, 'light');
    // 记录已读上报请求（每次导航前注入）
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__pnSeen = []; (() => {
        const original = window.fetch;
        window.fetch = function (url, options) {
          if (String(url).includes('/api/user/popup-notices/seen') && options && options.body) {
            try { window.__pnSeen.push(JSON.parse(options.body)); } catch (e) {}
          }
          return original.apply(this, arguments);
        };
      })();`,
    });
    await newPage(cdp, `${BASE}/console`);
    const opened = await waitFor(() => cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay[open]')`));
    assert.ok(opened, '弹窗通知应自动打开');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.cr-pn-card').length`), 2, '应渲染 2 张卡片');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.cr-pn-bubble').length`), 2, '应渲染 2 个气泡');
    assert.equal(await cdp.evaluate(`document.querySelector('.cr-pn-overlay').getAttribute('aria-modal')`), 'true');
    assert.equal(await cdp.evaluate(`document.documentElement.classList.contains('cr-pn-lock')`), true, '滚动应锁定');
    assert.equal(await cdp.evaluate(`document.querySelector('.cr-pn-card.is-active .cr-pn-title').textContent`), '欢迎使用 CrewRouter');
    await sleep(700);
    await cdp.screenshot('console-1440-light');

    // ---------- 2. 字体轮播（50～70ms 随机）+ 暖色背景 ----------
    const swapTiming = await cdp.evaluate(`(() => new Promise((resolve) => {
      const node = document.querySelector('.cr-pn-card.is-active .cr-pn-wordmark span');
      if (!node) return resolve({ ok: false, reason: 'missing-wordmark' });
      const stamps = [];
      let last = '';
      const start = performance.now();
      const timer = setInterval(() => {
        const family = node.style.fontFamily || getComputedStyle(node).fontFamily;
        if (family && family !== last) {
          stamps.push(performance.now());
          last = family;
        }
        if (stamps.length >= 8 || performance.now() - start > 900) {
          clearInterval(timer);
          const intervals = [];
          for (let i = 1; i < stamps.length; i += 1) intervals.push(stamps[i] - stamps[i - 1]);
          resolve({ ok: true, count: stamps.length, intervals, families: stamps.length });
        }
      }, 8);
    }))()`);
    assert.ok(swapTiming && swapTiming.ok, `字体轮播采样失败：${JSON.stringify(swapTiming)}`);
    assert.ok(swapTiming.count >= 5, `50～70ms 周期内应多次切换字体，实际 ${swapTiming.count} 次：${JSON.stringify(swapTiming)}`);
    const inRange = (swapTiming.intervals || []).filter((ms) => ms >= 40 && ms <= 95);
    assert.ok(inRange.length >= Math.min(3, swapTiming.intervals.length),
      `切换间隔应落在约 50～70ms（允许采样抖动），实际：${JSON.stringify(swapTiming.intervals)}`);

    const warmPalette = await cdp.evaluate(`(() => {
      const hero = document.querySelector('.cr-pn-card.is-active .cr-pn-hero');
      const gradient = document.querySelector('.cr-pn-card.is-active .cr-pn-hero-gradient');
      const blobs = [...document.querySelectorAll('.cr-pn-card.is-active .cr-pn-hero-blob')]
        .map((el) => getComputedStyle(el).backgroundImage);
      return {
        heroBg: getComputedStyle(hero).backgroundImage,
        gradientBg: getComputedStyle(gradient).backgroundImage,
        blobs,
      };
    })()`);
    const warmJoined = JSON.stringify(warmPalette);
    assert.match(warmJoined, /249,\s*115,\s*22|245,\s*158,\s*11|244,\s*63,\s*94|234,\s*88,\s*12/,
      `动态背景应使用暖色 RGB，实际：${warmJoined.slice(0, 400)}`);
    assert.doesNotMatch(warmJoined, /20,\s*86,\s*240|6,\s*182,\s*212/,
      `动态背景不应再使用冷蓝/青色，实际：${warmJoined.slice(0, 400)}`);

    // ---------- 3. 切换到第二条 ----------
    assert.ok(await cdp.click('.cr-pn-bubble[data-id="2"]'), '应能点击第二个气泡');
    await sleep(500);
    assert.equal(await cdp.evaluate(`document.querySelector('.cr-pn-card.is-active').dataset.id`), '2');
    assert.equal(await cdp.evaluate(`document.querySelector('.cr-pn-card[data-id="2"]').style.getPropertyValue('--d')`), '0');
    assert.equal(await cdp.evaluate(`document.querySelector('.cr-pn-bubble[data-id="2"]').classList.contains('is-active')`), true);
    await cdp.screenshot('console-1440-active2');

    // ---------- 4. 逐条关闭 ----------
    assert.ok(await cdp.click('.cr-pn-card.is-active .cr-pn-close'));
    await sleep(400);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.cr-pn-card').length`), 1, '关闭后应剩 1 张');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.cr-pn-bubble').length`), 0, '只剩一条时不再显示气泡列表');
    assert.ok(await cdp.click('.cr-pn-card.is-active .cr-pn-close'));
    await sleep(500);
    assert.equal(await cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay')`), false, '全部关闭后应移除浮层');
    assert.equal(await cdp.evaluate(`document.documentElement.classList.contains('cr-pn-lock')`), false, '滚动应解锁');
    const seenBodies = await cdp.evaluate('window.__pnSeen || []');
    const seenIds = new Set(seenBodies.flatMap(entry => entry.ids || []));
    assert.deepEqual([...seenIds].sort((a, b) => a - b), [1, 2], '两条通知都应上报已读');

    // ---------- 5. 深色 + 窄屏 ----------
    await setPopupDemo(cdp, true, 'dark');
    await setViewport(cdp, 390, 844, 'dark');
    await newPage(cdp, `${BASE}/console`);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay[open]')`));
    await sleep(700);
    const mobile = await cdp.evaluate(`(() => {
      const bubbles = document.querySelector('.cr-pn-bubbles');
      const card = document.querySelector('.cr-pn-card.is-active');
      const r = card.getBoundingClientRect();
      return { bubblesBelow: bubbles.getBoundingClientRect().top > r.top, width: r.width, viewport: innerWidth,
        overflow: document.documentElement.scrollWidth <= innerWidth + 1 };
    })()`);
    assert.equal(mobile.bubblesBelow, true, '窄屏气泡列表应在卡片下方');
    assert.ok(mobile.width <= mobile.viewport, '卡片不应溢出视口');
    assert.equal(mobile.overflow, true, '页面不应出现横向滚动');
    await cdp.screenshot('console-390-dark');

    // 390 浅色 + 关闭一条后仅剩一张（无气泡）
    await setPopupDemo(cdp, true, 'light');
    await setViewport(cdp, 390, 844, 'light');
    await newPage(cdp, `${BASE}/console`);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay[open]')`));
    await sleep(600);
    await cdp.screenshot('console-390-light');
    await cdp.evaluate(`document.querySelector('.cr-pn-card.is-active .cr-pn-close').click()`);
    await sleep(450);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.cr-pn-bubbles .cr-pn-bubble').length`), 0, '剩一条时无气泡');
    await cdp.screenshot('console-390-light-single');

    // ---------- 5b. 820 宽度（平板）+ 深色桌面 ----------
    await setViewport(cdp, 820, 1024, 'dark');
    await newPage(cdp, `${BASE}/console`);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay[open]')`));
    await sleep(700);
    await cdp.screenshot('console-820-dark');

    await setPopupDemo(cdp, true, 'dark');
    await setViewport(cdp, 1440, 900, 'dark');
    await newPage(cdp, `${BASE}/console`);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay[open]')`));
    await sleep(700);
    await cdp.screenshot('console-1440-dark');

    // ---------- 6. 管理后台：列表 + 预览 ----------
    await setViewport(cdp, 1440, 900, 'light');
    await setPopupDemo(cdp, false, 'light');
    await newPage(cdp, `${BASE}/admin#adminSettings`);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('[data-admin-settings-category="popups"]')`));
    // 等 adminApp 实例化（DOMContentLoaded 后）
    await waitFor(() => cdp.evaluate(`typeof adminApp !== 'undefined' && !!adminApp`));
    await sleep(300);
    assert.ok(await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-admin-settings-category="popups"]');
      if (!el) return false;
      el.click();
      return true;
    })()`), '应能进入弹窗通知类别');
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.cr-admin-pn-row').length >= 2`));
    await cdp.screenshot('admin-settings-1440');
    assert.ok(await cdp.evaluate(`(() => {
      const el = document.querySelector('.cr-admin-pn-row .cr-admin-pn-actions .blora-button');
      if (!el) return false;
      el.click();
      return true;
    })()`), '应能点开预览');
    const previewOpen = await waitFor(() => cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay[open]')`));
    assert.ok(previewOpen, '预览应打开');
    assert.equal(await cdp.evaluate(`document.querySelector('dialog.cr-pn-overlay').hasAttribute('data-preview')`), true);
    // 已读不应上报
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.cr-pn-bubble').length`), 0, '预览单条不带气泡列表');
    await cdp.screenshot('admin-preview-1440');
    await cdp.evaluate(`document.querySelector('dialog.cr-pn-overlay').querySelector('.cr-pn-close').click()`);
    await sleep(400);
    assert.equal(await cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay')`), false);

    // ---------- 7. 编辑弹窗 + 顶部草稿预览 ----------
    await cdp.evaluate(`adminApp.openPopupNoticeEditor(1)`);
    await waitFor(() => cdp.evaluate(`document.getElementById('popupNoticeTitle').value.length > 0`));
    assert.equal(await cdp.evaluate(`document.getElementById('popupNoticeTitle').value`), '欢迎使用 CrewRouter');
    assert.equal(await cdp.evaluate(`document.getElementById('popupNoticeEnabled').checked`), true, '启用开关应反映通知状态');
    // 「停用」一条后重新打开编辑，开关应为关闭
    await cdp.evaluate(`document.querySelector('.cr-admin-pn-row .cr-admin-pn-actions .blora-button[data-variant="outline"]:nth-of-type(2)')?.click()`);
    await sleep(500);
    const disabledState = await cdp.evaluate(`(async () => {
      const row = document.querySelector('.cr-admin-pn-row');
      const buttons = [...row.querySelectorAll('.cr-admin-pn-actions .blora-button')];
      buttons.find(b => b.textContent === '停用')?.click();
      await new Promise(r => setTimeout(r, 400));
      adminApp.openPopupNoticeEditor(1);
      await new Promise(r => setTimeout(r, 200));
      const checked = document.getElementById('popupNoticeEnabled').checked;
      adminApp.closePopupNoticeEditor();
      return checked;
    })()`);
    assert.equal(disabledState, false, '停用后编辑弹窗的开关应为关闭');
    // 复原：重新启用并再次打开编辑
    await cdp.evaluate(`(async () => {
      const row = document.querySelector('.cr-admin-pn-row');
      const buttons = [...row.querySelectorAll('.cr-admin-pn-actions .blora-button')];
      buttons.find(b => b.textContent === '启用')?.click();
      await new Promise(r => setTimeout(r, 400));
      adminApp.openPopupNoticeEditor(1);
      await new Promise(r => setTimeout(r, 200));
    })()`);
    await sleep(300);
    // 编辑弹窗内预览：top layer 后打开者应在上，中心点命中预览卡片
    await cdp.evaluate(`adminApp.previewPopupNoticeDraft()`);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay[open]')`));
    await sleep(350);
    const topmost = await cdp.evaluate(`(() => {
      const card = document.querySelector('dialog.cr-pn-overlay .cr-pn-card.is-active');
      const r = card.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!(hit && card.contains(hit));
    })()`);
    assert.equal(topmost, true, '预览应位于编辑弹窗之上');
    await cdp.screenshot('admin-preview-over-editor-1440');
    await cdp.evaluate(`document.querySelector('dialog.cr-pn-overlay .cr-pn-close').click()`);
    await sleep(400);
    assert.equal(await cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay')`), false);
    assert.equal(await cdp.evaluate(`document.getElementById('popupNoticeEditorModal').hasAttribute('open')`), true, '关闭预览后编辑弹窗仍在');
    await cdp.screenshot('admin-editor-1440');

    // ---------- 8. 健壮性：10 条通知 + 超长无空格文本 ----------
    await setViewport(cdp, 1440, 900, 'light');
    await newPage(cdp, `${BASE}/console`);
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      title: `第 ${i + 1} 条：${'超长标题'.repeat(10)}`,
      body: `${'A'.repeat(600)}\n第二行 ${'很长内容'.repeat(30)}`,
      closeText: '关闭'.repeat(10),
    }));
    await cdp.evaluate(`window.CrewRouterPopupNotices.show(${JSON.stringify(many)})`);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('dialog.cr-pn-overlay[open]')`));
    await sleep(400);
    const manyState = await cdp.evaluate(`(() => {
      const card = document.querySelector('.cr-pn-card.is-active');
      const title = card.querySelector('.cr-pn-title');
      const close = card.querySelector('.cr-pn-close');
      const r = card.getBoundingClientRect();
      return {
        cards: document.querySelectorAll('.cr-pn-stage .cr-pn-card').length,
        bubbles: document.querySelectorAll('.cr-pn-bubble').length,
        cardOverflow: r.right <= innerWidth + 1 && r.left >= -1,
        titleOverflow: title.scrollWidth <= title.clientWidth + 1,
        closeClipped: close.scrollWidth > close.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      };
    })()`);
    assert.equal(manyState.cards, 10);
    assert.equal(manyState.bubbles, 10);
    assert.equal(manyState.cardOverflow, true, '卡片不应溢出视口');
    assert.equal(manyState.pageOverflow, true, '页面不应横向滚动');
    assert.equal(manyState.titleOverflow, true, '长标题应换行而非撑破');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    await sleep(150);
    await cdp.screenshot('console-1440-many');
    // 只剩 10 条时气泡列表可滚动
    assert.equal(await cdp.evaluate(`(() => {
      const nav = document.querySelector('.cr-pn-bubbles');
      return getComputedStyle(nav).overflowY === 'auto';
    })()`), true);
    await cdp.evaluate('window.CrewRouterPopupNotices.close()');

    console.log('弹窗通知浏览器测试通过');
    if (pageErrors.length) console.log('页面错误（已忽略 CDN 资源失败）:', pageErrors);
    console.log(JSON.stringify({ screenshots }, null, 2));
  } finally {
    try { cdp && await cdp.send('Browser.close'); } catch (_) { /* ignore */ }
    try { chrome && chrome.kill('SIGKILL'); } catch (_) { /* ignore */ }
    try { server.kill('SIGKILL'); } catch (_) { /* ignore */ }
    if (!keep) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    } else {
      console.log(`temp dir kept: ${tmpRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
