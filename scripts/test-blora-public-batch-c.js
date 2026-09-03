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
  assert.match(html, /\/blora\/blora\.css\?v=2\.0\.8/);
  assert.match(html, /\/blora\/tokens\.dark\.css\?v=2\.0\.8/);
  assert.match(html, /\/blora\/auto\.js\?v=2\.0\.8/);
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
assert.match(appJs, /<button type="button" class="model-library-item"/);
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
assert.match(serverJs, /upstream_stream_error/);
assert.match(serverJs, /shouldRecordPlaygroundUsage/);
assert.match(serverJs, /if \(!shouldRecordPlaygroundUsage/);
assert.strictEqual(streamState.shouldRecordPlaygroundUsage({ streamCompleted: true, clientDisconnected: false, timeoutAborted: false, streamFailed: false }), true);
for (const failure of [
  { streamCompleted: false, clientDisconnected: false, timeoutAborted: false, streamFailed: true },
  { streamCompleted: false, clientDisconnected: false, timeoutAborted: true, streamFailed: false },
  { streamCompleted: false, clientDisconnected: true, timeoutAborted: false, streamFailed: false },
  { streamCompleted: false, clientDisconnected: false, timeoutAborted: false, streamFailed: false }
]) assert.strictEqual(streamState.shouldRecordPlaygroundUsage(failure), false);
assert.match(serverJs, /shouldRecordPlaygroundUsage/);
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
  for (const frame of frames) {
    const result = streamState.consumePlaygroundSseFrame(state, frame);
    if (result.kind === 'ignore') break;
    out.push(result);
    if (result.kind === 'done' || result.kind === 'error') break;
  }
  const terminal = streamState.finalizePlaygroundStream(state);
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
assert.deepStrictEqual(disconnected.out, []);

// Execute the production retry payload helper; UI changes must not mutate it.
const originalMessages = [{ role: 'user', content: 'original' }];
const captured = playgroundState.buildRetryPayload({ text: 'original', model: 'model-a', systemPrompt: 'system-a', temperature: 0.2, maxTokens: 100, thinking: true, thinkingBudget: 200, reasoningEffort: 'medium', apiMessages: originalMessages });
originalMessages[0].content = 'changed';
assert.strictEqual(captured.text, 'original');
assert.strictEqual(captured.model, 'model-a');
assert.strictEqual(captured.temperature, 0.2);
assert.strictEqual(captured.apiMessages[0].content, 'original');
assert.strictEqual(playgroundState.shouldRollback('failed'), true);
assert.strictEqual(playgroundState.shouldRollback('completed'), false);

new vm.Script(playgroundJs, { filename: 'public/js/playground.js' });
new vm.Script(appJs, { filename: 'public/js/app.js' });
new vm.Script(serverJs, { filename: 'server/routes/playground.js' });
console.log('Blora public Batch C executable stream/retry and contract boundary checks passed.');
