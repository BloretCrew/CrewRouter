'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const JSON5 = require('json5');
const jsonc = require('jsonc-parser');
const TOML = require('@iarna/toml');
const YAML = require('yaml');
const { createClientConfigService, TOOLS } = require('../src/app/client-config');

const request = (tool) => ({ tool, baseUrl: 'https://router.example/v1', apiKey: 'unit-test-key', model: 'test-model' });
function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-config-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prompts = [];
  const dialog = {
    showMessageBox: async (_window, details) => { prompts.push(details); return { response: 1 }; },
    showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(home, 'project')] }),
    ...options.dialog,
  };
  const service = createClientConfigService({ home, env: {}, dialog, ...options });
  return { home, prompts, service, file: (tool) => service.getClientConfigTarget(tool).path };
}
function put(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function parse(file, tool) {
  const text = fs.readFileSync(file, 'utf8');
  const format = TOOLS[tool][3];
  return format === 'toml' ? TOML.parse(text) : format === 'yaml' ? YAML.parse(text) : format === 'json5' ? JSON5.parse(text) : jsonc.parse(text);
}
const check = {
  claude: (c) => { assert.equal(c.env.ANTHROPIC_AUTH_TOKEN, 'unit-test-key'); assert.equal(c.env.ANTHROPIC_MODEL, 'test-model'); assert.equal(c.env.ANTHROPIC_BASE_URL, 'https://router.example'); assert.equal(c.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'test-model'); },
  codex: (c) => { assert.equal(c.model_provider, 'crewrouter'); assert.equal(c.model_providers.crewrouter.experimental_bearer_token, 'unit-test-key'); assert.equal(c.model_providers.crewrouter.wire_api, 'responses'); assert.equal(c.model_providers.crewrouter.api_key, undefined); assert.equal(c.model_providers.crewrouter.requires_openai_auth, false); },
  grok: (c) => { assert.equal(c.model.crewrouter.model, 'test-model'); assert.equal(c.model.crewrouter.api_key, 'unit-test-key'); assert.equal(c.model.crewrouter.api_backend, 'chat_completions'); assert.equal(c.models.default, 'crewrouter'); },
  opencode: (c) => { assert.equal(c.provider.crewrouter.options.apiKey, 'unit-test-key'); assert.equal(c.model, 'crewrouter/test-model'); },
  qwen_code: (c) => { assert.equal(c.security.auth.selectedType, 'openai'); assert.equal(c.security.auth.apiKey, 'unit-test-key'); assert.equal(c.providerProtocol.crewrouter, 'openai'); assert.equal(c.modelProviders.crewrouter[0].id, 'test-model'); assert.equal(c.modelProviders.crewrouter[0].apiKey, undefined); },
  hermes: (c) => { assert.equal(c.model.provider, 'custom:crewrouter'); assert.equal(c.providers.crewrouter.api_key, 'unit-test-key'); assert.equal(c.providers.crewrouter.transport, 'openai_chat'); },
  openclaw: (c) => { assert.equal(c.models.providers.crewrouter.api, 'openai-completions'); assert.equal(c.models.providers.crewrouter.models[0].id, 'test-model'); assert.equal(c.agents.defaults.model.primary, 'crewrouter/test-model'); },
};
for (const tool of Object.keys(TOOLS)) {
  test(`${tool}: first write, native confirmation, permissions, backup and minimal merge`, async (t) => {
    const f = fixture(t);
    const file = f.file(tool);
    const first = await f.service.writeClientConfig(request(tool));
    assert.deepEqual(first, { path: file, backupPath: null, canceled: false });
    check[tool](parse(file, tool));
    const original = fs.readFileSync(file, 'utf8');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(f.prompts.length, 1);
    assert.ok(f.prompts[0].detail.includes(file));
    assert.equal(f.prompts[0].defaultId, 0);
    assert.ok(!JSON.stringify(f.prompts).includes('unit-test-key'));
    const data = parse(file, tool);
    data.preserve = { enabled: true, list: [1, 2] };
    put(file, TOOLS[tool][3] === 'toml' ? TOML.stringify(data) : TOOLS[tool][3] === 'yaml' ? YAML.stringify(data) : JSON.stringify(data));
    const before = fs.readFileSync(file, 'utf8');
    const second = await f.service.writeClientConfig(request(tool));
    assert.equal(fs.readFileSync(second.backupPath, 'utf8'), before);
    assert.equal(fs.statSync(second.backupPath).mode & 0o777, 0o600);
    assert.deepEqual(parse(file, tool).preserve, data.preserve);
    check[tool](parse(file, tool));
    const third = await f.service.writeClientConfig(request(tool));
    assert.notEqual(second.backupPath, third.backupPath);
    assert.ok(fs.existsSync(second.backupPath));
    assert.ok(original.length > 0);
  });
}

test('environment overrides stay within fixed client filenames', (t) => {
  const f = fixture(t);
  for (const [tool, [variable, , filename]] of Object.entries(TOOLS)) {
    const directory = path.join(f.home, tool);
    const service = createClientConfigService({ home: f.home, env: { [variable]: directory } });
    assert.equal(service.getClientConfigTarget(tool).path, path.join(directory, filename));
  }
  const file = path.join(f.home, 'custom', 'openclaw.json');
  assert.equal(createClientConfigService({ home: f.home, env: { OPENCLAW_CONFIG_PATH: file } }).getClientConfigTarget('openclaw').path, file);
  assert.equal(createClientConfigService({ home: f.home, env: { CODEX_HOME: '~/custom' } }).getClientConfigTarget('codex').path, path.join(f.home, 'custom/config.toml'));
  for (const directory of ['relative', '/tmp/../outside', '/tmp/invalid\n']) {
    assert.throws(() => createClientConfigService({ home: f.home, env: { CODEX_HOME: directory } }).getClientConfigTarget('codex'), /不安全/);
  }
});

test('unsupported tools and arbitrary renderer paths/content are rejected', async (t) => {
  const f = fixture(t);
  for (const tool of ['deepseek', 'unknown', '__proto__']) {
    assert.deepEqual(f.service.getClientConfigTarget(tool), { path: null, supported: false });
    await assert.rejects(f.service.writeClientConfig(request(tool)), /不支持/);
  }
  for (const extra of [{ path: '/tmp/no' }, { content: '{}' }, { project: '/tmp/no' }, { project: true }]) {
    await assert.rejects(f.service.writeClientConfig({ ...request('claude'), ...extra }), /字段|只有/);
  }
  for (const change of [{ apiKey: 'key\nheader' }, { model: '__proto__' }, { baseUrl: 'file:///tmp/no' }, { baseUrl: 'https://user:pass@host' }, { baseUrl: 'https://host/?key=secret' }, { apiKey: 'x'.repeat(4097) }]) {
    await assert.rejects(f.service.writeClientConfig({ ...request('claude'), ...change }));
  }
  assert.equal(f.prompts.length, 0);
});

test('cancel leaves existing and missing configuration untouched', async (t) => {
  const f = fixture(t, { dialog: { showMessageBox: async () => ({ response: 0 }) } });
  const file = f.file('claude');
  assert.equal((await f.service.writeClientConfig(request('claude'))).canceled, true);
  assert.equal(fs.existsSync(path.dirname(file)), false);
  put(file, '{"keep":true}');
  const result = await f.service.writeClientConfig(request('claude'));
  assert.deepEqual(result, { path: file, backupPath: null, canceled: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"keep":true}');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
});

test('OpenCode native project selection and JSONC user configuration', async (t) => {
  const f = fixture(t);
  const result = await f.service.writeClientConfig({ ...request('opencode'), project: true });
  assert.equal(result.path, path.join(f.home, 'project/opencode.json'));
  assert.equal(fs.existsSync(f.file('opencode')), false);
  const file = f.file('opencode').replace(/\.json$/, '.jsonc');
  put(file, '{\n // Keep this comment\n "theme": "dark",\n}');
  assert.equal(f.file('opencode'), file);
  await f.service.writeClientConfig(request('opencode'));
  assert.match(fs.readFileSync(file, 'utf8'), /Keep this comment/);
  assert.equal(parse(file, 'opencode').theme, 'dark');
  put(file.replace(/\.jsonc$/, '.json'), '{}');
  assert.throws(() => f.file('opencode'), /不安全/);
});

test('project picker cancellation writes nothing', async (t) => {
  const f = fixture(t, { dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  assert.deepEqual(await f.service.writeClientConfig({ ...request('opencode'), project: true }), { path: null, backupPath: null, canceled: true });
  assert.equal(f.prompts.length, 0);
});

test('model arrays merge by ID without deleting other models or fields', async (t) => {
  const f = fixture(t);
  const qwen = f.file('qwen_code');
  put(qwen, JSON.stringify({ modelProviders: { crewrouter: [{ id: 'other' }, { id: 'test-model', contextWindowSize: 123 }], openai: [{ id: 'unrelated' }] }, security: { auth: { keep: true } } }));
  await f.service.writeClientConfig(request('qwen_code'));
  const qc = parse(qwen, 'qwen_code');
  assert.equal(qc.modelProviders.crewrouter.length, 2);
  assert.equal(qc.modelProviders.crewrouter[1].contextWindowSize, 123);
  assert.equal(qc.modelProviders.openai[0].id, 'unrelated');
  const claw = f.file('openclaw');
  put(claw, JSON.stringify({ models: { providers: { crewrouter: { models: [{ id: 'other' }, { id: 'test-model', contextWindow: 123 }] }, other: { enabled: true } } }, agents: { defaults: { models: { 'other/m': {} } } }, security: { enabled: true } }));
  await f.service.writeClientConfig(request('openclaw'));
  const cc = parse(claw, 'openclaw');
  assert.equal(cc.models.providers.crewrouter.models.length, 2);
  assert.equal(cc.models.providers.crewrouter.models[1].contextWindow, 123);
  assert.deepEqual(cc.agents.defaults.models, { 'other/m': {} });
  assert.equal(cc.security.enabled, true);
});

test('damaged, include, ambiguous structures and unpreservable comments fail without changes or credential leakage', async (t) => {
  const f = fixture(t);
  const cases = [
    ['claude', '{broken unit-test-key'], ['claude', '{"env": []}'], ['claude', '{"$include":"other"}'],
    ['claude', '{"env":{},"env":{}}'], ['claude', '{"__proto__":{}}'], ['claude', '{"profiles":{}}'],
    ['codex', '# preserve\nmodel="old"'], ['grok', 'model = [broken'],
    ['hermes', '# preserve\nmodel: {}'], ['hermes', 'a: &a {}\nb: *a'], ['hermes', 'a: 1\na: 2'],
    ['openclaw', '{ /* preserve */ models: {} }'], ['openclaw', '{"$include": "other.json"}'],
    ['qwen_code', '{"modelProviders":{"crewrouter":[{"id":"test-model"},{"id":"test-model"}]}}'],
    ['codex', '[model_providers.crewrouter]\nenv_key="OTHER"'],
  ];
  for (const [tool, text] of cases) {
    const file = f.file(tool);
    put(file, text);
    await assert.rejects(f.service.writeClientConfig(request(tool)), (error) => { assert.ok(!error.message.includes('unit-test-key')); return true; });
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  }
  assert.equal(f.prompts.length, 0);
});

test('symlink ancestors, target symlinks and hardlinks are rejected', async (t) => {
  const f = fixture(t);
  const outside = path.join(f.home, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.home, '.claude'));
  await assert.rejects(f.service.writeClientConfig(request('claude')), /符号链接/);
  fs.unlinkSync(path.join(f.home, '.claude'));
  fs.mkdirSync(path.join(f.home, '.claude'));
  const original = path.join(outside, 'config');
  put(original, '{}');
  const target = path.join(f.home, '.claude/settings.json');
  fs.symlinkSync(original, target);
  await assert.rejects(f.service.writeClientConfig(request('claude')), /符号链接/);
  fs.unlinkSync(target);
  fs.linkSync(original, target);
  await assert.rejects(f.service.writeClientConfig(request('claude')), /普通独立/);
  assert.equal(fs.readFileSync(original, 'utf8'), '{}');
});

test('file size limit and managed/env overrides fail closed', async (t) => {
  const f = fixture(t);
  put(f.file('claude'), ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(f.service.writeClientConfig(request('claude')), /过大/);
  fs.unlinkSync(f.file('claude'));
  put(path.join(f.home, '.claude/managed-settings.json'), '{}');
  assert.throws(() => f.file('claude'), /不安全/);
  for (const [tool, env] of [['hermes', { HERMES_PROFILE: 'work' }], ['openclaw', { OPENCLAW_PROFILE: 'work' }], ['opencode', { OPENCODE_CONFIG_CONTENT: '{}' }]]) {
    assert.throws(() => createClientConfigService({ home: f.home, env }).getClientConfigTarget(tool), /不安全/);
  }
});

test('duplicate submissions, navigation and concurrent edits cannot overwrite', async (t) => {
  let finish;
  const f = fixture(t, { dialog: { showMessageBox: () => new Promise((resolve) => { finish = resolve; }) } });
  const pending = f.service.writeClientConfig(request('claude'));
  await assert.rejects(f.service.writeClientConfig(request('claude')), /正在进行/);
  put(f.file('claude'), '{"external":true}');
  finish({ response: 1 });
  await assert.rejects(pending, /已变化/);
  assert.equal(fs.readFileSync(f.file('claude'), 'utf8'), '{"external":true}');
  const next = f.service.writeClientConfig(request('claude'), { isTrusted: () => false });
  finish({ response: 1 });
  await assert.rejects(next, /页面已变化/);
});

test('atomic rename failure preserves original, secured backup and cleans temp files', async (t) => {
  const f = fixture(t, { fsImpl: { renameSync() { throw new Error('filesystem unit-test-key'); } } });
  const file = f.file('claude');
  put(file, '{"old":true}');
  await assert.rejects(f.service.writeClientConfig(request('claude')), (error) => { assert.equal(error.message.includes('unit-test-key'), false); return true; });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}');
  const files = fs.readdirSync(path.dirname(file));
  assert.equal(files.length, 2);
  assert.ok(files.some((name) => name.includes('crewrouter-backup')));
  assert.ok(!files.some((name) => name.endsWith('.tmp')));
});

test('service normalizes API roots and honors OpenClaw home', async (t) => {
  const f = fixture(t);
  await f.service.writeClientConfig({ ...request('codex'), baseUrl: 'https://router.example/' });
  assert.equal(parse(f.file('codex'), 'codex').model_providers.crewrouter.base_url, 'https://router.example/v1');
  const service = createClientConfigService({ home: f.home, env: { OPENCLAW_HOME: path.join(f.home, 'alternate') } });
  assert.equal(service.getClientConfigTarget('openclaw').path, path.join(f.home, 'alternate/.openclaw/openclaw.json'));
});

test('credential overrides fail before confirmation without changing existing files', async (t) => {
  const f = fixture(t);
  const cases = [
    ['opencode', { provider: { crewrouter: { options: { headers: { Authorization: 'Bearer old-test-key' } } } } }],
    ['opencode', { provider: { crewrouter: { options: { headers: { authorization: 'Bearer old-test-key' } } } } }],
    ['opencode', { provider: { crewrouter: { headers: { AUTHORIZATION: 'Bearer old-test-key' } } } }],
    ['qwen_code', { modelProviders: { crewrouter: [{ id: 'test-model', apiKey: 'old-test-key' }] } }],
    ['qwen_code', { modelProviders: { crewrouter: [{ id: 'test-model', envKey: 'OLD_TEST_KEY' }] } }],
  ];
  for (const [tool, config] of cases) {
    const file = f.file(tool);
    const text = JSON.stringify(config);
    put(file, text);
    await assert.rejects(f.service.writeClientConfig(request(tool)), (error) => {
      assert.match(error.message, /认证/);
      assert.doesNotMatch(error.message, /old-test-key|unit-test-key/);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  }
  assert.equal(f.prompts.length, 0);
});

test('TOML date and time values are rejected before cloning or serialization', async (t) => {
  const f = fixture(t);
  for (const tool of ['codex', 'grok']) {
    for (const value of ['1979-05-27T07:32:00Z', '1979-05-27T07:32:00', '1979-05-27', '07:32:00']) {
      const file = f.file(tool);
      const text = `[unrelated]\nvalue = ${value}\n`;
      put(file, text);
      await assert.rejects(f.service.writeClientConfig(request(tool)), /日期时间/);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
    }
  }
  assert.equal(f.prompts.length, 0);
});

test('JSON5 duplicate keys, unsafe integers and unsupported syntax fail closed', async (t) => {
  const f = fixture(t);
  const file = f.file('openclaw');
  for (const text of [
    '{"keep":1,"keep":2}',
    '{"keep":{"value":1,"value":2}}',
    '{"keep":1,"\\u006beep":2}',
    '{"keep":9007199254740993}',
    '{"keep":-9007199254740993}',
    '{keep: 1}',
    "{'keep': 1}",
    '{"keep":0x20000000000001}',
    '{"keep":NaN}',
  ]) {
    put(file, text);
    await assert.rejects(f.service.writeClientConfig(request('openclaw')));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  }
  assert.equal(f.prompts.length, 0);
  put(file, '{"keep":9007199254740991,}');
  await f.service.writeClientConfig(request('openclaw'));
  assert.equal(parse(file, 'openclaw').keep, Number.MAX_SAFE_INTEGER);
});

test('existing effort and context settings survive while missing settings receive defaults', async (t) => {
  const f = fixture(t);
  put(f.file('claude'), '{"effortLevel":"medium","keep":true}');
  await f.service.writeClientConfig(request('claude'));
  const claude = parse(f.file('claude'), 'claude');
  assert.equal(claude.effortLevel, 'medium');
  assert.equal(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'test-model');
  assert.equal(claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'test-model');
  assert.equal(claude.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'test-model');
  put(f.file('grok'), '[model.crewrouter]\ncontext_window=64000\n');
  await f.service.writeClientConfig(request('grok'));
  assert.equal(parse(f.file('grok'), 'grok').model.crewrouter.context_window, 64000);
  put(f.file('claude'), '{}');
  put(f.file('grok'), 'keep=true\n');
  await f.service.writeClientConfig(request('claude'));
  await f.service.writeClientConfig(request('grok'));
  assert.equal(parse(f.file('claude'), 'claude').effortLevel, 'high');
  assert.equal(parse(f.file('grok'), 'grok').model.crewrouter.context_window, 200000);
});

test('Codex false authentication flag remains writable on consecutive updates', async (t) => {
  const f = fixture(t);
  await f.service.writeClientConfig(request('codex'));
  await f.service.writeClientConfig({ ...request('codex'), apiKey: 'updated-test-key' });
  const provider = parse(f.file('codex'), 'codex').model_providers.crewrouter;
  assert.equal(provider.requires_openai_auth, false);
  assert.equal(provider.experimental_bearer_token, 'updated-test-key');
  assert.equal(provider.base_url, 'https://router.example/v1');
});
