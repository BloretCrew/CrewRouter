'use strict';
const assert = require('assert');
const { openaiAppend, anthropicAppend, responsesAppend } = require('../utils/inject-prompt');
const text = '<system-reminder>\n# claudeMd\nContents of /CrewRouter/CLAUDE.md (project instructions, configured by CrewRouter):\nx\n# currentDate\nToday\'s date is 2026-08-29.\n</system-reminder>';
for (const append of [openaiAppend, anthropicAppend]) {
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: [{ type: 'text', text: 'u' }] }];
  append(messages, text); assert.strictEqual(messages[1].isMeta, true); assert.strictEqual(messages[2].role, 'user');
  append(messages, text); assert.strictEqual(messages.filter(m => m.isMeta).length, 1);
  const existing = [{ role: 'user', isMeta: true, content: [{ type: 'text', text: '<system-reminder>existing</system-reminder>' }] }];
  append(existing, text); assert.strictEqual(existing.length, 1);
}
assert.strictEqual(responsesAppend([], text)[0].isMeta, true);
assert.strictEqual(responsesAppend([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u' }] }], text)[0].isMeta, true);
console.log('append helpers: all assertions passed');
