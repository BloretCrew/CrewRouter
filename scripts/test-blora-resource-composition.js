'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const elements = new Map();
const context = {
  console, URL, URLSearchParams, Date, Number,
  window: { crewrouterIcons: { name: name => ({
    'chevron.down': 'chevron-down', 'star.fill': 'star',
    'line.3.horizontal': 'grip', 'dot.radiowaves.left.and.right': 'radio',
  }[name] || name) } },
  document: { getElementById: id => elements.get(id), querySelectorAll: () => [] },
  t: value => value,
  renderProviderNameTag: name => name || '',
  setHTML: (element, html) => { element.html = html; },
  localStorage: { getItem: () => null },
};
vm.createContext(context);
const initialization = source.indexOf('const app = new ConsoleApp();');
assert.ok(initialization > 0, 'production ConsoleApp initialization boundary');
vm.runInContext(source.slice(0, initialization) + '\nglobalThis.App = ConsoleApp;', context);
const app = Object.create(context.App.prototype);
app.user = { id: 1 };
app._libraryKeys = [{ id: 1 }];
app._renderModelUptimeSlot = () => '';
app._renderLibraryMoveControls = () => '';
for (const [input, output] of [
  [99999724.725314, '99,999,724.73'], [100000000, '100,000,000'],
  [0.000012345678, '0.0000123'], [0.12345678, '0.123'],
  [0, '0'], [null, '—'], ['oops', '—'],
]) assert.equal(context.formatQuotaNumber(input), output);
assert.equal(context.formatQuotaPercent(63.50201769), '63.5');
assert.equal(context.formatQuotaPercent(71.69949762704881), '71.7');
elements.set('providerQuotaSection', { style: {} });
elements.set('providerQuotaGrid', {});
elements.set('modelLibraryContent', {});
const quota = [
  { name: 'Long upstream', quota: {
    total: 100000000, used: 99999724.725314, remaining: 0.000012345678,
    periods: [{ label: '每周窗口', percent: 63.50201769 }, { label: '月度额度', percent: 71.69949762704881 }],
  } },
  { name: 'Multi Key', quota: { total: 100000000, remaining: 99999724.725314 }, keys: [
    { ok: true, index: 0, quota: { total: 100000000, remaining: 99999724.725314, used: 275.274686 } },
    { ok: false, index: 1, error: 'failed' },
  ] },
];
const before = JSON.stringify(quota);
app.renderProviderQuota(quota);
assert.equal(JSON.stringify(quota), before);
const quotaHtml = elements.get('providerQuotaGrid').html;
assert.match(quotaHtml, /63\.5%/);
assert.match(quotaHtml, /71\.7%/);
assert.match(quotaHtml, /99,999,724\.73/);
assert.match(quotaHtml, /value="63\.50201769"/);
assert.doesNotMatch(quotaHtml, />已用 63\.50201769%/);
assert.match(quotaHtml, /Multi Key/);
assert.match(quotaHtml, /failed/);
const team = { team_id: 't1', team_name: 'Team', providers: [
  { provider_id: 'p1', provider_name: 'Provider', provider_enabled: false, is_hidden: true, model_count: 3 },
] };
app.renderModelLibrary({ teams: [team] }, null);
const libraryHtml = elements.get('modelLibraryContent').html;
assert.match(libraryHtml, /class="[^"]*\bblora-list\b[^"]*"/);
assert.match(libraryHtml, /class="[^"]*\bmodel-library-team-content\b[^"]*"/);
assert.match(libraryHtml, /role="listitem"/);
assert.match(libraryHtml, /toggleProvider\(0, 0\)/);
assert.match(libraryHtml, /provider-disabled/);
assert.match(libraryHtml, /已隐藏/);
const model = { id: 'm1', name: 'Long Model', provider_id: 'p1', provider_name: 'Provider', model_multiplier: 1.5 };
const item = app._renderModelLibraryItem(model, team, { id: 'm1' }, false);
assert.match(item, /已绑定/);
assert.match(item, /app.selectModel\('m1'\)/);
const cardTag = item.match(/<div\b[^>]*class="([^"]*\bmodel-library-item\b[^"]*)"[^>]*>/);
assert.ok(cardTag, 'model resource Card exists');
const cardClasses = new Set(cardTag[1].split(/\s+/));
assert.ok(cardClasses.has('blora-card'));
assert.ok(!cardClasses.has('blora-button'), 'resource container is not an interactive Button');
app.renderApiKeyTags = () => '';
const key = {
  id: 7, name: 'Tools', key_value: 'sk-test-not-a-real-secret', created_at: '2026-10-01',
  key_type: 'normal', total_cost: 0.000012345678, is_owner: false, is_co_key: true,
  owner: { username: 'Alice' },
};
const keyHtml = app._renderApiKeyCard(key);
assert.match(keyHtml, /<blora-copy\b(?=[^>]*\btext="sk-test-not-a-real-secret")(?=[^>]*\bmasked(?:\s|>))[^>]*>/);
assert.match(keyHtml, /app.leaveCoKey\(7\)/);
assert.doesNotMatch(keyHtml, /app.deleteApiKey\(7\)/);
assert.match(keyHtml, /app.showKeyModels\(7\)/);
console.log('Production VM resource composition: quota formats/precision, immutable data, multi-Key/error, model actions/state, masked Copy and Co-Key permissions passed.');
