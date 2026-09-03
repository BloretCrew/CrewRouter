'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { scanHtml } = require('./blora-audit-parser');

const fixture = '<form data-x="a > b"><label title="x > y">Name</label><input class="input" required><button type="submit">Go</button><select><option>One</option></select><textarea></textarea></form>';
assert.deepStrictEqual(scanHtml(fixture), { controls: 4, nativeDialogs: 0, forms: 1, tables: 0, states: 0, legacyModalContainers: 0 });
assert.strictEqual(scanHtml('<dialog open><form><input aria-label="status"></form></dialog>').nativeDialogs, 1);
for (const name of ['admin.html', 'console.html', 'setup.html', 'oauth-consent.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/pages', name), 'utf8');
  const counts = scanHtml(html);
  assert.ok(counts.controls > 0, `${name} should contain static controls`);
  assert.ok(counts.forms >= 0);
}
console.log('Blora audit parser regression checks passed.');
