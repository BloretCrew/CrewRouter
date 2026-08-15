'use strict';

const assert = require('assert');
const { analyzeMessages, aggregateMessageStats } = require('../utils/message-analysis');

const result = analyzeMessages([
  { role: 'system', content: 'You are a helpful coding assistant.' },
  { role: 'user', content: `<user_info>\nOS Version: linux\nShell: /bin/bash\nWorkspace Path: /data/demo\nToday's date: 2026-08-11\nNote: Prefer using relative paths over absolute paths as tool call args when possible.\n</user_info>\n\n<git_status>\nThis is the git status at the start of the conversation.\n## main\n M src/app.js\n</git_status>` },
  { role: 'user', content: '<user_query>\n请分析\n</user_query>' },
]);

assert.strictEqual(result.message_count, 3);
assert.deepStrictEqual(result.roles, { system: 1, user: 2 });
assert.deepStrictEqual(result.metadata_message_indexes, [1]);
assert.strictEqual(result.values.os_version, 'linux');
assert.strictEqual(result.values.shell, '/bin/bash');
assert.strictEqual(result.values.workspace_path, '/data/demo');
assert.ok(result.values.git_status.includes('M src/app.js'));
assert.strictEqual(result.observed_fields.project_layout, false);
assert.strictEqual(result.block_counts.user_info, 1);
assert.strictEqual(result.block_counts.git_status, 1);
assert.strictEqual(result.messages[2].has_user_query, true);

const reordered = analyzeMessages([
  { role: 'system', content: '<user_info>Workspace Path: /prompt/path</user_info>' },
  { role: 'user', content: '<system-reminder>AGENTS.md reminder</system-reminder>' },
  { role: 'user', content: '<user_info>Workspace Path: /prefix/path</user_info><git_status>## main</git_status>' },
]);
assert.deepStrictEqual(reordered.metadata_message_indexes, [0, 1, 2]);
assert.strictEqual(reordered.block_counts['system-reminder'], 1);
assert.strictEqual(reordered.values.workspace_path, '/prompt/path');
assert.strictEqual(reordered.values.git_status, '## main');

const aggregate = aggregateMessageStats([
  { created_at: '2026-08-11T00:00:00.000Z', request_source: 'grok', messages: result.messages.map(m => ({ role: m.role, content: m.index === 1 ? '<user_info>Workspace Path: /data/demo</user_info><git_status>## main</git_status>' : (m.has_user_query ? '<user_query>hi</user_query>' : 'system') })) },
]);
assert.strictEqual(aggregate.summary.analyzed_requests, 1);
assert.strictEqual(aggregate.by_source[0].request_source, 'grok');
assert.strictEqual(aggregate.by_block.find(r => r.block === 'git_status').requests, 1);
assert.strictEqual(aggregate.by_workspace[0].workspace_path, '/data/demo');
assert.strictEqual(aggregate.summary.total_tokens, 0);


console.log('All message-analysis assertions passed.');
