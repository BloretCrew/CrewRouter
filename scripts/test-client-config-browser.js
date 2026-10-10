'use strict';
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class CDP {
  constructor(url) {
    this.id = 0; this.pending = new Map(); this.events = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
      } else this.events.push(message);
    };
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    assert.equal(typeof expression, 'string', 'evaluate() requires a string expression');
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + (response.exceptionDetails.exception?.description || ''));
    return response.result.value;
  }
  async click(selector) {
    const point = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || !(hit === el || el.contains(hit))) return null;
      return { x, y };
    })()`);
    if (!point) return false;
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(250);
    return true;
  }
}





async function main() {
  const debug = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18572';
  const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18571';
  const target = await fetch(`${debug}/json/new?about:blank`, {method:'PUT'}).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Browser.grantPermissions', {origin:base, permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
    for (const width of [1280, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:width===390});
      await cdp.send('Page.navigate', {url:base + '/console#apiKeys'});
      for (let i=0; i<100; i++) { if (await cdp.evaluate("typeof app!=='undefined' && !!app.user")) break; await sleep(100); }
      await cdp.evaluate(`window.__fetch = window.fetch; window.fetch = (url, options) => String(url).includes('/api-keys/') && String(url).endsWith('/config') ? Promise.resolve(new Response(JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://example.com',ANTHROPIC_AUTH_TOKEN:'fixture-key'}}),{status:200,headers:{'Content-Type':'application/json'}})) : window.__fetch(url,options); app._configKey={id:1};`);
      for (const mode of ['browser','old-desktop']) {
        await cdp.evaluate(mode==='browser' ? 'delete window.crewrouterDesktop' : 'window.crewrouterDesktop={getDesktopSettings:async()=>({})}');
        for (const tool of ['claude','codex','grok','opencode','qwen_code','hermes','openclaw','deepseek']) {
          await cdp.evaluate("app.generateClaudeConfig(1)"); await sleep(350);
          assert.ok(await cdp.click(`[onclick="app.generateToolConfig('${tool}')"]`), 'tool click ' + tool);
          await sleep(400);
          assert.ok(await cdp.evaluate(`(() => {const modal=document.getElementById('configOutputModal');const panel=modal.shadowRoot.querySelector('[part=panel]').getBoundingClientRect();return modal.hasAttribute('open') && document.getElementById('desktopConfigWriteButton').hidden && document.getElementById('configManualDetails').open && !!document.getElementById('configOutputContent').value && panel.left>=0 && panel.right<=innerWidth && panel.bottom<=innerHeight;})()`), `manual fallback ${mode}/${tool}/${width}`);
          assert.ok(await cdp.click('#configCopyButton'), 'copy configuration');
          const content = await cdp.evaluate("document.getElementById('configOutputContent').value");
          const copied = await cdp.evaluate('navigator.clipboard.readText()');
          assert.equal(copied,content);
          assert.ok(await cdp.click('#configOutputModal .modal-close'), 'close'); await sleep(400);
          assert.equal(await cdp.evaluate("document.getElementById('configOutputContent').value"),'');
        }
        console.log(`PASS browser manual client configuration ${mode} ${width}px`);
      }
      await cdp.evaluate("location.hash='modelLibrary';app.generateClaudeConfig(1)"); await sleep(350);
      assert.ok(await cdp.click(`[onclick="app.generateToolConfig('claude')"]`)); await sleep(350);
      assert.equal(await cdp.evaluate("document.getElementById('configOutputModal').hasAttribute('open')"),true);
      await cdp.click('#configOutputModal .modal-close'); await sleep(350);
    }
  } finally { cdp.ws.close(); await fetch(`${debug}/json/close/${target.id}`); }
}
main().catch(error => {console.error(error);process.exitCode=1;});
