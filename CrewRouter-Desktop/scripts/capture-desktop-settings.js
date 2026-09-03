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
function windows() { return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()); }
async function getSettingsWindow() {
  const win = windows().find((item) => item.getTitle() === 'CrewRouter Desktop Settings');
  if (!win) throw new Error('独立设置窗口未创建');
  await waitFor(win, "document.readyState === 'complete' && Boolean(window.crewrouterDesktop) && Boolean(document.getElementById('connection'))", 30000);
  return win;
}
async function inspectSettings(win) {
  return win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    const local = document.getElementById('local')?.innerText || '';
    return { text, local, scheme: document.documentElement.dataset.bloraColorScheme,
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      localCardHidden: document.getElementById('local-card')?.hidden,
      hasBridgeError: /桥接不可用|bridge.*unavailable|加载失败/i.test(text) };
  })()`, true);
}
async function assertSettingsPage(win, expectedStatus) {
  await waitFor(win, "document.body.innerText.includes('Desktop 设置') && document.body.innerText.includes('Profiles')", 30000);
  const details = await inspectSettings(win);
  if (details.hasBridgeError || details.localCardHidden || details.scrollWidth > details.clientWidth + 12) throw new Error(`设置页面不可用或溢出：${JSON.stringify(details)}`);
  if (!details.text.includes('desktop-local') || !details.text.includes('personal')) throw new Error(`连接信息缺失：${JSON.stringify(details)}`);
  if (!details.text.includes('Desktop Tester') || /(?:^|\n)(?:token|api[_-]?key|authorization|cookie)\s*[:=]/i.test(details.text)) throw new Error(`Profile 泄露敏感信息：${JSON.stringify(details)}`);
  if (expectedStatus && !details.local.includes(expectedStatus)) throw new Error(`Local Server 状态不是 ${expectedStatus}：${JSON.stringify(details)}`);
  return details;
}
async function capture(win, width, file) {
  win.setSize(width, 700);
  await sleep(400);
  const details = await inspectSettings(win);
  if (!details.text.trim() || details.hasBridgeError || /登录|setup|桥接不可用|bridge.*unavailable/i.test(details.text) || details.scrollWidth > details.clientWidth + 12) throw new Error(`拒绝无效设置截图：${JSON.stringify(details)}`);
  const png = (await win.webContents.capturePage()).toPNG();
  if (png.length < 2000) throw new Error(`设置截图为空白：${file}`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, file), png);
}

app.whenReady().then(async () => {
  console.log(`[desktop-settings] ${phase}: app ready`);
  const main = windows()[0];
  if (!main) throw new Error('Desktop 主窗口未创建');
  await waitFor(main, "document.readyState === 'complete' && Boolean(window.crewrouterDesktop) && Boolean(document.getElementById('local'))", 30000);
  console.log(`[desktop-settings] ${phase}: renderer ready`);
  if (phase === 'first') {
    await main.webContents.executeJavaScript("document.getElementById('local').click(); void 0", true);
    await waitFor(main, "!document.getElementById('local-profile-step').hidden && document.activeElement?.id === 'local-username'");
    await main.webContents.executeJavaScript("document.getElementById('local-username').value = 'Desktop Tester'; document.getElementById('local-profile-form').requestSubmit(); void 0", true);
  }
  await waitFor(main, "location.hostname === '127.0.0.1' && (location.pathname === '/console' || location.pathname === '/console/')", 60000);
  console.log(`[desktop-settings] ${phase}: console ready`);
  await waitFor(main, "Boolean(document.getElementById('desktop-settings'))", 30000);
  await main.webContents.executeJavaScript("document.getElementById('desktop-settings').click(); void 0", true);
  const settings = await getSettingsWindow();
  console.log(`[desktop-settings] ${phase}: settings window ready`);
  let details = await assertSettingsPage(settings, '运行中');
  const data = await settings.webContents.executeJavaScript('window.crewrouterDesktop.getDesktopSettings()', true);
  if (!data.local?.pid || !data.local?.port || data.local.ready !== true) throw new Error(`Local Server 元数据缺失：${JSON.stringify(data.local)}`);
  await settings.webContents.executeJavaScript("document.getElementById('theme').value = 'light'; document.getElementById('theme').dispatchEvent(new Event('change', { bubbles: true })); void 0", true);
  await waitFor(settings, "document.documentElement.dataset.bloraColorScheme === 'light'");
  const saved = await settings.webContents.executeJavaScript('window.crewrouterDesktop.getDesktopSettings()', true);
  if (saved.settings.theme !== 'light') throw new Error(`主题偏好未保存：${JSON.stringify(saved.settings)}`);
  await settings.webContents.executeJavaScript("document.getElementById('copy').click(); void 0", true);
  await waitFor(settings, "document.getElementById('message').textContent.includes('复制') || document.getElementById('message').textContent.includes('Copied')");
  const diagnostics = await settings.webContents.executeJavaScript('navigator.clipboard.readText()', true);
  if (/(?:^|\n)(?:token|api[_-]?key|authorization|cookie)\s*[:=]/i.test(diagnostics) || /Bearer\s+[^\s]+/i.test(diagnostics) || diagnostics.includes(path.resolve(userData))) throw new Error(`诊断信息包含敏感数据：${diagnostics}`);
  await capture(settings, 960, 'desktop-settings-local-960x700.png');
  await capture(settings, 600, 'desktop-settings-local-600x700.png');
  const pid = data.local.pid;
  await settings.webContents.executeJavaScript("window.confirm = () => true; document.getElementById('stop').click(); void 0", true);
  await waitFor(settings, "document.getElementById('local').innerText.includes('已停止')", 30000);
  try { process.kill(pid, 0); throw new Error(`Desktop Local 子进程仍在运行：${pid}`); } catch (error) { if (error.message.includes('仍在运行')) throw error; }
  await settings.webContents.executeJavaScript("document.getElementById('restart').click(); void 0", true);
  await waitFor(settings, "document.getElementById('local').innerText.includes('运行中')", 60000);
  const restoredDetails = await assertSettingsPage(settings, '运行中');
  if (!restoredDetails.local.includes('运行中')) throw new Error('从主窗口重新启动后 Local Server 未恢复运行');
  console.log(JSON.stringify({ phase, screenshots: ['desktop-settings-local-960x700.png', 'desktop-settings-local-600x700.png'], theme: saved.settings.theme, stoppedPid: pid, restored: true }));
  await app.quit();
}).catch((error) => { console.error(error.stack || error.message); app.exit(1); });
setTimeout(() => { console.error('Desktop settings acceptance timed out'); app.exit(2); }, 120000);
