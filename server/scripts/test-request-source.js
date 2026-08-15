'use strict';

const assert = require('assert');
const {
  REQUEST_SOURCES,
  detectRequestSource,
  detectRequestSourceFromPrompt,
  sourceLabel,
  clientMetaFromReq,
} = require('../utils/request-source');
const { buildUsageLogsFilter, buildUserUsageLogsFilter } = require('../utils/usage-logs-filter');

const cases = [
  // Grok headers
  [{ 'x-grok-client-identifier': 'grok-shell', 'user-agent': 'xai-grok-workspace/1.2.3' }, 'grok'],
  [{ 'user-agent': 'grok-shell/1.2.3 (linux; x86_64)' }, 'grok'],

  // Codex UA
  [{ 'user-agent': 'codex_cli_rs/0.42.0 (Mac OS 14.0.0; arm64) terminal' }, 'codex'],
  [{ originator: 'codex_vscode', 'user-agent': 'Mozilla/5.0' }, 'codex'],

  // Claude UA
  [{ 'user-agent': 'claude-cli/1.0.12 (user, cli)' }, 'claude_code'],

  // OpenCode UA
  [{ 'user-agent': 'opencode/1.2.3' }, 'opencode'],

  // Qwen / Hermes / OpenClaw UA
  [{ 'user-agent': 'QwenCode/1.0.0 (linux; x64)' }, 'qwen_code'],
  [{ 'user-agent': 'hermes-cli/0.9.0' }, 'hermes'],
  [{ 'user-agent': 'openclaw/2026.3.22' }, 'openclaw'],
  [{ originator: 'openclaw' }, 'openclaw'],

  // DeepSeek Harness
  [{ 'user-agent': 'deepseek-harness/0.1.0 (+https://github.com/deepseek-ai/deepseek-harness)' }, 'deepseek_harness'],
  [{ 'x-deepseek-harness-user-id': 'anon-1', 'user-agent': 'node' }, 'deepseek_harness'],
  [{ 'x-crewrouter-client': 'dsh' }, 'deepseek_harness'],

  // unknown
  [{ 'user-agent': 'OpenAI-Python/1.0.0' }, 'unknown'],
  [{}, 'unknown'],

  [{ 'x-crewrouter-client': 'codex', 'user-agent': 'curl/8.0' }, 'codex'],
];

for (const [headers, expected] of cases) {
  assert.strictEqual(
    detectRequestSource(headers),
    expected,
    `headers=${JSON.stringify(headers)} expected=${expected} got=${detectRequestSource(headers)}`
  );
}

// ——— 提示词指纹 ———
assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'system',
        content: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ],
  }),
  'claude_code'
);

assert.strictEqual(
  detectRequestSourceFromPrompt({
    instructions: 'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.',
  }),
  'codex'
);

assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'system',
        content: 'You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.',
      },
    ],
  }),
  'qwen_code'
);

assert.strictEqual(
  detectRequestSourceFromPrompt({
    system: 'You are Hermes Agent, an intelligent AI assistant created by Nous Research. You are helpful.',
  }),
  'hermes'
);

assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      { role: 'system', content: 'You are a personal assistant running inside OpenClaw.' },
    ],
  }),
  'openclaw'
);

assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
    ],
  }),
  'deepseek_harness'
);

assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'system',
        content:
          'You are opencode, an interactive CLI tool that helps users with software engineering tasks.\nTo give feedback, users should report the issue at https://github.com/anomalyco/opencode/issues',
      },
    ],
  }),
  'opencode'
);

assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      { role: 'system', content: 'You are the Goal Plan Writer for the xAI Grok Build harness. You run ONCE' },
    ],
  }),
  'grok'
);

assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'system',
        content:
          'You are Grok released by xAI. You are an interactive CLI tool that helps users with software engineering tasks.',
      },
    ],
  }),
  'grok'
);

assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'system',
        content:
          'You are Grok 4.5 released by xAI. You are an interactive CLI tool that helps users with software engineering tasks.',
      },
    ],
  }),
  'grok'
);

// 提示词纠正伪装 UA：Qwen 走代理时可能发 claude-cli
assert.strictEqual(
  detectRequestSource(
    { 'user-agent': 'claude-cli/1.2.3 (external, cli)' },
    {},
    {
      messages: [
        {
          role: 'system',
          content: 'You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.',
        },
      ],
    }
  ),
  'qwen_code'
);

