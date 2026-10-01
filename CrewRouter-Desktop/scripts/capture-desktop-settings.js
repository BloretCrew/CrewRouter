'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const userData = process.env.CREWROUTER_ACCEPTANCE_USER_DATA;
const phase = process.env.CREWROUTER_ACCEPTANCE_PHASE || 'first';
const outputDir = path.resolve(process.env.CREWROUTER_ACCEPTANCE_OUTPUT || path.join(__dirname, '..', '..', '.hermes', 'screenshots'));
if (!userData) throw new Error('CREWROUTER_ACCEPTANCE_USER_DATA is required');
app.setPath('userData', path.resolve(userData));
delete process.env.CREWROUTER_SERVER_ROOT;
delete process.env.CREWROUTER_PACKAGED_SERVER_ROOT;
require('../src/main');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(win, expression, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await win.webContents.executeJavaScript(expression, true); if (last) return last; } catch {}
    await sleep(250);
  }
  let diagnostic = {};
  try { diagnostic = await win.webContents.executeJavaScript("({ href: location.href, title: document.title, text: document.body?.innerText?.slice(0, 3000) })", true); } catch (error) { diagnostic = { error: error.message }; }
  throw new Error(`Timed out waiting for ${expression}; last=${last}; diagnostic=${JSON.stringify(diagnostic)}`);
}
function mainWindow() { const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed()); if (!win) throw new Error('Desktop 主窗口未创建'); return win; }
const LAUNCHER_READY = "document.readyState === 'complete' && Boolean(window.crewrouterDesktop) && Boolean(document.getElementById('choose-local'))";
const CONSOLE_READY = "location.hostname === '127.0.0.1' && (location.pathname === '/console' || location.pathname === '/console/')";
async function inspectSettings(win) {
  return win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    return { text, scheme: document.documentElement.dataset.bloraColorScheme, view: document.getElementById('launcher')?.dataset.view || null,
      localStatus: document.getElementById('local-status')?.textContent || '', localPid: document.getElementById('local-pid')?.textContent || '',
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      hasBridgeError: /桥接|bridge.*unavailable|加载失败/i.test(text) };
  })()`, true);
}
async function capture(win, width, file) {
  win.setSize(width, 700);
  await sleep(400);
  const details = await inspectSettings(win);
  if (!details.text.trim() || details.hasBridgeError || details.scrollWidth > details.clientWidth + 12) throw new Error(`拒绝无效截图 ${file}：${JSON.stringify(details)}`);
  const png = (await win.webContents.capturePage()).toPNG();
  if (png.length < 2000) throw new Error(`截图为空白：${file}`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, file), png);
}

app.whenReady().then(async () => {
  console.log(`[desktop-settings] ${phase}: app ready`);
  const win = mainWindow();
  if (phase === 'first') {
    await waitFor(win, LAUNCHER_READY, 30000);
    await win.webContents.executeJavaScript("document.getElementById('choose-local').click(); void 0", true);
    await waitFor(win, "!document.getElementById('view-local-name').hidden && document.activeElement === document.querySelector('#local-username-field input')");
    await win.webContents.executeJavaScript("document.querySelector('#local-username-field input').value = 'Desktop Tester'; document.getElementById('local-profile-form').requestSubmit(); void 0", true);
  }
  await waitFor(win, CONSOLE_READY, 120000);
  console.log(`[desktop-settings] ${phase}: console ready`);
  await waitFor(win, "!document.getElementById('desktopSettingsCard')?.hidden", 30000);
  // 控制台内嵌设置：本地模式必须能读到本地 Server 状态。
  await win.webContents.executeJavaScript("document.getElementById('desktopSettingsCard').click(); void 0", true);
  await waitFor(win, "Boolean(document.getElementById('desktopRestartLocal')) && document.getElementById('desktopSettingsEmbed').innerText.includes('运行中')", 30000);
  const embed = await win.webContents.executeJavaScript("document.getElementById('desktopSettingsEmbed').innerText", true);
  if (!/Desktop Tester/.test(embed) || /(?:^|\n)(?:token|api[_-]?key|authorization|cookie)\s*[:=]/i.test(embed)) throw new Error(`控制台内嵌设置内容不正确：${embed}`);
  await capture(win, 960, 'console-desktop-settings-960x700.png');
  // 返回启动页：本地服务保持运行，已保存的连接可见，设置面板显示本地 Server 状态。
  await win.webContents.executeJavaScript("window.crewrouterDesktop.openLauncher(); void 0", true);
  await waitFor(win, `${LAUNCHER_READY} && !document.getElementById('saved-panel').hidden && !document.getElementById('local-chip').hidden`, 30000);
  await sleep(400);
  await capture(win, 960, 'launcher-saved-960x700.png');
  await win.webContents.executeJavaScript("document.getElementById('open-settings').click(); void 0", true);
  await waitFor(win, "!document.getElementById('view-settings').hidden && document.getElementById('local-status').textContent.includes('运行中')", 30000);
  let details = await inspectSettings(win);
  if (details.hasBridgeError || !/\d+/.test(details.localPid)) throw new Error(`设置面板缺少本地 Server 信息：${JSON.stringify(details)}`);
  const data = await win.webContents.executeJavaScript('window.crewrouterDesktop.getDesktopSettings()', true);
  if (!data.local?.pid || !data.local?.port || data.local.ready !== true) throw new Error(`Local Server 元数据缺失：${JSON.stringify(data.local)}`);
  if (!data.profiles?.some((profile) => profile.displayName === 'Desktop Tester')) throw new Error(`Profile 未保存：${JSON.stringify(data.profiles)}`);
  await win.webContents.executeJavaScript("(async () => { const current = (await window.crewrouterDesktop.getDesktopSettings()).settings; await window.crewrouterDesktop.saveDesktopSettings({ ...current, theme: 'light' }); })()", true);
  await waitFor(win, "document.documentElement.dataset.bloraColorScheme === 'light'");
  const saved = await win.webContents.executeJavaScript('window.crewrouterDesktop.getDesktopSettings()', true);
  if (saved.settings.theme !== 'light') throw new Error(`主题偏好未保存：${JSON.stringify(saved.settings)}`);
  await win.webContents.executeJavaScript("document.getElementById('copy-diagnostics').click(); void 0", true);
  await waitFor(win, "document.getElementById('settings-message').textContent.includes('复制') || document.getElementById('settings-message').textContent.includes('Copied')");
  const diagnostics = await win.webContents.executeJavaScript('navigator.clipboard.readText()', true);
  if (/(?:^|\n)(?:token|api[_-]?key|authorization|cookie)\s*[:=]/i.test(diagnostics) || /Bearer\s+[^\s]+/i.test(diagnostics) || diagnostics.includes(path.resolve(userData))) throw new Error(`诊断信息包含敏感数据：${diagnostics}`);
  await capture(win, 960, 'desktop-settings-local-960x700.png');
  await capture(win, 600, 'desktop-settings-local-600x700.png');
  const pid = data.local.pid;
  await win.webContents.executeJavaScript("document.getElementById('local-stop').click(); void 0", true);
  await waitFor(win, "document.getElementById('confirm-dialog').hasAttribute('open')", 10000);
  await win.webContents.executeJavaScript("document.getElementById('confirm-ok').click(); void 0", true);
  await waitFor(win, "document.getElementById('local-status').textContent.includes('已停止') || document.getElementById('local-status').textContent.includes('Stopped')", 30000);
  try { process.kill(pid, 0); throw new Error(`Desktop Local 子进程仍在运行：${pid}`); } catch (error) { if (error.message.includes('仍在运行')) throw error; }
  await win.webContents.executeJavaScript("document.getElementById('local-restart').click(); void 0", true);
  await waitFor(win, CONSOLE_READY, 120000);
  console.log(JSON.stringify({ phase, screenshots: ['console-desktop-settings-960x700.png', 'launcher-saved-960x700.png', 'desktop-settings-local-960x700.png', 'desktop-settings-local-600x700.png'], theme: saved.settings.theme, stoppedPid: pid, restored: true }));
  await app.quit();
}).catch((error) => { console.error(error.stack || error.message); app.exit(1); });
setTimeout(() => { console.error('Desktop settings acceptance timed out'); app.exit(2); }, 300000);
