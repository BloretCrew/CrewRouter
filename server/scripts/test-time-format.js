'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'time-format.js'), 'utf8');

class FakeElement {}
const document = {
  readyState: 'complete',
  documentElement: { lang: 'zh' },
  head: { appendChild() {} },
  body: { appendChild() {}, prepend() {} },
  getElementById() { return null; },
  createElement() {
    return {
      style: {}, dataset: {}, textContent: '', innerHTML: '',
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, appendChild() {}, remove() {},
    };
  },
  addEventListener() {},
  querySelectorAll() { return []; },
};
const sandbox = {
  window: null,
  document,
  Intl,
  Date,
  console,
  setTimeout,
  clearTimeout,
  Element: FakeElement,
  MutationObserver: undefined,
  addEventListener() {},
};
sandbox.window = sandbox;
sandbox.I18N = { lang: 'zh', t: key => key };
vm.runInNewContext(code, sandbox);

const CRTime = sandbox.CRTime;
assert.ok(CRTime, 'CRTime should be exposed');

const iso = '2026-11-12T00:00:00Z';
const utc = CRTime.formatTime(iso, { timeZone: 'UTC', seconds: true, locale: 'en-US' });
const shanghai = CRTime.formatTime(iso, { timeZone: 'Asia/Shanghai', seconds: true, locale: 'en-US' });
const newYork = CRTime.formatTime(iso, { timeZone: 'America/New_York', seconds: true, locale: 'en-US' });
assert.ok(utc.includes('00:00:00'), `UTC: ${utc}`);
assert.ok(shanghai.includes('08:00:00'), `Shanghai: ${shanghai}`);
assert.ok(newYork.includes('19:00:00'), `New York: ${newYork}`);
console.log('ok - formats the same instant in multiple zones');

const zones = CRTime.formatZones(iso);
assert.strictEqual(zones.length, 5);
assert.strictEqual(zones[1].key, 'UTC');
assert.ok(zones.every(zone => zone.value));
console.log('ok - formatZones returns five zones');

const html = CRTime.formatTimeHtml(iso, { locale: 'en-US' });
assert.ok(html.includes('data-cr-time="2026-11-12T00:00:00.000Z"'));
assert.ok(html.includes('<time'));
console.log('ok - formatTimeHtml emits time element');

assert.strictEqual(CRTime.formatTime(null), '-');
assert.strictEqual(CRTime.formatTime('not-a-date'), '-');
console.log('ok - invalid values fall back');

const relative = CRTime.formatRelative(new Date(Date.now() + 60_000).toISOString());
assert.ok(relative.length > 0);
console.log('ok - relative formatting works');

console.log('all time-format tests passed');
