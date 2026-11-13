'use strict';

const assert = require('assert');
const { compilePolicy, matchPolicy } = require('../utils/policy/matcher');
const { evaluatePolicies } = require('../utils/policy/engine');
const { DEFAULT_SETTINGS } = require('../utils/policy/cache');
const { buildPolicyErrorBody } = require('../utils/gateway-errors');

function policy(overrides = {}) {
  return compilePolicy({
    id: overrides.id || 1,
    name: overrides.name || 'test',
    description: '',
    scope_type: overrides.scope_type || 'team',
    scope_id: overrides.scope_id === undefined ? 1 : overrides.scope_id,
    effect: overrides.effect || 'deny',
    action: overrides.action || 'block',
    action_options: overrides.action_options || {},
    ladder: overrides.ladder || [],
    priority: overrides.priority || 100,
    category: overrides.category || 'client',
    conditions: overrides.conditions || {},
    status: 'published',
    enabled: true,
    version: 1,
    rollout_percent: overrides.rollout_percent === undefined ? 100 : overrides.rollout_percent,
    status_code: overrides.status_code || 403,
    message_template: overrides.message_template || '',
    starts_at: overrides.starts_at || null,
    ends_at: overrides.ends_at || null,
    bypass_until: null,
  });
}

function signals(overrides = {}) {
  const base = {
    identity: {
      harness: 'claude_code', protocol: 'anthropic', method: 'POST', path: '/v1/messages',
      userAgent: 'claude-cli/1.0.0', stream: false,
    },
    request: {
      model: 'claude-x', modelCandidates: ['claude-x'], maxTokens: 1000, messageCount: 1,
      bodyBytes: 100, tools: [], mcpServers: [], imageCount: 0, hasAttachments: false,
    },
    semantics: { type: 'primary' },
    session: {},
    actor: { userId: 1, teamId: 1, keyId: 1, isAdmin: false, tags: [] },
    network: { ip: '10.1.2.3' },
    now: new Date('2026-11-12T02:00:00Z'),
    getPromptCorpus: () => '',
  };
  return {
    ...base,
    ...overrides,
    identity: { ...base.identity, ...(overrides.identity || {}) },
    request: { ...base.request, ...(overrides.request || {}) },
    actor: { ...base.actor, ...(overrides.actor || {}) },
    network: { ...base.network, ...(overrides.network || {}) },
    semantics: { ...base.semantics, ...(overrides.semantics || {}) },
    session: { ...base.session, ...(overrides.session || {}) },
  };
}

function snapshot(policies, settings = {}) {
  return {
    revision: 1,
    policies,
    globalSettings: { ...DEFAULT_SETTINGS, ...settings },
    teamSettings: new Map(),
    exemptions: [],
  };
}

async function run(cases) {
  const deps = {};
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      throw error;
    }
  }
}

