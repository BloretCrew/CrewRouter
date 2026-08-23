'use strict';
const assert = require('assert');
const { extractCustomInstructions, classifyFile } = require('../utils/custom-instructions-extractor');

// —— Claude Code with CLAUDE.md ——
const claudeMessages = [
  {
    role: 'user',
    isMeta: true,
    content: `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Contents of /workspace/project/CLAUDE.md (project instructions, ...):
# 项目约定
- 始终使用简体中文回复
- 重要：每个完成后必须 git 提交

Contents of /workspace/project/AGENTS.md (project instructions, ...):
# 项目说明
这里是 AGENTS.md 的内容
# currentDate
Today's date is 2026-08-23.
IMPORTANT: this context may or may not be relevant...
</system-reminder>`,
  },
  { role: 'user', content: '帮我看看这个项目' },
];
let r = extractCustomInstructions(claudeMessages, null, { requestSource: 'claude_code' });
assert.strictEqual(r.skipped, null, 'claude 不应跳过');
assert.strictEqual(r.items.length, 2, `claude 应提取 2 个文件, got=${JSON.stringify(r.items)}`);
assert.ok(/\CLAUDE\.md$/.test(r.items[0].file), 'file 名');
assert.strictEqual(r.items[0].source, 'claude_md', 'source');
assert.ok(/简体中文/.test(r.items[0].content), 'content 内容');
assert.strictEqual(r.items[0].position, 'first_user', 'position');
assert.strictEqual(r.items[1].source, 'agents_md', 'agents 归类');
console.log('claude ->', JSON.stringify(r.items.map(i => ({ file: i.file, source: i.source, chars: i.chars, pos: i.position }))));

// —— Codex with <user_instructions> ——
const codexInput = [
  { type: 'message', role: 'developer', content: 'You are a coding agent running in the Codex CLI.' },
  {
    type: 'message',
    role: 'user',
    content: `<user_instructions>
# AGENTS.md instructions for /workspace/project
<INSTRUCTIONS>
# 项目规则
- 用 Rust 实现
- 交互式 CLI
</INSTRUCTIONS>
</user_instructions>
<environment_context><cwd>/workspace/project</cwd></environment_context>`,
  },
  { type: 'message', role: 'user', content: '构建一下' },
];
r = extractCustomInstructions(codexInput, null, { requestSource: 'codex' });
assert.strictEqual(r.items.length, 1, `codex 应提取 1 个文件, got=${JSON.stringify(r.items)}`);
assert.strictEqual(r.items[0].file, 'AGENTS.md', 'codex file');
assert.ok(/Rust/.test(r.items[0].content), 'codex content');
assert.strictEqual(r.items[0].position, 'fragment', 'codex 位置');
console.log('codex ->', JSON.stringify(r.items.map(i => ({ file: i.file, source: i.source, chars: i.chars, pos: i.position }))));

// —— unknown 无规则 → 空数组 ——
r = extractCustomInstructions([{ role: 'user', content: '你好，随便聊聊' }], '你是一个通用助手', {});
assert.strictEqual(r.skipped, null);
assert.strictEqual(r.items.length, 0, `unknown 应返回空, got=${JSON.stringify(r.items)}`);
console.log('unknown -> []', r.items.length === 0);

// —— oversized → skipped:size ——
const big = 'x'.repeat(3 * 1024 * 1024);
r = extractCustomInstructions([{ role: 'user', content: big }], null, {});
assert.strictEqual(r.skipped, 'size', '超大应跳过');
assert.strictEqual(r.items.length, 0);
console.log('oversized -> skipped:size');

// —— 截断：>32KB 只留前 2KB ——
const longMd = 'A'.repeat(40 * 1024);
r = extractCustomInstructions([{ role: 'user', isMeta: true, content: `<system-reminder>\n# claudeMd\nContents of /p/CLAUDE.md (project instructions, ...):\n${longMd}\n# currentDate\nToday's date is 2026-08-23.\n</system-reminder>` }], null, {});
assert.strictEqual(r.items.length, 1);
assert.strictEqual(r.items[0].truncated, true, '应标记截断');
assert.strictEqual(r.items[0].chars, longMd.length, 'chars 为原文长度');
assert.ok(r.items[0].content.length <= 2048, `保留前 2KB, got=${r.items[0].content.length}`);
console.log('truncate ->', r.items[0].truncated, r.items[0].chars, r.items[0].content.length);

console.log('\nALL_PASS');
