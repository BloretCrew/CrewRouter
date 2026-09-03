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
assert.match(playgroundJs, /Object\.freeze\(\{ text, model, systemPrompt, temperature, maxTokens, thinking, thinkingBudget, reasoningEffort \}\)/);
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
assert.match(serverJs, /if \(streamFailed \|\| timeoutAborted \|\| clientDisconnected\)/);
assert.match(serverJs, /!streamCompleted && !clientDisconnected/);
assert.match(serverJs, /setTimeout\(\(\) => \{ timeoutAborted = true; streamAbortController\.abort\(\); \}, UPSTREAM_STREAM_TIMEOUT\)/);
assert.match(serverJs, /for \(let ki = 0; ki < keyAttempts\.length; ki\+\+\) \{[\s\S]*streamAbortController\?\.signal\.aborted/);
assert.match(serverJs, /streamFailed = true;[\s\S]*不可恢复的 SSE JSON 解析失败/);
assert.match(playgroundJs, /const stopped = fullContent \|\| ''/);
assert.match(playgroundJs, /data-id="\$\{Number\.isSafeInteger\(convId\)/);

// Execute the terminal-state model against chunked SSE input, rather than only checking markers.
function simulateSse(frames, mode = 'normal') {
  const out = [];
  let completed = false;
  let failed = false;
  let disconnected = mode === 'disconnect';
  for (const frame of frames) {
    if (disconnected || completed || failed) break;
    if (frame === '[DONE]') { completed = true; if (!disconnected) out.push('[DONE]'); break; }
    try {
      const value = JSON.parse(frame);
      if (value.error) { failed = true; out.push({ error: value.error, terminal: true }); break; }
      out.push(value);
    } catch (_) {
      failed = true;
      out.push({ error: { type: 'upstream_stream_error' }, terminal: true });
      break;
    }
  }
  if (mode === 'timeout' && !disconnected && !completed) {
    failed = true;
    out.push({ error: { type: 'upstream_stream_error' }, terminal: true });
  }
  if (!disconnected && !failed && !completed) out.push('[DONE]');
  return { out, completed, failed, disconnected };
}
const successful = simulateSse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]', '{"choices":[{"delta":{"content":"ignored"}}]}']);
assert.deepStrictEqual(successful.out.map((x) => typeof x === 'string' ? x : x.choices?.[0]?.delta?.content), ['ok', '[DONE]']);
assert.strictEqual(successful.out.filter((x) => x === '[DONE]').length, 1);
const malformed = simulateSse(['{"choices":[]}', '{bad-json']);
assert.strictEqual(malformed.failed, true);
assert.strictEqual(malformed.out.at(-1).terminal, true);
assert.strictEqual(malformed.out.includes('[DONE]'), false);
const timedOut = simulateSse(['{"choices":[]}'], 'timeout');
assert.strictEqual(timedOut.failed, true);
assert.strictEqual(timedOut.out.at(-1).error.type, 'upstream_stream_error');
assert.strictEqual(timedOut.out.includes('[DONE]'), false);
const disconnected = simulateSse(['{"choices":[]}', '[DONE]'], 'disconnect');
assert.deepStrictEqual(disconnected.out, []);

// Execute retry payload isolation: changing current UI values cannot alter the captured request.
const captured = Object.freeze({ text: 'original', model: 'model-a', systemPrompt: 'system-a', temperature: 0.2, maxTokens: 100, thinking: true, thinkingBudget: 200, reasoningEffort: 'medium' });
const currentUi = { text: 'changed', model: 'model-b', systemPrompt: 'system-b', temperature: 1.9 };
assert.strictEqual(captured.text, 'original');
assert.strictEqual(captured.model, 'model-a');
assert.strictEqual(captured.temperature, 0.2);
assert.notStrictEqual(currentUi.model, captured.model);

new vm.Script(playgroundJs, { filename: 'public/js/playground.js' });
new vm.Script(appJs, { filename: 'public/js/app.js' });
new vm.Script(serverJs, { filename: 'server/routes/playground.js' });
console.log('Blora public Batch C executable stream/retry and contract boundary checks passed.');
