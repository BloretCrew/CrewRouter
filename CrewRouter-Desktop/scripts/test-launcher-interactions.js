'use strict';

// 在真实 Electron 渲染器中隔离 IPC，避免验收修改用户连接或启动本地服务。
if (process.type === 'renderer') {
  let listener;
  const settings = { autoConnect: true, notifications: true, updateChecks: true, theme: 'dark', language: 'zh' };
  const status = { mode: 'welcome', theme: 'dark', language: 'zh', localServer: {} };
  let profiles = [{ id: 'remote', mode: 'remote', name: '长连接名称'.repeat(12), url: `https://example.com/${'path/'.repeat(30)}` }];
  window.launcherTest = { calls: 0, emit: (next) => { Object.assign(status, next); listener(status); } };
  window.crewrouterDesktop = {
    onStatus: (callback) => { listener = callback; },
    getStatus: async () => status,
    listProfiles: async () => profiles,
    getDesktopSettings: async () => ({ settings, profiles }),
    getDiagnostics: async () => ({ version: 'test' }),
    connectCustomRemote: async () => { window.launcherTest.calls++; await new Promise((resolve) => setTimeout(resolve, 150)); throw new Error('测试连接失败'); },
    startLocal: async () => { window.launcherTest.calls++; },
    openOfficialLogin: async () => window.launcherTest.emit({ mode: 'awaiting-official-login' }),
    cancelPending: async () => window.launcherTest.emit({ mode: 'welcome' }),
    clearError: async () => window.launcherTest.emit({ mode: 'welcome' }),
    retry: async () => window.launcherTest.emit({ mode: 'connecting' }),
    renameProfile: async (id, name) => { profiles = profiles.map((profile) => profile.id === id ? { ...profile, name } : profile); return profiles; },
    deleteProfile: async (id) => { profiles = profiles.filter((profile) => profile.id !== id); return profiles; },
    saveDesktopSettings: async (patch) => { Object.assign(settings, patch); window.launcherTest.emit({ theme: settings.theme, language: settings.language }); return settings; },
  };
} else {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const { app, BrowserWindow } = require('electron');
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 960, height: 700, show: true, webPreferences: { preload: __filename, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', (_, level, message) => { if (level === 3) errors.push(message); });
    const execute = (source) => win.webContents.executeJavaScript(source, true);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
    const midFade = (id) => execute(`new Promise((resolve) => {
      const start = performance.now();
      const sample = () => {
        const dialog = document.getElementById('${id}');
        const opacity = Number(getComputedStyle(dialog).opacity);
        if ((opacity > 0 && opacity < 1) || performance.now() - start > 1500) resolve({opacity, visible: dialog.matches(':popover-open'), open: dialog.hasAttribute('open')});
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })`);
    const click = async (id) => { await execute(`document.getElementById('${id}').click(); void 0`); await pause(); };
    const view = () => execute("document.getElementById('launcher').dataset.view");
    const checkIcons = async () => {
      const issues = await execute(`Array.from(document.querySelectorAll('.launcher__profile-icon, .launcher__choice-icon, .button-icon, .launcher__choice-arrow')).flatMap((host) => {
        const svg = host.querySelector('svg');
        if (!svg || !host.getBoundingClientRect().width) return [];
        const box = host.getBoundingClientRect(), icon = svg.getBoundingClientRect();
        const style = getComputedStyle(host);
        const centerX = box.left + (box.width + parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / 2;
        const centerY = box.top + (box.height + parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / 2;
        const centered = Math.abs(icon.left + icon.width / 2 - centerX) < 1 && Math.abs(icon.top + icon.height / 2 - centerY) < 1;
        const sized = !host.classList.contains('launcher__choice-icon') || (icon.width === 20 && icon.height === 20);
        return centered && sized ? [] : [host.className];
      })`);
      assert.deepEqual(issues, [], '图标应在容器内居中，连接选项图标应为 20px');
    };
    const escape = async () => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await pause(); };
    try {
      await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
      await pause();
      assert.equal(await view(), 'welcome');
      assert.equal(await execute("document.querySelector('.launcher__footer, #app-version, [data-i18n=\"footer.note\"]') === null"), true);
      for (const width of [960, 375]) {
        win.setSize(width, 700); await pause();
        assert.equal(await execute('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `连接列表溢出：${width}`);
        await checkIcons();
        await execute("document.querySelector('#profile-list blora-dropdown button').scrollIntoView({block:'center'}); document.querySelector('#profile-list blora-dropdown button').click(); void 0"); await pause();
        assert.equal(await execute(`(() => {
          const menu = document.querySelector('#profile-list .blora-dropdown__menu');
          const box = menu.getBoundingClientRect();
          return [0.25, 0.75].every((part) => {
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height * part);
            return hit && menu.contains(hit);
          });
        })()`), true, `菜单应覆盖下方内容并可点击：${width}`);
        await execute("document.querySelector('#profile-list blora-dropdown button').click(); void 0"); await pause();
        await click('choose-remote');
        await checkIcons();
        await escape();
        assert.equal(await view(), 'welcome');
      }
      for (const width of [960, 375]) {
        win.setSize(width, 700); await pause();
        for (const id of ['confirm-dialog', 'rename-dialog']) {
          for (const closeBy of ['button', 'escape']) {
            await execute(`document.getElementById('${id}').show(); void 0`);
            const {opacity: opening} = await midFade(id);
            assert.ok(opening > 0 && opening < 1, `淡入：${id}/${width}，opacity=${opening}`);
            await pause();
            assert.equal(await execute(`Number(getComputedStyle(document.getElementById('${id}')).opacity)`), 1);
            if (closeBy === 'escape') win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
            else await execute(`document.getElementById('${id}').shadowRoot.querySelector('button').click(); void 0`);
            const closing = await midFade(id);
            assert.ok(closing.opacity > 0 && closing.opacity < 1 && closing.visible, `淡出：${id}/${width}/${closeBy} ${JSON.stringify(closing)}`);
            await pause();
            await pause();
            assert.equal(await execute(`getComputedStyle(document.getElementById('${id}')).display`), 'none');
          }
        }
      }
      await execute("document.querySelector('#profile-list blora-dropdown button').click(); void 0"); await pause();
      assert.equal(await execute("document.querySelector('#profile-list .blora-dropdown').hasAttribute('data-open')"), true);
      await execute("document.querySelector('#profile-list .blora-dropdown__item[data-value=rename]').click(); void 0"); await pause();
      assert.equal(await execute("document.getElementById('rename-dialog').hasAttribute('open')"), true);
      await execute("document.querySelector('#rename-field input').value = 'Renamed'; document.querySelector('#rename-field input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); void 0"); await pause();
      assert.equal(await execute("document.querySelector('#profile-list .blora-list__title span').textContent"), 'Renamed');
      await click('choose-local');
      await execute("document.getElementById('local-profile-form').requestSubmit(); void 0");
      assert.equal(await execute("document.getElementById('local-username-field').hasAttribute('error')"), true);
      await execute("const input = document.querySelector('#local-username-field input'); input.value = 'Tester'; input.dispatchEvent(new Event('input', {bubbles:true})); void 0");
      assert.equal(await execute("document.getElementById('local-username-field').hasAttribute('error')"), false);
      await escape(); assert.equal(await view(), 'welcome');
      await click('choose-remote'); await click('custom-remote');
      await execute("document.querySelector('#custom-url-field input').value = 'ftp://example.com'; document.getElementById('connection-form').requestSubmit(); void 0");
      assert.equal(await execute("document.getElementById('custom-url-field').hasAttribute('error')"), true);
      await execute("document.querySelector('#custom-url-field input').value = 'https://example.com'; document.getElementById('connection-form').requestSubmit(); document.getElementById('connection-form').requestSubmit(); void 0");
      assert.equal(await execute('window.launcherTest.calls'), 1);
      assert.equal(await execute("document.getElementById('open-settings').disabled"), true);
      await pause();
      assert.equal(await execute("document.getElementById('custom-connect').disabled"), false);
      assert.equal(await execute("document.getElementById('inline-alert').hidden"), false);
      await escape(); assert.equal(await view(), 'remote-method');
      await click('official-remote'); assert.equal(await view(), 'progress');
      await click('cancel-pending'); assert.equal(await view(), 'welcome');
      await click('open-settings');
      for (const width of [960, 375]) {
        win.setSize(width, 700); await pause();
        assert.equal(await execute('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `设置溢出：${width}`);
      }
      await execute("document.getElementById('pref-theme').setAttribute('value','light'); document.getElementById('pref-theme').dispatchEvent(new Event('change')); void 0"); await pause();
      assert.equal(await execute('document.documentElement.dataset.bloraColorScheme'), 'light');
      assert.equal(await execute("document.getElementById('preferences-message').textContent"), '偏好已保存');
      await execute("document.getElementById('pref-language').setAttribute('value','en'); document.getElementById('pref-language').dispatchEvent(new Event('change')); void 0"); await pause();
      assert.equal(await execute('document.documentElement.lang'), 'en');
      assert.equal(await execute("document.getElementById('preferences-message').textContent"), 'Preferences saved');
      await escape(); assert.equal(await view(), 'welcome');
      await execute("window.launcherTest.emit({mode:'error',error:{message:'Test failure',retry:true}}); void 0");
      assert.equal(await view(), 'error');
      await click('dismiss-error'); assert.equal(await view(), 'welcome');
      assert.deepEqual(errors, []);
      console.log('PASS: launcher interaction, IPC delay/error recovery, keyboard navigation, settings, language/theme, desktop/mobile layout');
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
}
