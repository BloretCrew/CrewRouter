'use strict';

const assert = require('assert');
const { createStreamScrubber } = require('../utils/inject-prompt-stream');
const { classifyCompaction } = require('../utils/attribution');

const oldPrompt = 'prefix\n\n# User Custom Instructions (CrewRouter)\n\nsecret\n\n---\n\n';
const oldScrubber = createStreamScrubber(oldPrompt);
let output = '';
for (const chunk of ['before\n', '\n# User Custom Instr', 'uctions (CrewRouter)\n\nsec', 'ret\n\n---\n\nafter']) output += oldScrubber.feed(chunk);
output += oldScrubber.flush();
assert.strictEqual(output, 'before\nafter');

const newPrompt = '<system-reminder>\n# claudeMd\nContents of /CrewRouter/CLAUDE.md (project instructions, configured by CrewRouter):\na\n\n---\n\nb\n# currentDate\nToday\'s date is 2026-08-29.\n</system-reminder>';
const newScrubber = createStreamScrubber(newPrompt);
output = '';
for (const chunk of ['before\n<system-re', 'minder>\n# claudeMd\nContents of x (project instructions, x):\na\n\n---\n\nb\n# current', 'Date\nToday\'s date is x.\n</system-reminder>after']) output += newScrubber.feed(chunk);
output += newScrubber.flush();
assert.strictEqual(output, 'before\nafter');

const inline = createStreamScrubber(newPrompt);
output = inline.feed('answer <system-reminder>\n# claudeMd\nsecret\n</system-reminder> after');
output += inline.flush();
assert.strictEqual(output, 'answer <system-reminder>\n# claudeMd\nsecret\n</system-reminder> after');

const atStart = createStreamScrubber(newPrompt);
output = atStart.feed('<system-reminder>\n# claudeMd\nsecret\n</system-reminder>after');
output += atStart.flush();
assert.strictEqual(output, 'after');

const singleLine = createStreamScrubber(newPrompt);
output = singleLine.feed('answer\n  <system-reminder>\n# claudeMd\nsecret\n</system-reminder>after');
output += singleLine.flush();
assert.strictEqual(output, 'answer\nafter');

const crlf = createStreamScrubber(newPrompt);
output = crlf.feed('answer\r\n\t<system-reminder>\r\n# claudeMd\r\nsecret\r\n</system-reminder>after');
output += crlf.flush();
assert.strictEqual(output, 'answer\r\nafter');

const longPrefix = '<system-reminder>\n' + 'x'.repeat(400) + '\n# claudeMd\nsecret\n</system-reminder>';
const longScrubber = createStreamScrubber(longPrefix);
output = '';
for (const chunk of ['before\n<system-rem', 'inder>\n' + 'x'.repeat(200), 'x'.repeat(200) + '\n# claudeMd\nsecret\n</system-rem', 'inder>after']) output += longScrubber.feed(chunk);
output += longScrubber.flush();
assert.strictEqual(output, 'before\nafter');

const splitEnd = createStreamScrubber(newPrompt);
output = splitEnd.feed('before\n<system-reminder>\n# claudeMd\nsecret\n</system-');
output += splitEnd.feed('reminder>after');
output += splitEnd.flush();
assert.strictEqual(output, 'before\nafter');

const passthrough = createStreamScrubber(oldPrompt);
assert.strictEqual(passthrough.feed('plain'), '');
assert.strictEqual(passthrough.flush(), 'plain');
const noInjection = createStreamScrubber('');
assert.strictEqual(noInjection.feed('plain'), 'plain');
assert.strictEqual(noInjection.flush(), '');

const longHistory = `previous conversation\n${'role: user\nmessage '.repeat(600)}`;
assert.strictEqual(classifyCompaction({ tools: [], system: '', messages: [{ role: 'user', content: longHistory }] }), true);
assert.strictEqual(classifyCompaction({ tools: [{ type: 'function' }], system: '', messages: [{ role: 'user', content: longHistory }] }), false);
assert.strictEqual(classifyCompaction({ system: '', messages: [{ role: 'user', content: 'short' }] }), false);
console.log('stream scrubber and compaction classifier: all assertions passed');