// 无 UA，仅靠 messages
assert.strictEqual(
  detectRequestSource(
    {},
    {},
    {
      messages: [
        {
          role: 'system',
          content: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
      ],
    }
  ),
  'claude_code'
);

// clientMetaFromReq 读取 req.body
const meta = clientMetaFromReq({
  headers: { 'user-agent': 'curl/8.0' },
  body: {
    messages: [
      {
        role: 'system',
        content: 'You are a coding agent running in the Codex CLI. Codex CLI is an open source project led by OpenAI.',
      },
    ],
  },
});
assert.strictEqual(meta.requestSource, 'codex');

// 显式覆盖仍优先于提示词
assert.strictEqual(
  detectRequestSource(
    { 'x-crewrouter-client': 'hermes', 'user-agent': 'curl' },
    {},
    { messages: [{ role: 'system', content: "You are Claude Code, Anthropic's official CLI for Claude." }] }
  ),
  'hermes'
);

assert.strictEqual(sourceLabel(REQUEST_SOURCES.OPENCLAW), 'OpenClaw');
assert.strictEqual(sourceLabel(REQUEST_SOURCES.HERMES), 'Hermes');

// ——— message 结构指纹（源码组装块）———
// Grok: messages[1] = <user_info> + <git_status>（无 system 身份句也应命中）
assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      { role: 'system', content: 'You are a helpful coding assistant.' },
      {
        role: 'user',
        content: `<user_info>
OS Version: linux
Shell: /bin/bash
Workspace Path: /data/CrewRouter
Today's date: 2026-08-10
Note: Prefer using relative paths over absolute paths as tool call args when possible.
</user_info>

<git_status>
This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.
## main
</git_status>`,
      },
      { role: 'user', content: '<user_query>\nfix a bug\n</user_query>' },
    ],
  }),
  'grok'
);

// Codex: <environment_context>
assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'user',
        content: `<environment_context>
  <cwd>/repo</cwd>
  <shell>bash</shell>
  <current_date>2026-02-26</current_date>
</environment_context>`,
      },
    ],
  }),
  'codex'
);

// OpenCode: env builtins
assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'user',
        content: `Here is some useful information about the environment you are running in:
<env>
  Working directory: /tmp/proj
  Workspace root folder: /tmp/proj
  Is directory a git repo: yes
  Platform: linux
</env>
Today's date: Mon Aug 10 2026`,
      },
    ],
  }),
  'opencode'
);

// Qwen: environmentContext 启动块
assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'user',
        content: `This is the Qwen Code. We are setting up the context for our chat.
Today's date is Monday, August 10, 2026.
My operating system is: linux
I'm currently working in the directory: /home/user/app`,
      },
    ],
  }),
  'qwen_code'
);

// Hermes: 自定义 SOUL + Nous / profile 结构（无默认 "You are Hermes Agent" 全文）
assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'system',
        content: `# SOUL.md — 自定义人格
你是一个助手。
Active Hermes profile: default. Other profiles live under ~/.hermes/profiles/.
User home directory: /home/tester
Current working directory: /data/proj
Workspace (snapshot at session start — re-check with \`git\` before acting on it):
- Root: /data/proj
Created by Nous Research tooling.`,
      },
    ],
  }),
  'hermes'
);

// Hermes 中文 SOUL 自称
assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'system',
        content: `# SOUL.md — 「稚梦归心」
你是 Hermes Agent，但你的行事风格融合了布伦妮的气质。
Active Hermes profile: default.`,
      },
    ],
  }),
  'hermes'
);

// OpenClaw: 身份 + Workspace Files
assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'system',
        content: `You are a personal assistant running inside OpenClaw.
## Tooling
## Workspace
Working directory: /home/user/.openclaw/workspace
## Workspace Files (injected)
User-editable; OpenClaw loads below as Project Context.`,
      },
    ],
  }),
  'openclaw'
);

// Claude Code: # claudeMd 结构键（非裸 system-reminder）
assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'user',
        content: `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Codebase and user instructions are shown below.
# currentDate
Today's date is 2026-08-06.

      IMPORTANT: this context may or may not be relevant to your tasks.
</system-reminder>`,
      },
    ],
  }),
  'claude_code'
);

// 共享 SOUL 模板 alone 不应标成 openclaw（无 OpenClaw 运行时）
assert.strictEqual(
  detectRequestSourceFromPrompt({
    messages: [
      {
        role: 'system',
        content: `# SOUL.md - Who You Are
_You're not a chatbot. You're becoming someone._
**Be genuinely helpful.**`,
      },
    ],
  }),
  null
);

// 非 harness 应用助手保持 unknown
assert.strictEqual(
  detectRequestSource(
    {},
    {},
    {
      messages: [
        {
          role: 'system',
          content: '你是 Blora Agent，一个运行在用户本地设备上的智能助手。',
        },
      ],
    }
  ),
  'unknown'
);

const admin = buildUsageLogsFilter({ request_source: 'codex' });
assert.ok(admin.where.includes('u.request_source = $'));
assert.ok(admin.params.includes('codex'));

const user = buildUserUsageLogsFilter(7, { request_source: 'opencode' });
assert.ok(user.where.includes('u.request_source = $'));

console.log('All request-source assertions passed (headers + prompt + structure).');
