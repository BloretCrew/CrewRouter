'use strict';

const assert = require('assert');
const { createStreamScrubber } = require('../utils/inject-prompt-stream');
const { classifyCompaction } = require('../utils/attribution');

const enabledPrompt = 'prefix\n\n# User Custom Instructions (CrewRouter)\n\nsecret\n\n---\n\n';
const scrubber = createStreamScrubber(enabledPrompt);
let output = '';
for (const chunk of ['before\n', '\n# User Custom Instr', 'uctions (CrewRouter)\n\nsec', 'ret\n\n---\n\nafter']) output += scrubber.feed(chunk);
output += scrubber.flush();
assert.strictEqual(output, 'before\nafter');

const passthrough = createStreamScrubber(enabledPrompt);
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
