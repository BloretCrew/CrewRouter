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
new vm.Script(playgroundJs, { filename: 'public/js/playground.js' });
new vm.Script(appJs, { filename: 'public/js/app.js' });
console.log('Blora public Batch C static and executable boundary checks passed.');
