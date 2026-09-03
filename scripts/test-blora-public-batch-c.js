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

for (const [name, html] of [['playground', playground], ['console', consolePage]]) {
  assert.match(html, /\/blora\/blora\.css\?v=2\.0\.8/);
  assert.match(html, /\/blora\/tokens\.dark\.css\?v=2\.0\.8/);
  assert.match(html, /\/blora\/auto\.js\?v=2\.0\.8/);
  assert.doesNotMatch(html, /--blora-[\w-]+\s*:/);
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
const serverJs = read('server/routes/playground.js');
assert.match(serverJs, /streamAbortController\?\.abort\(\)/);
assert.match(serverJs, /reader\.cancel\(\)/);
assert.match(serverJs, /streamFailed/);
assert.match(serverJs, /upstream_stream_error/);
assert.match(serverJs, /if \(streamFailed \|\| clientDisconnected\)/);
assert.match(serverJs, /const streamAbortController = isStream \? new AbortController\(\) : null/);
assert.match(serverJs, /setTimeout\(\(\) => streamAbortController\.abort\(\), UPSTREAM_STREAM_TIMEOUT\)/);
assert.match(serverJs, /streamFailed = true;[\s\S]*不可恢复的 SSE JSON 解析失败/);
assert.match(serverJs, /upstream_stream_error/);
assert.match(playgroundJs, /const stopped = fullContent \|\| ''/);
assert.match(playgroundJs, /pg-stream-status/);
assert.match(playgroundJs, /data-id=\"\$\{Number\.isSafeInteger\(convId\)/);
new vm.Script(playgroundJs, { filename: 'public/js/playground.js' });
new vm.Script(appJs, { filename: 'public/js/app.js' });
console.log('Blora public Batch C static and executable boundary checks passed.');
