'use strict';

const path = process.type === 'renderer' ? null : require('node:path');
const desktop = path && path.resolve(__dirname, '..');
const root = path && path.resolve(desktop, '..');
const channel = 'client-config-flow';

if (process.type === 'renderer') {
  const { contextBridge, ipcRenderer } = require('electron');
  const mode = process.argv.find(value => value.startsWith('--config-flow-mode='))?.split('=')[1];
  if (mode !== 'browser') {
    const bridge = { getStatus: async () => ({ mode: mode === 'local' ? 'local' : 'remote' }) };
    if (mode !== 'legacy') {
      bridge.getClientConfigTarget = tool => ipcRenderer.invoke(channel, 'target', tool);
      bridge.writeClientConfig = input => ipcRenderer.invoke(channel, 'write', input);
    }
    contextBridge.exposeInMainWorld('crewrouterDesktop', bridge);
  }
} else if (!process.versions.electron) {
  const fs = require('node:fs');
  const os = require('node:os');
  const { spawn } = require('node:child_process');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-client-config-flow-'));
  const home = path.join(temporary, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(temporary, 'cache'), CLIENT_CONFIG_FLOW_TEMP: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = require('electron');
  const args = ['--disable-gpu', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), __filename];
  const child = spawn(process.platform === 'linux' ? 'xvfb-run' : electron, process.platform === 'linux' ? ['-a', electron, ...args] : args, { cwd: desktop, env, stdio: 'inherit' });
  let stopped = false;
  const cleanup = () => fs.rmSync(temporary, { recursive: true, force: true });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopped = true; child.kill(signal); });
  child.once('error', error => { cleanup(); console.error(error); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = stopped ? 1 : code ?? 1; });
} else {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const http = require('node:http');
  const { app, BrowserWindow, ipcMain, clipboard, session } = require('electron');
  const temporary = process.env.CLIENT_CONFIG_FLOW_TEMP;
  if (!temporary || !path.basename(temporary).startsWith('crewrouter-client-config-flow-')) throw new Error('Run this script with Node to create an isolated test home.');
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  app.setPath('userData', path.join(temporary, 'electron'));
  const home = path.join(temporary, 'home');
  const tools = ['claude', 'codex', 'opencode', 'grok', 'qwen_code', 'hermes', 'openclaw'];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const key = 'sk-client-config-fixture-only';
  const windows = new Set();
  let server;
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; };

  function fixtureServer() {
    const express = require(path.join(root, 'node_modules/express'));
    const fixture = express();
    const data = require(path.join(root, 'server/demo/data'));
    fixture.get('/auth/me', (_, res) => res.json({ id: 1, username: 'Config fixture', isAdmin: false }));
    fixture.get('/api/instance', (_, res) => res.json({ edition: 'personal', runtime: 'desktop-local', capabilities: {} }));
    fixture.get('/api/config', (_, res) => res.json({ demo: true, loginReportEnabled: false, statsReportEnabled: false }));
    fixture.get('/api/user/api-keys/:id/config', (req, res) => res.json({ env: { ANTHROPIC_BASE_URL: req.get('referer')?.includes('mode=remote') ? 'https://remote.fixture.invalid' : fixture.baseUrl, ANTHROPIC_AUTH_TOKEN: key } }));
    fixture.get('/api/user/api-keys', (_, res) => res.json(data.apiKeys().map(item => ({ ...item, key_type: 'normal', is_owner: true }))));
    fixture.get('/api/plugins/runtime', (_, res) => res.json({ plugins: [], defaultTheme: '' }));
    fixture.get('/api/plugins/user-theme', (_, res) => res.json({ themeId: '' }));
    fixture.get(['/api/user/key-tags', '/api/user/providers', '/api/user/provider-tags'], (_, res) => res.json([]));
    fixture.get('/api/user/stats', (_, res) => res.json({}));
    fixture.use('/api', (_, res) => res.json({}));
    fixture.use('/lang', express.static(path.join(root, 'lang')));
    fixture.use('/blora', express.static(path.join(path.dirname(require.resolve('@bloret-crew/blora-design/package.json')), 'dist')));
    fixture.get('/console', (_, res) => res.sendFile(path.join(root, 'public/pages/console.html')));
    fixture.use(express.static(path.join(root, 'public')));
    return new Promise(resolve => {
      server = http.createServer(fixture).listen(0, '127.0.0.1', () => {
        fixture.baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve(fixture.baseUrl);
      });
    });
  }

  function seeded(tool) {
    if (tool === 'codex' || tool === 'grok') return '# Keep existing comment\nsentinel = "keep-existing" # inline comment\n[permissions]\npolicy = "ask"\n[[hooks.start]]\ncommand = "echo fixture"\n';
    if (tool === 'hermes') return 'sentinel: keep-existing\npermissions:\n  policy: ask\n';
    return JSON.stringify({ sentinel: 'keep-existing', permissions: { policy: 'ask' }, env: { KEEP_EXISTING: 'yes' } }, null, 2) + '\n';
  }

  function readConfig(tool, file) {
    const text = fs.readFileSync(file, 'utf8');
    if (tool === 'codex' || tool === 'grok') return require('@iarna/toml').parse(text);
    if (tool === 'hermes') return require('yaml').parse(text);
    if (tool === 'openclaw') return require('json5').parse(text);
    return require('jsonc-parser').parse(text);
  }

  async function run() {
    const { createClientConfigService } = require('../src/app/client-config');
    const base = await fixtureServer();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(base + '/') && !details.url.startsWith('data:') && details.url !== 'about:blank' }));
    session.defaultSession.setPermissionRequestHandler((_, permission, callback) => callback(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read'));
    const originalClipboard = clipboard.readText();
    let active;
    ipcMain.handle(channel, async (event, action, input) => {
      assert.equal(event.sender, active.win.webContents, 'Only the active fixture window may access the service');
      if (action === 'target') return active.service.getClientConfigTarget(input);
      assert.equal(action, 'write');
      active.calls.push(input);
      try {
        const result = await active.service.writeClientConfig(input);
        active.results.push(result);
        return result;
      } catch (error) { active.failures.push(error.message); throw error; }
    });
    try {
      for (const width of [375, 1280]) {
        for (const mode of ['browser', 'legacy', 'local', 'remote']) {
          const errors = [];
          const win = new BrowserWindow({ width, height: 900, useContentSize: true, show: true, webPreferences: { preload: __filename, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, additionalArguments: [`--config-flow-mode=${mode}`] } });
          windows.add(win);
          win.focus();
          const caseHome = path.join(home, `${mode}-${width}`);
          fs.mkdirSync(caseHome);
          active = { win, calls: [], results: [], failures: [], response: 1, delay: 0, confirmations: [] };
          const state = active;
          state.service = createClientConfigService({ home: caseHome, env: {}, getWindow: () => win, dialog: {
            showMessageBox: async (_, options) => {
              state.confirmations.push(options);
              assert.equal(options.defaultId, 0, 'Native confirmation must default to cancellation');
              assert.equal(options.cancelId, 0);
              assert.ok(!JSON.stringify(options).includes(key), 'Confirmation must not expose the fixture API key');
              await pause(state.delay);
              return { response: state.response };
            },
            showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(caseHome, 'project')] }),
          } });
          win.webContents.on('preload-error', (_, file, error) => errors.push(`${file}: ${error.message}`));
          const execute = source => win.webContents.executeJavaScript(source, true);
          const wait = async (source, label) => {
            for (let i = 0; i < 100; i++) { if (await execute(source)) return; await pause(50); }
            throw new Error(`Timed out: ${label}`);
          };
          const click = async (selector, disabled = false) => {
            await execute(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing click target'); el.scrollIntoView({block:'center',behavior:'instant'}); })()`);
            await pause(100);
            const point = await execute(`(() => {
              const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect();
              const x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x,y);
              if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden' || el.hidden || (!${disabled} && el.disabled) || x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || !(hit === el || el.contains(hit))) return null;
              return { x: Math.round(x), y: Math.round(y) };
            })()`);
            check(point, `Mouse target reachable: ${mode}/${width}/${selector}`);
            win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
            win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
            await pause(250);
          };
          const open = async tool => {
            await execute('app.generateClaudeConfig(1); void 0');
            await wait("document.getElementById('configToolSelectModal').hasAttribute('open')", 'tool selector');
            await pause(250);
            await click(`#configToolSelectModal button[onclick="app.generateToolConfig('${tool}')"]`);
            await wait("document.getElementById('configOutputModal').hasAttribute('open')", `output ${tool}`);
            await pause(250);
            check(await execute("document.getElementById('configOutputContent').value.length > 0"), 'Real generator produces manual content');
            check(await execute(`(() => {const r=document.getElementById('configOutputModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect();return r.left>=-1 && r.right<=innerWidth+1;})()`), `Dialog fits ${width}px`);
          };
          const close = async () => {
            await click('#configOutputModal .modal-close');
            await wait("!document.getElementById('configOutputModal').hasAttribute('open')", 'close');
            await wait("app._desktopClientConfig === null && document.getElementById('configOutputContent').value === ''", 'Closing clears sensitive state');
            check(true, 'Closing clears sensitive state');
          };
          const copy = async selector => {
            const expected = await execute("document.getElementById('configOutputContent').value");
            clipboard.writeText('clipboard-before-fixture');
            await click(selector);
            for (let i = 0; i < 30 && clipboard.readText() !== expected; i++) await pause(50);
            check(clipboard.readText() === expected, 'Mouse copy writes generated content to clipboard');
          };
          console.log(`START client config flow: ${mode}, ${width}px`);
          await Promise.race([win.loadURL(`${base}/console?mode=${mode}#apiKeys`), pause(15000).then(() => { throw new Error('Console navigation timed out'); })]);
          await wait("typeof app !== 'undefined' && !!app.user && !!window.CrewRouterClientConfig && !!customElements.get('blora-dialog')", 'real console boot');
          check(await execute(`innerWidth === ${width}`), 'Requested viewport is exact');
          check(await execute(mode === 'browser' ? '!window.crewrouterDesktop' : '!!window.crewrouterDesktop'), 'Bridge presence matches scenario');
          for (const tool of [...tools, 'deepseek']) {
            const desktopFlow = ['local', 'remote'].includes(mode) && tool !== 'deepseek';
            let target;
            let before;
            if (desktopFlow) {
              target = state.service.getClientConfigTarget(tool).path;
              check(target.startsWith(caseHome + path.sep), 'Target is inside temporary home');
              fs.mkdirSync(path.dirname(target), { recursive: true });
              before = seeded(tool);
              fs.writeFileSync(target, before);
            }
            await open(tool);
            check(await execute(`document.getElementById('desktopConfigWrite').hidden === ${!desktopFlow} && document.getElementById('desktopConfigWriteButton').hidden === ${!desktopFlow} && document.getElementById('configManualDetails').open === ${!desktopFlow}`), 'Desktop/manual fallback state');
            if (!desktopFlow) {
              await copy('#configCopyButton');
              check(state.calls.length === 0 || tool === 'deepseek', 'Manual fallback does not call write bridge');
            } else {
              check(await execute(`document.getElementById('desktopConfigPath').textContent === ${JSON.stringify(target)}`), 'Target path shown');
              await click('#configManualSummary');
              check(await execute("document.getElementById('configManualDetails').open"), 'Manual configuration expands by mouse');
              await copy('#configManualCopy');
              await click('#configManualSummary');
              check(await execute("!document.getElementById('configManualDetails').open"), 'Manual configuration collapses by mouse');
              const calls = state.calls.length;
              if (tool === 'claude') {
                state.response = 0;
                await click('#desktopConfigWriteButton');
                await wait("!app._desktopConfigBusy", 'canceled write');
                check(fs.readFileSync(target, 'utf8') === before, 'Cancellation preserves original bytes');
                check(fs.readdirSync(path.dirname(target)).length === 1, 'Cancellation creates no backup or temporary files');
                check(await execute("document.getElementById('desktopConfigStatus').textContent.includes('取消')"), 'Cancellation shown');
                state.response = 1;
                fs.writeFileSync(target, '{malformed fixture');
                await click('#desktopConfigWriteButton');
                await wait("!app._desktopConfigBusy", 'failed write');
                check(fs.readFileSync(target, 'utf8') === '{malformed fixture', 'Real parser failure preserves bytes');
                check(await execute("document.getElementById('desktopConfigStatus').textContent.includes('失败') && !document.getElementById('desktopConfigWriteButton').disabled"), 'Failure shown and retry enabled');
                fs.writeFileSync(target, before);
                state.delay = 900;
              }
              const successfulCall = state.calls.length;
              await click('#desktopConfigWriteButton');
              if (tool === 'claude') {
                check(await execute("document.getElementById('desktopConfigWriteButton').disabled && app._desktopConfigBusy"), 'Write locks while confirmation is pending');
                await click('#desktopConfigWriteButton', true);
                check(state.calls.length === successfulCall + 1, 'Repeated mouse submission makes one bridge call');
              }
              await wait("!app._desktopConfigBusy", 'successful write');
              state.delay = 0;
              const result = state.results.at(-1);
              check(result && !result.canceled && result.path === target, `Real write succeeds: ${tool}; failures=${state.failures.join('; ')}`);
              check(result.backupPath.startsWith(caseHome + path.sep) && fs.readFileSync(result.backupPath, 'utf8') === before, 'Backup preserves exact original bytes');
              const config = readConfig(tool, target);
              if (tool === 'codex' || tool === 'grok') check(fs.readFileSync(target, 'utf8').includes('# Keep existing comment') && fs.readFileSync(target, 'utf8').includes('# inline comment') && config.hooks.start[0].command === 'echo fixture', 'TOML comments and hook array tables preserved');
              check(config.sentinel === 'keep-existing' && config.permissions.policy === 'ask', 'Existing settings and permissions preserved');
              check(fs.readFileSync(target, 'utf8').includes(key) && fs.readFileSync(target, 'utf8').includes(mode === 'remote' ? 'https://remote.fixture.invalid' : base), 'Real configuration contains local/remote fixture endpoint and key');
              check(await execute(`document.getElementById('desktopConfigStatus').textContent.includes(${JSON.stringify(target)}) && document.getElementById('desktopConfigStatus').textContent.includes(${JSON.stringify(result.backupPath)})`), 'Success displays path and backup');
              check(state.calls.length === calls + (tool === 'claude' ? 3 : 1), 'Expected cancellation/failure/success call count');
            }
            await close();
          }
          await open('claude');
          check(await execute("document.getElementById('desktopConfigStatus').textContent === '' && !document.getElementById('desktopConfigWriteButton').disabled"), 'Reopening resets feedback and submit state');
          await close();
          if (['local', 'remote'].includes(mode)) {
            await open('opencode');
            await click('#desktopConfigProject');
            await click('#desktopConfigWriteButton');
            await wait("!app._desktopConfigBusy", 'project write');
            const result = state.results.at(-1);
            check(result.path === path.join(caseHome, 'project/opencode.json') && fs.existsSync(result.path), 'Project checkbox writes real selected project configuration');
            check(result.backupPath === null, 'First project write needs no backup');
            await close();
          }
          check(errors.length === 0, `No preload errors: ${errors.join('; ')}`);
          console.log(`PASS client config flow: ${mode}, ${width}px`);
          win.destroy();
          windows.delete(win);
        }
      }
      console.log(`PASS: ${checks} assertions; browser/legacy/local/remote, seven real writers, unsupported fallback, cancel/failure/repeated clicks, backup, copy, collapse, close/reopen, project, 375/1280px.`);
    } finally {
      ipcMain.removeHandler(channel);
      clipboard.writeText(originalClipboard);
      for (const win of windows) if (!win.isDestroyed()) win.destroy();
      session.defaultSession.webRequest.onBeforeRequest(null);
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
  }
  app.whenReady().then(run).then(() => app.exit(0)).catch(async error => {
    console.error(error.stack || error);
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    if (server) { server.closeAllConnections(); server.close(); }
    app.exit(1);
  });
}