(async () => {
  await run([
    ['client deny blocks claude code', async () => {
      const decision = await evaluatePolicies(signals(), { getSnapshot: async () => snapshot([policy({ conditions: { clients: ['claude_code'] } })]) });
      assert.strictEqual(decision.blocked, true);
      assert.strictEqual(decision.code, 'policy_blocked');
    }],
    ['other client allowed', async () => {
      const decision = await evaluatePolicies(signals({ identity: { harness: 'codex' } }), { getSnapshot: async () => snapshot([policy({ conditions: { clients: ['claude_code'] } })]) });
      assert.strictEqual(decision.blocked, false);
      assert.strictEqual(decision.outcome, 'allow');
    }],
    ['allowlist miss blocks unknown client', async () => {
      const snap = snapshot([policy({ effect: 'allow', action: 'warn', conditions: { clients: ['claude_code'] } })], { allowlist_dimensions: ['clients'] });
      const decision = await evaluatePolicies(signals({ identity: { harness: 'codex' } }), { getSnapshot: async () => snap });
      assert.strictEqual(decision.blocked, true);
      assert.strictEqual(decision.code, 'policy_allowlist_miss');
    }],
    ['allowlist hit allows', async () => {
      const snap = snapshot([policy({ effect: 'allow', action: 'warn', conditions: { clients: ['claude_code'] } })], { allowlist_dimensions: ['clients'] });
      const decision = await evaluatePolicies(signals(), { getSnapshot: async () => snap });
      assert.strictEqual(decision.blocked, false);
    }],
    ['schedule window blocks and allows', async () => {
      const p = policy({
        category: 'time',
        conditions: {
          schedule: {
            timezone: 'Asia/Shanghai',
            weekly: { thu: [['09:00', '18:00']], wed: [], fri: [], sat: [], sun: [], mon: [], tue: [] },
            dates: [], exclude_dates: [],
          },
        },
      });
      const inWindow = await evaluatePolicies(signals({ now: new Date('2026-11-12T02:00:00Z') }), { getSnapshot: async () => snapshot([p]) });
      const outWindow = await evaluatePolicies(signals({ now: new Date('2026-11-12T13:00:00Z') }), { getSnapshot: async () => snapshot([p]) });
      assert.strictEqual(inWindow.blocked, true);
      assert.strictEqual(outWindow.blocked, false);
    }],
    ['ip cidr matches', async () => {
      const p = policy({ category: 'network', conditions: { ips: ['10.0.0.0/8'] } });
      const inside = await evaluatePolicies(signals({ network: { ip: '10.9.8.7' } }), { getSnapshot: async () => snapshot([p]) });
      const outside = await evaluatePolicies(signals({ network: { ip: '203.0.113.9' } }), { getSnapshot: async () => snapshot([p]) });
      assert.strictEqual(inside.blocked, true);
      assert.strictEqual(outside.blocked, false);
    }],
    ['model glob matches', async () => {
      const p = policy({ category: 'model', conditions: { models: ['claude-*'] } });
      const hit = await evaluatePolicies(signals({ request: { model: 'claude-fable-5' } }), { getSnapshot: async () => snapshot([p]) });
      const miss = await evaluatePolicies(signals({ request: { model: 'gpt-5', modelCandidates: ['gpt-5'] } }), { getSnapshot: async () => snapshot([p]) });
      assert.strictEqual(hit.blocked, true);
      assert.strictEqual(miss.blocked, false);
    }],
    ['tools and mcp matching', async () => {
      const p = policy({ category: 'session', conditions: { tools: { names: ['mcp__github__*'] }, mcp_servers: ['github'] } });
      const hit = await evaluatePolicies(signals({ request: { tools: ['mcp__github__create_issue'], mcpServers: ['github'] } }), { getSnapshot: async () => snapshot([p]) });
      const miss = await evaluatePolicies(signals({ request: { tools: ['Read'] , mcpServers: [] } }), { getSnapshot: async () => snapshot([p]) });
      assert.strictEqual(hit.blocked, true);
      assert.strictEqual(miss.blocked, false);
    }],
    ['media and limits', async () => {
      const p = policy({ category: 'content', conditions: { media: { max_images: 0, forbid_attachments: true }, limits: { max_tokens: 500 } } });
      const hit = await evaluatePolicies(signals({ request: { imageCount: 1, maxTokens: 600 } }), { getSnapshot: async () => snapshot([p]) });
      assert.strictEqual(hit.blocked, true);
    }],
    ['prompt regex', async () => {
      const p = policy({ category: 'content', conditions: { prompt: { regex: ['AKIA[0-9A-Z]{16}'] } } });
      const hit = await evaluatePolicies(signals({ getPromptCorpus: () => 'key AKIA1234567890ABCDEF' }), { getSnapshot: async () => snapshot([p]) });
      assert.strictEqual(hit.blocked, true);
    }],
    ['shadow mode does not block', async () => {
      const decision = await evaluatePolicies(signals(), {
        getSnapshot: async () => snapshot([policy({ conditions: { clients: ['claude_code'] } })], { enforcement_mode: 'shadow' }),
      });
      assert.strictEqual(decision.blocked, false);
      assert.strictEqual(decision.action, 'shadow');
    }],
    ['kill switch allows', async () => {
      const decision = await evaluatePolicies(signals(), {
        getSnapshot: async () => snapshot([policy({ conditions: { clients: ['claude_code'] } })], { kill_switch: true }),
      });
      assert.strictEqual(decision.blocked, false);
    }],
    ['rollout 0 skips policy', async () => {
      const decision = await evaluatePolicies(signals(), {
        getSnapshot: async () => snapshot([policy({ conditions: { clients: ['claude_code'] }, rollout_percent: 0 })]),
      });
      assert.strictEqual(decision.blocked, false);
    }],
    ['exemption bypasses policy', async () => {
      const snap = snapshot([policy({ conditions: { clients: ['claude_code'] } })]);
      snap.exemptions = [{
        id: 1, policy_id: null, subject_type: 'user', subject_id: 1, status: 'active',
        starts_at: new Date('2026-01-01T00:00:00Z'), ends_at: null, max_uses: null, used_count: 0,
      }];
      const decision = await evaluatePolicies(signals(), { getSnapshot: async () => snap });
      assert.strictEqual(decision.blocked, false);
      assert.deepStrictEqual(decision.exemptionsApplied, [1]);
    }],
    ['usage condition via queryUsage', async () => {
      const p = policy({ category: 'usage', status_code: 429, conditions: { usage: { metric: 'requests', window: 'day', aggregate: 'member', gte: 10 } } });
      const decision = await evaluatePolicies(signals(), {
        getSnapshot: async () => snapshot([p]),
        queryUsage: async () => 10,
      });
      assert.strictEqual(decision.blocked, true);
      assert.strictEqual(decision.code, 'policy_usage_limit');
      assert.strictEqual(decision.statusCode, 429);
    }],
    ['ladder escalates action', async () => {
      const p = policy({
        conditions: { clients: ['claude_code'] },
        ladder: [{ after_hits: 0, action: 'warn' }, { after_hits: 2, action: 'block' }],
      });
      const deps = { getSnapshot: async () => snapshot([p]) };
      const first = await evaluatePolicies(signals(), deps);
      const second = await evaluatePolicies(signals(), deps);
      const third = await evaluatePolicies(signals(), deps);
      assert.strictEqual(first.action, 'warn');
      assert.strictEqual(second.action, 'block');
      assert.strictEqual(third.action, 'block');
    }],
    ['anthropic error keeps code', async () => {
      const body = buildPolicyErrorBody({ path: '/messages', baseUrl: '/v1' }, 'permission_error', 'blocked', { code: 'policy_blocked', policy_id: 3 }).body;
      assert.strictEqual(body.type, 'error');
      assert.strictEqual(body.error.code, 'policy_blocked');
      assert.strictEqual(body.error.policy_id, 3);
    }],
    ['gemini error maps reason', async () => {
      const built = buildPolicyErrorBody({ path: '/models/x:generateContent', baseUrl: '/v1beta' }, 'permission_error', 'blocked', { code: 'policy_blocked' });
      assert.strictEqual(built.status, 403);
      assert.strictEqual(built.body.error.status, 'PERMISSION_DENIED');
      assert.strictEqual(built.body.error.details[0].reason, 'POLICY_BLOCKED');
    }],
    ['login condition checks method and MFA', async () => {
      const p = compilePolicy({ conditions: { login: { methods: ['password+2fa'], require_mfa: true } } });
      const base = { identity: {}, request: {}, actor: {}, network: {}, now: new Date(), getPromptCorpus: () => '' };
      const hit = await matchPolicy(p, { ...base, login: { method: 'password+2fa', mfa: true, failedAttempts: 0 } });
      const missMethod = await matchPolicy(p, { ...base, login: { method: 'password', mfa: true, failedAttempts: 0 } });
      const missMfa = await matchPolicy(p, { ...base, login: { method: 'password+2fa', mfa: false, failedAttempts: 0 } });
      assert.strictEqual(hit.match, true);
      assert.strictEqual(missMethod.match, false);
      assert.strictEqual(missMfa.match, false);
    }],
    ['country and ASN conditions', async () => {
      const p = compilePolicy({ conditions: { countries: ['CN'], asn: ['4134'] } });
      const base = { identity: {}, request: {}, actor: {}, login: {}, now: new Date(), getPromptCorpus: () => '' };
      const hit = await matchPolicy(p, { ...base, network: { country: 'CN', asn: 'AS4134' } });
      const miss = await matchPolicy(p, { ...base, network: { country: 'US', asn: 'AS4134' } });
      assert.strictEqual(hit.match, true);
      assert.strictEqual(miss.match, false);
    }],
    ['output scan matching', async () => {
      const { matchOutput } = require('../utils/policy/output-scan');
      assert.deepStrictEqual(matchOutput('secret token AKIA1234567890ABCDEF', { contains: ['secret'] }), { type: 'contains', value: 'secret' });
      assert.strictEqual(matchOutput('hello', { contains: ['secret'] }), null);
      assert.strictEqual(matchOutput('key AKIA1234567890ABCDEF', { regex: ['AKIA[0-9A-Z]{16}'] })?.type, 'regex');
    }],
  ]);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
