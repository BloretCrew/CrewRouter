'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../routes/client-events.js'), 'utf8');
const grokEvents = [
  'session_start', 'session_end', 'tool_use', 'tool_use_failure',
  'permission_denied', 'response_stop', 'response_stop_failure',
  'notification', 'subagent_start', 'subagent_stop', 'pre_compact', 'post_compact',
];
for (const event of grokEvents) assert.ok(source.includes(`'${event}'`), `missing ${event}`);
assert.ok(source.includes('HARNESS_SET.has(harness)'));
assert.ok(source.includes("Buffer.byteLength(serialized, 'utf8') <= maxBytes"));
assert.ok(source.includes("res.status(400).json({ ok: false, error: 'invalid harness' })"));
assert.ok(source.includes("res.status(400).json({ ok: false, error: 'invalid event' })"));
assert.ok(source.includes('res.json({ ok: true })'));
console.log(`All ${grokEvents.length} client-event contract assertions passed.`);
