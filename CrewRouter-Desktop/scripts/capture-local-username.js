'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const userData = process.env.CREWROUTER_ACCEPTANCE_USER_DATA;
const phase = process.env.CREWROUTER_ACCEPTANCE_PHASE || 'first';
const outputDir = path.resolve(process.env.CREWROUTER_ACCEPTANCE_OUTPUT || '.hermes/screenshots');
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
    try {
      last = await win.webContents.executeJavaScript(expression, true);
      if (last) return last;
    } catch {}
    await sleep(250);
  }
  let diagnostic = {};
  try { diagnostic = await win.webContents.executeJavaScript("({ href: location.href, title: document.title, text: document.body?.innerText?.slice(0, 2000) })", true); } catch (error) { diagnostic = { error: error.message }; }
  throw new Error(`Timed out waiting for ${expression}; last=${last}; diagnostic=${JSON.stringify(diagnostic)}`);
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('Desktop window was not created');
  await waitFor(win, "document.readyState === 'complete' && Boolean(window.crewrouterDesktop) && Boolean(document.getElementById('local'))");
  await sleep(500);
  if (phase === 'first') {
    await win.webContents.executeJavaScript("document.getElementById('local').click(); void 0", true);
    await waitFor(win, "!document.getElementById('local-profile-step').hidden && document.activeElement?.id === 'local-username'");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'local-username-oobe-960x700.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.getElementById('local-username').value = 'Desktop Tester'; document.getElementById('local-profile-form').requestSubmit(); void 0", true);
    await waitFor(win, "location.hostname === '127.0.0.1' && (location.pathname === '/console' || location.pathname === '/console/')", 60000);
    await waitFor(win, "document.body.innerText.includes('模型库') && !document.body.innerText.includes('登录') && document.getElementById('modelLibraryContent')?.innerText.includes('暂无可用模型')", 30000);
    await sleep(1500);
    fs.writeFileSync(path.join(outputDir, 'personal-model-library-960x700.png'), (await win.webContents.capturePage()).toPNG());
    win.setSize(600, 700);
    await sleep(500);
    fs.writeFileSync(path.join(outputDir, 'personal-model-library-600x700.png'), (await win.webContents.capturePage()).toPNG());
    const details = await win.webContents.executeJavaScript(`(async () => { const me = await fetch('/auth/me').then(r => r.json()).catch(() => ({})); const content = document.getElementById('modelLibraryContent')?.innerText || ''; const binding = document.getElementById('modelLibraryBindingSummary')?.innerText || ''; return { href: location.href, body: document.body.innerText.slice(0, 12000), username: me.username || null, hasLogin: /登录|Passport|密码/.test(document.body.innerText), hasSetup: location.pathname.includes('setup'), hasUnavailableLibrary: /Personal 版本地服务不提供共享模型库|Personal 不提供模型库/.test(document.body.innerText), hasProviderEmptyState: /还没有配置 Provider|还没有配置供应商|暂无可用模型/.test(content), hasKeyBindingPrompt: /还没有 API Key/.test(binding), keySelectorHidden: getComputedStyle(document.getElementById('modelLibraryKeySelector'))?.display === 'none' }; })()`, true);
    if (details.hasLogin || details.hasSetup || details.username !== 'Desktop Tester' || !details.body.includes('模型库') || details.hasUnavailableLibrary || !details.hasProviderEmptyState || !details.hasKeyBindingPrompt || details.body.includes('加载失败')) throw new Error(`Console acceptance failed: ${JSON.stringify(details)}`);
    console.log(JSON.stringify({ phase, screenshots: ['personal-model-library-960x700.png', 'personal-model-library-600x700.png'], href: details.href, hasLogin: details.hasLogin, hasSetup: details.hasSetup }));
  } else {
    await waitFor(win, "location.hostname === '127.0.0.1' && (location.pathname === '/console' || location.pathname === '/console/')", 60000);
    const state = await waitFor(win, "document.body.innerText.includes('模型库') && !document.body.innerText.includes('登录') && document.getElementById('modelLibraryContent')?.innerText.includes('暂无可用模型')", 30000) && await win.webContents.executeJavaScript("(async () => { const me = await fetch('/auth/me').then(r => r.json()).catch(() => ({})); const content = document.getElementById('modelLibraryContent')?.innerText || ''; const binding = document.getElementById('modelLibraryBindingSummary')?.innerText || ''; return { href: location.href, text: document.body.innerText, username: me.username || null, unavailable: /Personal 版本地服务不提供共享模型库|Personal 不提供模型库/.test(document.body.innerText), providerEmptyState: /还没有配置 Provider|还没有配置供应商|暂无可用模型/.test(content), keyBindingPrompt: /还没有 API Key/.test(binding), keySelectorHidden: getComputedStyle(document.getElementById('modelLibraryKeySelector'))?.display === 'none' }; })()", true);
    if (!state.href.includes('127.0.0.1') || state.username !== 'Desktop Tester' || !state.text.includes('模型库') || state.unavailable || !state.providerEmptyState || !state.keyBindingPrompt || state.text.includes('加载失败')) throw new Error(`Automatic local start failed: ${JSON.stringify(state)}`);
    if (/登录|Passport|密码/.test(state.text)) throw new Error('Automatic local start displayed an auth page');
    console.log(JSON.stringify({ phase, href: state.href, autoSkippedUsername: state.profile, hasLogin: false }));
  }
  await app.quit();
}).catch((error) => { console.error(error.stack || error.message); app.exit(1); });
setTimeout(() => { console.error('Acceptance timed out'); app.exit(2); }, 90000);
