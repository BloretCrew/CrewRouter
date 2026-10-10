'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TOML = require('../CrewRouter-Desktop/node_modules/@iarna/toml');
const YAML = require('../CrewRouter-Desktop/node_modules/yaml');

const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/client-config.js'), 'utf8'), context);
const generate = context.window.CrewRouterClientConfig.generate;
const tools = ['claude', 'codex', 'grok', 'opencode', 'qwen_code', 'hermes', 'openclaw', 'deepseek'];
const parse = (tool, content) => ['codex', 'grok'].includes(tool)
  ? TOML.parse(content)
  : ['hermes', 'deepseek'].includes(tool) ? YAML.parse(content) : JSON.parse(content);

function checkConfigs(options) {
  const model = options.model ?? 'claude-fable-5';
  const base = options.baseUrl.replace(/\/+$/, '');
  const v1 = base.endsWith('/v1') ? base : base + '/v1';
  for (const tool of tools) {
    const output = generate(tool, options);
    assert.deepEqual(Object.keys(output).sort(), ['content', 'path', 'reason', 'supported', 'title']);
    assert.ok(output.title && output.path && output.content);
    assert.equal(output.supported, tool !== 'deepseek');
    assert.equal(output.reason.length > 0, tool === 'deepseek');
    const config = parse(tool, output.content);
    switch (tool) {
      case 'claude':
        assert.deepEqual(config, {
          env: {
            ANTHROPIC_BASE_URL: base.replace(/\/v1$/, ''), ANTHROPIC_AUTH_TOKEN: options.apiKey, ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model
          },
          model, effortLevel: 'high'
        });
        break;
      case 'codex':
        assert.equal(config.model, model);
        assert.equal(config.model_provider, 'crewrouter');
        assert.deepEqual(config.model_providers.crewrouter, {
          name: 'CrewRouter', base_url: v1, experimental_bearer_token: options.apiKey,
          wire_api: 'responses', requires_openai_auth: false
        });
        break;
      case 'grok':
        assert.deepEqual(Object.keys(config).sort(), ['model', 'models']);
        assert.equal(config.models.default, 'crewrouter');
        assert.equal(config.model.crewrouter.model, model);
        assert.equal(config.model.crewrouter.base_url, v1);
        assert.equal(config.model.crewrouter.api_key, options.apiKey);
        assert.equal(config.model.crewrouter.api_backend, 'chat_completions');
        break;
      case 'opencode':
        assert.equal(config.model, 'crewrouter/' + model);
        assert.equal(config.provider.crewrouter.npm, '@ai-sdk/openai-compatible');
        assert.deepEqual(config.provider.crewrouter.options, { baseURL: v1, apiKey: options.apiKey });
        assert.deepEqual(config.provider.crewrouter.models[model], { name: model });
        break;
      case 'qwen_code':
        assert.equal(config.model.name, model);
        assert.deepEqual(config.security.auth, { selectedType: 'openai', apiKey: options.apiKey, baseUrl: v1 });
        assert.deepEqual(config.providerProtocol, { crewrouter: 'openai' });
        assert.deepEqual(config.modelProviders.crewrouter, [{ id: model, name: model, baseUrl: v1 }]);
        break;
      case 'hermes':
        assert.deepEqual(config.model, { provider: 'custom:crewrouter', default: model });
        assert.deepEqual(config.providers.crewrouter, {
          base_url: v1, api_key: options.apiKey, transport: 'openai_chat', default_model: model
        });
        assert.equal(output.path, '~/.hermes/config.yaml');
        break;
      case 'openclaw':
        assert.equal(config.agents.defaults.model.primary, 'crewrouter/' + model);
        assert.deepEqual(config.models.providers.crewrouter, {
          baseUrl: v1, apiKey: options.apiKey, api: 'openai-completions', models: [{ id: model, name: model }]
        });
        break;
      case 'deepseek':
        assert.deepEqual(config, { 'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: v1 } });
        assert.match(output.reason, /未核实/);
        assert.match(output.content, /# 配置路径、schema 与端点拼接行为未核实/);
        assert.doesNotMatch(output.content, /适配器请求|必.*拼接/);
        break;
    }
  }
}

async function checkClaudeRoute() {
  const source = fs.readFileSync(path.join(__dirname, '../server/routes/user.js'), 'utf8');
  const start = source.indexOf("router.get('/api-keys/:id/config'");
  const end = source.indexOf('// 获取用户总使用统计', start);
  let handler;
  const routeContext = vm.createContext({
    router: { get: (_path, _auth, callback) => { handler = callback; } },
    requireAuth: () => {},
    getApiKeyAccess: async () => ({ can_manage: true }),
    pool: { query: async () => ({ rows: [{ key_value: 'test-only-key', current_model_id: 'upstream-model' }] }) },
    config: { app: { host: 'example.test' } },
    Logger: { error: () => { throw new Error('配置路由不应记录错误'); } }
  });
  vm.runInContext(source.slice(start, end), routeContext);
  let output;
  await handler({ params: { id: 1 }, session: { user: { id: 1 } } }, { json: value => { output = value; } });
  assert.deepEqual(JSON.parse(JSON.stringify(output)), {
    env: {
      ANTHROPIC_BASE_URL: 'https://example.test', ANTHROPIC_AUTH_TOKEN: 'test-only-key',
      ANTHROPIC_MODEL: 'claude-fable-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-fable-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fable-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-fable-5'
    },
    model: 'claude-fable-5', effortLevel: 'high'
  });
}

async function main() {
  checkConfigs({ baseUrl: 'https://example.test///', apiKey: 'test-only-key' });
  checkConfigs({ baseUrl: 'https://example.test/v1/', apiKey: 'test-only-key', model: 'custom-model' });
  checkConfigs({
    baseUrl: 'https://example.test/"\\\n# injected\t\u0000\u007f/雪',
    apiKey: 'test-only-"\\\n\r\t\b\f\u0000\u0001\u001f\u007f\'$(echo injected)雪😀',
    model: '__proto__'
  });
  checkConfigs({ baseUrl: 'https://example.test', apiKey: 'test-only-key', model: 'model"\\\n\u0000雪😀' });
  const supplied = { env: { ANTHROPIC_BASE_URL: 'https://example.test', ANTHROPIC_AUTH_TOKEN: 'test-only-key' },
    permissions: { defaultMode: 'bypassPermissions' }, effortLevel: 'xhigh' };
  const before = JSON.stringify(supplied);
  assert.deepEqual(JSON.parse(generate('claude', { claudeConfig: supplied }).content), {
    env: {
      ANTHROPIC_BASE_URL: 'https://example.test', ANTHROPIC_AUTH_TOKEN: 'test-only-key',
      ANTHROPIC_MODEL: 'claude-fable-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-fable-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fable-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-fable-5'
    },
    model: 'claude-fable-5', effortLevel: 'high'
  });
  assert.equal(JSON.stringify(supplied), before);
  const unknown = generate('unknown', { baseUrl: 'https://example.test', apiKey: 'test-only-key' });
  assert.equal(unknown.supported, false);
  assert.equal(unknown.content, '');
  for (const invalid of [undefined, {}, { baseUrl: 1, apiKey: 'test-only-key' },
    { baseUrl: 'https://example.test', apiKey: '' },
    { baseUrl: 'https://example.test', apiKey: 'test-only-key', model: '\ud800' }]) {
    assert.throws(() => generate('claude', invalid), /客户端配置参数无效/);
  }
  await checkClaudeRoute();
  console.log('客户端配置测试通过：8 种工具、格式解析、安全转义、Claude 路由。');
}

main().catch(() => {
  console.error('客户端配置测试失败（不输出配置或凭证）。');
  process.exitCode = 1;
});
