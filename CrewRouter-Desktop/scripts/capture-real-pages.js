'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { LocalServerManager } = require('../src/server-manager');

const output = process.env.CREWROUTER_CAPTURE_OUTPUT || path.resolve(__dirname, '../../.hermes/screenshots');
const teamUrl = process.env.CREWROUTER_TEAM_URL;
if (!teamUrl) throw new Error('CREWROUTER_TEAM_URL is required');
fs.mkdirSync(output, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function capture(win, baseUrl, filename, width, height, theme, expectedText) {
  await win.setSize(width, height);
  await win.loadURL(`${baseUrl}/console#modelLibrary`);
  await win.webContents.executeJavaScript(`localStorage.setItem('theme', ${JSON.stringify(theme)}); document.documentElement.classList.remove('dark', 'light'); document.documentElement.classList.add(${JSON.stringify(theme)}); document.documentElement.style.colorScheme = ${JSON.stringify(theme)}; void 0`, true);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ready = await win.webContents.executeJavaScript("document.body.innerText.includes('模型库') && !document.body.innerText.includes('加载中...') && !document.body.innerText.includes('正在加载')", true).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
  await sleep(1000);
  fs.writeFileSync(path.join(output, filename), (await win.webContents.capturePage()).toPNG());
  const details = await win.webContents.executeJavaScript(`({ href: location.href, title: document.title, text: document.body.innerText.slice(0, 5000), badge: document.querySelector('[data-edition-badge]')?.textContent || '' })`, true);
  if (details.href.includes('/404') || /Not found|Error response|No route found/.test(details.text)) throw new Error(`${filename} captured a 404: ${JSON.stringify(details)}`);
  if (!details.badge) throw new Error(`${filename} has no edition badge: ${JSON.stringify(details)}`);
  if (expectedText && !details.text.includes(expectedText)) throw new Error(`${filename} missing expected content: ${expectedText}`);
  return details;
}

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: false } });
  const personalData = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-real-pages-'));
  const manager = new LocalServerManager({ mode: 'development', userData: personalData, startupTimeoutMs: 30000 });
  try {
    const results = {};
    results.teamLight = await capture(win, teamUrl, 'team-light-real.png', 1280, 800, 'light', '2 个模型');
    results.teamDark = await capture(win, teamUrl, 'team-dark-real.png', 1280, 800, 'dark', '2 个模型');
    results.teamNarrow = await capture(win, teamUrl, 'team-narrow-real.png', 600, 800, 'light', '2 个模型');
    const personal = await manager.start();
    results.personalLight = await capture(win, personal.baseUrl, 'personal-light-real.png', 1280, 800, 'light', 'Personal 版本地服务不提供共享模型库');
    results.personalDark = await capture(win, personal.baseUrl, 'personal-dark-real.png', 1280, 800, 'dark', 'Personal 版本地服务不提供共享模型库');
    results.personalNarrow = await capture(win, personal.baseUrl, 'personal-narrow-real.png', 600, 800, 'light', 'Personal 版本地服务不提供共享模型库');
    console.log(JSON.stringify({ results, output }));
  } finally {
    await manager.stop().catch(() => {});
    fs.rmSync(personalData, { recursive: true, force: true });
    await win.destroy();
    app.quit();
  }
})().catch(error => { console.error(error.stack || error.message); app.exit(1); });
setTimeout(() => { console.error('real page capture timed out'); app.exit(2); }, 120000);
