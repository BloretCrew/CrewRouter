'use strict';

const assert = require('assert');
const {
  extractLastInputText,
  stripTrigger,
  parseRequest,
  matchCommand,
} = require('../utils/crewrouter-command');

assert.strictEqual(stripTrigger('hello'), null);
assert.ok(stripTrigger('@CrewRouter 开启吞图') === '开启吞图');
assert.ok(stripTrigger('@crewrouter 状态').toLowerCase() === '状态');
assert.ok(stripTrigger('@CREWROUTER help').toLowerCase() === 'help');
assert.ok(stripTrigger('@CR 开启吞图') === '开启吞图');
assert.ok(stripTrigger('@cr 状态').toLowerCase() === '状态');
assert.strictEqual(stripTrigger('@credit 状态'), null);

assert.strictEqual(
  extractLastInputText({
    messages: [
      { role: 'user', content: '@CrewRouter 开启吞图' },
      { role: 'user', content: '普通问题' },
    ],
  }),
  '普通问题'
);

assert.strictEqual(
  extractLastInputText({
    messages: [
      { role: 'user', content: '普通问题' },
      { role: 'user', content: '<user_info>x</user_info><user_query>\n@CrewRouter 开启吞图\n</user_query>' },
    ],
  }),
  '@CrewRouter 开启吞图'
);

assert.strictEqual(
  extractLastInputText({
    input: [
      { role: 'user', content: '@CrewRouter 开启吞图' },
      { role: 'user', content: [{ type: 'input_text', text: '后面这条才算' }] },
    ],
  }),
  '后面这条才算'
);

const miss = parseRequest({
  messages: [
    { role: 'user', content: '@CrewRouter 开启吞图' },
    { role: 'user', content: '请修 bug' },
  ],
});
assert.strictEqual(miss.hit, false);

const hit = parseRequest({
  messages: [{ role: 'user', content: '<user_query>@crewrouter 开启吞图</user_query>' }],
});
assert.strictEqual(hit.hit, true);
assert.strictEqual(hit.cmd.id, 'swallow');
assert.strictEqual(hit.args.on, true);

const off = parseRequest({ messages: [{ role: 'user', content: '@CrewRouter 关闭 吞图' }] });
assert.strictEqual(off.hit, true);
assert.strictEqual(off.cmd.id, 'swallow');
assert.strictEqual(off.args.on, false);

const unknown = parseRequest({ messages: [{ role: 'user', content: '@CrewRouter 飞天' }] });
assert.strictEqual(unknown.hit, true);
assert.strictEqual(unknown.cmd, null);

const disableHint = matchCommand('停用密钥');
assert.strictEqual(disableHint.cmd.id, 'disable_key_hint');
const disableOk = matchCommand('确认停用密钥');
assert.strictEqual(disableOk.cmd.id, 'disable_key');

const stats = matchCommand('统计 7天 全部');
assert.strictEqual(stats.cmd.id, 'stats');
assert.strictEqual(stats.args.days, 7);
assert.strictEqual(stats.args.all, true);
const statsEn = matchCommand('stats 7d all');
assert.strictEqual(statsEn.cmd.id, 'stats');
assert.strictEqual(statsEn.args.days, 7);
assert.strictEqual(statsEn.args.all, true);
assert.strictEqual(matchCommand('help').cmd.id, 'help');
assert.strictEqual(matchCommand('switch model foo').cmd.id, 'switch_model');
assert.strictEqual(matchCommand('enable swallow').cmd.id, 'swallow');

const responses = parseRequest({
  input: [{ role: 'user', content: 'ctx' }, { role: 'user', content: '@CrewRouter 状态' }],
});
assert.strictEqual(responses.hit, true);
assert.strictEqual(responses.cmd.id, 'status');

const short = parseRequest({ messages: [{ role: 'user', content: '@Cr 关闭吞图' }] });
assert.strictEqual(short.hit, true);
assert.strictEqual(short.cmd.id, 'swallow');
assert.strictEqual(short.args.on, false);

console.log('All crewrouter-command assertions passed.');
