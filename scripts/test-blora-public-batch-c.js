'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const playground = read('public/pages/playground.html');
const consolePage = read('public/pages/console.html');
const playgroundJs = read('public/js/playground.js');
const appJs = read('public/js/app.js');
const serverJs = read('server/routes/playground.js');
const streamState = require(path.join(root, 'server/utils/playground-stream-state'));
const playgroundState = require(path.join(root, 'public/js/playground-state.js'));

for (const [name, html] of [['playground', playground], ['console', consolePage]]) {
  assert.match(html, /\/blora\/blora\.css\?v=2\.1\.0/);
  assert.match(html, /\/blora\/tokens\.dark\.css\?v=2\.1\.0/);
  assert.match(html, /\/blora\/auto\.js\?v=2\.1\.0/);
  assert.doesNotMatch(html, /--blora-[\w-]+\s*:/, `${name}: custom Blora tokens are forbidden`);
}
assert.match(playground, /<blora-select\b[^>]*id="pgModel"/);
assert.match(playground, /<blora-select\b[^>]*id="pgReasoningEffort"[\s\S]*<blora-option/);
assert.match(playground, /<blora-dialog\b[^>]*id="pgHistoryModal"/);
assert.match(playground, /data-variant="danger"/);
assert.match(consolePage, /<blora-select\b[^>]*id="sessionDaysFilter"[\s\S]*<blora-option/);
assert.match(consolePage, /<blora-select\b[^>]*id="sessionSourceFilter"[\s\S]*<blora-option/);
assert.match(appJs, /setBloraState\('sessionsList', 'loading'\)/);
assert.match(appJs, /setBloraState\('sessionsList', 'error'\)/);
const cardContract = require(path.join(root, 'node_modules/@bloret-crew/blora-design/contracts/card.contract.json'));
assert.ok(cardContract.classes['blora-card']);
assert.match(appJs, /<div class="blora-card model-library-item/);
assert.match(playgroundJs, /PlaygroundState\.buildRetryPayload/);
assert.doesNotMatch(playgroundJs, /<option\b/);
assert.doesNotMatch(playgroundJs, /src="\$\{modelInfo\./);
assert.match(playgroundJs, /select\.value = String\(this\.models\[0\]/);
assert.match(playgroundJs, /selectedOptions\[0\]\?\.label/);
assert.match(playgroundJs, /safeAvatarHtml/);
assert.match(playgroundJs, /<p class="pg-stream-status">/);
assert.match(appJs, /<blora-select id="fusionJudgeSelect"/);
assert.match(appJs, /<blora-option value=/);
assert.match(appJs, /judgeSelect\.value = String\(currentJudge \|\| models\[0\]/);
assert.match(appJs, /outerSelect\.value = String\(currentOuter \|\| models\[0\]/);
assert.doesNotMatch(appJs, /fusionJudgeSelect[\s\S]{0,300}selected/);
assert.match(playgroundJs, /STREAM_TERMINAL_ERROR/);
assert.match(playgroundJs, /pg-retry-btn/);
assert.match(playgroundJs, /Object\.freeze\(\{ text, model, systemPrompt, temperature, maxTokens, thinking, thinkingBudget, reasoningEffort, apiMessages:/);
assert.match(playgroundJs, /this\.send\(retryPayload\)/);
assert.match(playgroundJs, /previousMessages = this\.messages\.slice\(\)/);
assert.match(playgroundJs, /rollbackRequest\(\)/);
assert.match(playgroundJs, /this\.escapeHtml\(params\.temperature\)/);
assert.match(playgroundJs, /this\.escapeHtml\(params\.max_tokens\)/);
assert.match(playgroundJs, /this\.escapeHtml\(params\.top_p\)/);
assert.match(serverJs, /streamAbortController\?\.abort\(\)/);
assert.match(serverJs, /reader\.cancel\(\)/);
assert.match(serverJs, /streamFailed/);
assert.match(serverJs, /timeoutAborted/);
assert.match(serverJs, /streamCompleted = true/);
assert.match(serverJs, /consumePlaygroundSseLines\([\s\S]*provider\.format/);
assert.match(streamState.consumePlaygroundSseLines ? serverJs + ' consumePlaygroundSseLines' : serverJs, /consumePlaygroundSseLines/);
assert.match(serverJs, /if \(frame\.kind === 'ignore' \|\| frame\.kind === 'event'\) continue/);
assert.match(serverJs, /recordPlaygroundUsageIfCompleted/);
const streamedResults = [];
const productionLoop = streamState.consumePlaygroundSseLines({ clientDisconnected: false, timeoutAborted: false, streamCompleted: false, streamFailed: false, pendingEvent: '' }, ['event: message_stop', 'data: {}', 'data: [DONE]'], 'anthropic', result => streamedResults.push(result));
assert.strictEqual(streamedResults.length, 2);
assert.strictEqual(productionLoop.terminal, 'completed');
assert.strictEqual(productionLoop.output[0].kind, 'event');
assert.strictEqual(productionLoop.output[1].kind, 'done');
const anthropicState = { clientDisconnected: false, timeoutAborted: false, streamCompleted: false, streamFailed: false };
const messageStop = streamState.consumePlaygroundSseLine(anthropicState, 'event: message_stop', 'anthropic');
const messageStopData = streamState.consumePlaygroundSseLine(anthropicState, 'data: {}', 'anthropic');
const routeState = { clientDisconnected: false, timeoutAborted: false, streamCompleted: false, streamFailed: false, pendingEvent: '' };
const routeEvent = streamState.consumePlaygroundSseLine(routeState, 'event: message_stop', 'anthropic');
const routeData = streamState.consumePlaygroundSseLine(routeState, 'data: {}', 'anthropic');
assert.strictEqual(routeEvent.kind, 'event');
assert.strictEqual(routeData.kind, 'done');
assert.strictEqual(streamState.finalizePlaygroundStream(routeState), 'completed');
assert.strictEqual(messageStop.kind, 'event');
assert.strictEqual(messageStopData.kind, 'done');
assert.strictEqual(anthropicState.streamCompleted, true);
assert.strictEqual(streamState.finalizePlaygroundStream(anthropicState), 'completed');
assert.strictEqual(streamState.shouldRecordPlaygroundUsage(anthropicState), true);
assert.match(serverJs, /upstream_stream_error/);
assert.match(serverJs, /recordPlaygroundUsageIfCompleted/);
assert.doesNotMatch(serverJs, /shouldRecordPlaygroundUsage\(/);
let usageCalls = 0;
const usageSpy = async () => { usageCalls += 1; };
function runUsageSpyTest() {
  return streamState.recordPlaygroundUsageIfCompleted({ streamCompleted: true, clientDisconnected: false, timeoutAborted: false, streamFailed: false }, usageSpy).then(async () => {
    assert.strictEqual(usageCalls, 1);
    for (const failure of [
      { streamCompleted: false, clientDisconnected: false, timeoutAborted: false, streamFailed: true },
      { streamCompleted: false, clientDisconnected: false, timeoutAborted: true, streamFailed: false },
      { streamCompleted: false, clientDisconnected: true, timeoutAborted: false, streamFailed: false },
      { streamCompleted: false, clientDisconnected: false, timeoutAborted: false, streamFailed: false }
    ]) await streamState.recordPlaygroundUsageIfCompleted(failure, usageSpy);
    assert.strictEqual(usageCalls, 1);
  });
}
assert.strictEqual(streamState.shouldRecordPlaygroundUsage({ streamCompleted: true, clientDisconnected: false, timeoutAborted: false, streamFailed: false }), true);
for (const failure of [
  { streamCompleted: false, clientDisconnected: false, timeoutAborted: false, streamFailed: true },
  { streamCompleted: false, clientDisconnected: false, timeoutAborted: true, streamFailed: false },
  { streamCompleted: false, clientDisconnected: true, timeoutAborted: false, streamFailed: false },
  { streamCompleted: false, clientDisconnected: false, timeoutAborted: false, streamFailed: false }
]) assert.strictEqual(streamState.shouldRecordPlaygroundUsage(failure), false);
assert.match(serverJs, /recordPlaygroundUsageIfCompleted/);
assert.doesNotMatch(serverJs, /shouldRecordPlaygroundUsage\(/);
assert.match(serverJs, /!streamCompleted && !clientDisconnected/);
assert.match(serverJs, /setTimeout\(\(\) => \{ timeoutAborted = true; streamAbortController\.abort\(\); \}, UPSTREAM_STREAM_TIMEOUT\)/);
assert.match(serverJs, /for \(let ki = 0; ki < keyAttempts\.length; ki\+\+\) \{[\s\S]*streamAbortController\?\.signal\.aborted/);
assert.match(serverJs, /streamFailed = true;[\s\S]*不可恢复的 SSE JSON 解析失败/);
assert.match(playgroundJs, /const stopped = fullContent \|\| ''/);
assert.match(playgroundJs, /data-id="\$\{Number\.isSafeInteger\(convId\)/);

// Execute the production stream state helper against chunked SSE input.
function executeSse(frames, mode = 'normal') {
  const out = [];
  const state = { clientDisconnected: mode === 'disconnect', timeoutAborted: mode === 'timeout', streamCompleted: false, streamFailed: false };
  const loop = streamState.consumePlaygroundSseLines(state, frames.map(frame => `data: ${frame}`), 'openai', result => out.push(result));
  const terminal = loop.terminal;
  if (terminal === 'completed' && !out.some((item) => item.kind === 'done')) out.push({ kind: 'done' });
  if (terminal === 'failed' && !out.some((item) => item.kind === 'error')) out.push({ kind: 'error', terminal: true });
  if (terminal === 'timeout') out.push({ kind: 'error', terminal: true });
  return { out, state, terminal };
}
const successful = executeSse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]', '{"choices":[{"delta":{"content":"ignored"}}]}']);
assert.strictEqual(successful.terminal, 'completed');
assert.strictEqual(successful.out.filter((x) => x.kind === 'done').length, 1);
const malformed = executeSse(['{"choices":[]}', '{bad-json']);
assert.strictEqual(malformed.terminal, 'failed');
assert.ok(malformed.out.some((item) => item.terminal === true));
assert.strictEqual(malformed.out.filter((x) => x.kind === 'done').length, 0);
const timedOut = executeSse(['{"choices":[]}'], 'timeout');
assert.strictEqual(timedOut.terminal, 'timeout');
assert.strictEqual(timedOut.out.filter((x) => x.kind === 'done').length, 0);
const normalEof = executeSse(['{"choices":[]}']);
assert.strictEqual(normalEof.terminal, 'failed');
const disconnected = executeSse(['{"choices":[]}', '[DONE]'], 'disconnect');
assert.strictEqual(disconnected.terminal, 'client-disconnected');
assert.strictEqual(disconnected.out.every(item => item.kind === 'ignore'), true);

// Execute the production retry payload helper; UI changes must not mutate it.
const originalMessages = [{ role: 'user', content: 'original' }];
const captured = playgroundState.buildRetryPayload({ text: 'original', model: 'model-a', systemPrompt: 'system-a', temperature: 0.2, maxTokens: 100, thinking: true, thinkingBudget: 200, reasoningEffort: 'medium', apiMessages: originalMessages });
originalMessages[0].content = 'changed';
assert.strictEqual(captured.text, 'original');
assert.strictEqual(captured.model, 'model-a');
assert.strictEqual(captured.temperature, 0.2);
assert.strictEqual(captured.apiMessages[0].content, 'original');
const retryPrepared = playgroundState.prepareRetryRequest(captured, [{ role: 'user', content: 'mutated context' }]);
assert.deepStrictEqual(retryPrepared.messages, [{ role: 'user', content: 'original' }]);
assert.deepStrictEqual(retryPrepared.apiMessages, [{ role: 'user', content: 'original' }]);
assert.strictEqual(playgroundState.shouldRollback('failed'), true);
assert.strictEqual(playgroundState.shouldRollback('completed'), false);

runUsageSpyTest().then(async () => {
new vm.Script(playgroundJs, { filename: 'public/js/playground.js' });
new vm.Script(appJs, { filename: 'public/js/app.js' });
new vm.Script(serverJs, { filename: 'server/routes/playground.js' });
console.log('Blora SSE success/error/timeout/disconnect, billing spy and immutable retry payload assertions passed.');
await verifyModelKeyboard();
console.log('Blora public Batch C executable stream/retry and contract boundary checks passed.');
}).catch((error) => { console.error(error); process.exitCode = 1; });


async function verifyModelKeyboard() {
  const os = require('os');
  const { spawn } = require('child_process');
  const source = appJs.match(/  _renderModelLibraryItem\([^]*?\n  \}/)?.[0];
  assert.ok(source, 'production Card renderer exists');
  const context = vm.createContext({
    t: value => value,
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
    safeHttpUrl: () => '', renderProviderNameTag: () => '',
  });
  const renderer = vm.runInContext(`({${source}})._renderModelLibraryItem`, context);
  const owner = { user: null, _jsString: value => String(value), _formatTestTps: () => '', _renderModelUptimeSlot: () => '', _renderLibraryMoveControls: () => '', _renderLibraryMoreMenu: () => '', _libIcon: () => '' };
  const model = { id: 'model-keyboard', name: 'Keyboard model', provider_id: 'provider-a' };
  const team = { team_id: 'team-a' };
  const enabled = renderer.call(owner, model, team, null, false);
  const disabled = renderer.call(owner, model, team, null, true);
  const picker = renderer.call(owner, model, team, null, false, { mode: 'keyPicker', onClick: "app.addToQueue('model-keyboard')" });
  const bound = renderer.call(owner, model, team, { id: model.id }, false);
  for (const markup of [enabled, disabled, picker, bound]) {
    assert.match(markup, /<div class="blora-card model-library-item/);
    assert.match(markup, /data-variant="hover"/);
    let buttonDepth = 0;
    for (const tag of markup.matchAll(/<\/?button\b[^>]*>/g)) {
      buttonDepth += tag[0].startsWith('</') ? -1 : 1;
      assert.ok(buttonDepth >= 0 && buttonDepth <= 1, 'Card must not nest buttons');
    }
    assert.strictEqual(buttonDepth, 0);
  }
  assert.match(disabled, /<button[^>]*disabled/);
  assert.match(bound, /<button[^>]*model-action-bound[^>]*disabled/);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-blora-card-'));
  const file = path.join(profile, 'card.html');
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="file://${root}/node_modules/@bloret-crew/blora-design/dist/blora.css"><script>window.selections=[];window.queue=[];window.app={selectModel:id=>selections.push(id),addToQueue:id=>queue.push(id)};</script><section id="enabled">${enabled}</section><section id="disabled">${disabled}</section><section id="picker">${picker}</section><section id="bound">${bound}</section>`);
  const browser = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let attempt = 0; !fs.existsSync(portFile) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(portFile), 'headless browser must start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id) { const entry = pending.get(message.id); if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); } } };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true }); assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value; };
    await send('Page.enable');
    await send('Page.navigate', { url: `file://${file}` });
    await send('Page.bringToFront');
    for (let attempt = 0; attempt < 100 && !await evaluate('!!document.querySelector("#enabled .model-action-primary")'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    const activate = async (selector, key, code, keyCode) => {
      assert.strictEqual(await evaluate(`(() => { const button=document.querySelector(${JSON.stringify(selector)}); if(!button||button.tagName!=='BUTTON'||button.disabled) return false; button.focus(); return document.activeElement===button; })()`), true, 'selection must have a focusable native action');
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text: key === 'Enter' ? '\r' : ' ', unmodifiedText: key === 'Enter' ? '\r' : ' ' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    };
    await activate('#enabled .model-action-primary', 'Enter', 'Enter', 13);
    assert.deepStrictEqual(await evaluate('selections'), ['model-keyboard']);
    await activate('#enabled .model-action-primary', ' ', 'Space', 32);
    assert.deepStrictEqual(await evaluate('selections'), ['model-keyboard', 'model-keyboard']);
    await activate('#picker .model-action-primary', 'Enter', 'Enter', 13);
    assert.deepStrictEqual(await evaluate('queue'), ['model-keyboard']);
    await evaluate('document.querySelector("#disabled .model-action-disabled").click()');
    assert.strictEqual(await evaluate('selections.length'), 2, 'disabled Card must not select a model');
    await activate('#enabled .model-library-select', 'Enter', 'Enter', 13);
    assert.strictEqual(await evaluate('selections.length'), 3, 'Card title action must select exactly once');
    await evaluate('document.querySelector("#bound .model-action-bound").click()');
    assert.strictEqual(await evaluate('selections.length'), 3, 'already-bound action must not select again');
    console.log('Production Card: Enter/Space select actual model, picker queues model, disabled selection blocked.');
  } finally {
    socket?.close();
    if (browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGTERM'); await exited; }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
