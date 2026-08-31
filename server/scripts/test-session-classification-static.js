'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const api = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
const events = fs.readFileSync(path.join(__dirname, '../routes/client-events.js'), 'utf8');
const sessions = fs.readFileSync(path.join(__dirname, '../routes/sessions-view.js'), 'utf8');
const balance = fs.readFileSync(path.join(__dirname, '../utils/balance.js'), 'utf8');

assert.ok(api.includes('usageRecordId: req._usageRecordId || null'));
assert.ok(api.includes('session_identity: identity'));
assert.ok(events.includes('logical_session_id'));
assert.ok(events.includes('session_confidence'));
assert.ok(sessions.includes("ORDER BY agg.last_seen DESC, agg.session_key ASC"));
assert.ok(sessions.includes("'unknown-v2:'"));
assert.ok(balance.includes('id: inserted.rows[0]?.id || null'));
console.log('Session classification static contracts passed.');
