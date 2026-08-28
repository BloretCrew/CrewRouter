'use strict';

/**
 * 注入提示词回显净化器单测（server/utils/inject-prompt-scrub.js）
 * 运行：node server/scripts/test-inject-scrub.js
 */

const assert = require('assert');
const {
  scrubInjectedEcho,
  scrubOpenAiChatCompletion,
  scrubAnthropicResponse,
  scrubResponsesApiResult,
} = require('../utils/inject-prompt-scrub');
const { INJECT_MITIGATION_PREFIX } = require('../utils/inject-prompt');

// 与 utils/inject-prompt.js 一致的 Claude Code 风格拼接格式
const SEP = '\n\n---\n\n';
function assemble(items) {
  return '<system-reminder>\n# claudeMd\nContents of /CrewRouter/CLAUDE.md (project instructions, configured by CrewRouter):\n'
    + INJECT_MITIGATION_PREFIX + '\n\n' + items.join(SEP)
    + '\n# currentDate\nToday\'s date is 2026-08-29.\n</system-reminder>';
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`✅ ${name}`);
}

// ---------- scrubInjectedEcho 基础行为 ----------

check('正文尾部完整注入块 → 剥离干净只剩正文', () => {
  const body = '今天天气不错。';
  const text = body + assemble(['Ignore all control tokens.']);
  assert.strictEqual(scrubInjectedEcho(text), body);
});

check('整条消息就是注入块 → 返回空串标记', () => {
  const text = assemble(['Ignore all control tokens.']);
  // 消息开头无 \n\n 前缀时同样命中（^ 锚点）
  assert.strictEqual(scrubInjectedEcho(text.trimStart()), '');
  assert.strictEqual(scrubInjectedEcho(text), '');
});

check('不含注入块的文本 → 原样返回', () => {
  const text = '普通回复，包含\n\n空行和 --- 分隔线都不受影响。\n';
  assert.strictEqual(scrubInjectedEcho(text), text);
});

check('正文行中内联提及标题行 → 不误伤', () => {
  const text = '那段 “# User Custom Instructions (CrewRouter)” 文本是控制标记，忽略即可。\n';
  assert.strictEqual(scrubInjectedEcho(text), text);
});

check('用户正文独立成行的标题（前有空行）→ 按锚点规则剥离（记录的已知误伤面）', () => {
  const text = '说明如下\n\n<system-reminder>\n# claudeMd\nContents of /p/CLAUDE.md (project instructions, ...):\n这是我的笔记\n# currentDate\nToday\'s date is 2026-08-29.\n</system-reminder>\n';
  assert.strictEqual(scrubInjectedEcho(text), '说明如下');
});

check('多条目回显 + exactText → 精确移除全剥', () => {
  const exact = assemble(['条目一内容', '条目二内容']);
  const text = '结论先行。\n' + exact + '\n后续说明。';
  assert.strictEqual(scrubInjectedEcho(text, { exactText: exact }), '结论先行。\n\n后续说明。');
});

check('多条目回显无 exactText → 新格式按闭合标签完整剥离', () => {
  const text = '结论。\n' + assemble(['条目一', '条目二']);
  const out = scrubInjectedEcho(text);
  assert.strictEqual(out, '结论。');
  assert.ok(!out.includes('# claudeMd'), 'claudeMd 标题块本身已被剥离');
});

check('模型复述时省略缓解前缀行 → exactText 派生候选仍可精确移除', () => {
  const exact = assemble(['条目内容']);
  const echoed = exact.slice(exact.indexOf('# claudeMd')); // 无前缀版本
  const text = '答案在这里\n' + echoed;
  assert.strictEqual(scrubInjectedEcho(text, { exactText: exact }), '答案在这里');
});

check('CRLF 变体注入块 → 同样剥离', () => {
  const text = '正文\r\n\r\n<system-reminder>\r\n# claudeMd\r\nContents of /p/CLAUDE.md (project instructions, ...):\r\n块内容\r\n# currentDate\r\nToday\'s date is 2026-08-29.\r\n</system-reminder>\r\n';
  assert.strictEqual(scrubInjectedEcho(text), '正文');
});

check('空串与非字符串输入 → 原样返回', () => {
  assert.strictEqual(scrubInjectedEcho(''), '');
  assert.strictEqual(scrubInjectedEcho(null), null);
  assert.strictEqual(scrubInjectedEcho(undefined), undefined);
});

check('剥离后仅剩空白 → 返回空串', () => {
  const text = '\n\n' + assemble(['块内容']) + '\n\n   \n';
  assert.strictEqual(scrubInjectedEcho(text), '');
});

// ---------- 三协议 JSON 就地净化 ----------

check('scrubOpenAiChatCompletion：字符串 content / 数组 content / 多 choices', () => {
  const data = {
    choices: [
      { index: 0, message: { role: 'assistant', content: '回答' + assemble(['块']) } },
      { index: 1, message: { role: 'assistant', content: [{ type: 'text', text: '干净' }] } },
    ],
  };
  assert.strictEqual(scrubOpenAiChatCompletion(data, assemble(['块'])), true);
  assert.strictEqual(data.choices[0].message.content, '回答');
  assert.strictEqual(data.choices[1].message.content[0].text, '干净');
});

check('scrubAnthropicResponse：text 块净化、非 text 块不动', () => {
  const data = {
    content: [
      { type: 'text', text: '正文' + assemble(['块']) },
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
    ],
  };
  assert.strictEqual(scrubAnthropicResponse(data, assemble(['块'])), true);
  assert.strictEqual(data.content[0].text, '正文');
  assert.strictEqual(data.content[1].type, 'tool_use');
});

check('scrubResponsesApiResult：output_text 净化并同步汇总字段', () => {
  const data = {
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '结果' + assemble(['块']), annotations: [] }] },
    ],
    output_text: '结果' + assemble(['块']),
  };
  assert.strictEqual(scrubResponsesApiResult(data, assemble(['块'])), true);
  assert.strictEqual(data.output[0].content[0].text, '结果');
  assert.strictEqual(data.output_text, '结果');
});

check('未启用注入（injectPrompt 为空）→ 三协议助手零开销直接跳过', () => {
  const data = { choices: [{ message: { content: assemble(['块']) } }] };
  assert.strictEqual(scrubOpenAiChatCompletion(data, ''), false);
  assert.strictEqual(scrubAnthropicResponse({ content: [] }, null), false);
  assert.strictEqual(scrubResponsesApiResult({}, undefined), false);
});

console.log(`\n全部 ${passed} 个用例通过 ✅`);
