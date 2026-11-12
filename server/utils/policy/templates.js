'use strict';

const TEMPLATES = [
  {
    key: 'block-claude-code',
    name: '禁止使用 Claude Code',
    description: '阻断所有被识别为 Claude Code 的网关请求，其他客户端不受影响。',
    category: 'client',
    scope_type: 'team',
    effect: 'deny',
    action: 'block',
    priority: 900,
    status_code: 403,
    conditions: { clients: ['claude_code'] },
  },
  {
    key: 'allow-supported-clients',
    name: '仅允许受支持客户端',
    description: '开启客户端白名单，只放行 Claude Code 与 Codex；未知客户端也会被拦截。',
    category: 'client',
    scope_type: 'team',
    effect: 'allow',
    action: 'warn',
    priority: 100,
    conditions: { clients: ['claude_code', 'codex'] },
    settings: { allowlist_dimensions: ['clients'] },
  },
  {
    key: 'work-hours-block',
    name: '工作时段禁止使用',
    description: '周一至周五 09:00-18:00（Asia/Shanghai）禁止所有模型调用。',
    category: 'time',
    scope_type: 'team',
    effect: 'deny',
    action: 'block',
    priority: 500,
    status_code: 403,
    conditions: {
      schedule: {
        timezone: 'Asia/Shanghai',
        weekly: {
          mon: [['09:00', '18:00']],
          tue: [['09:00', '18:00']],
          wed: [['09:00', '18:00']],
          thu: [['09:00', '18:00']],
          fri: [['09:00', '18:00']],
          sat: [],
          sun: [],
        },
        dates: [],
        exclude_dates: [],
      },
    },
  },
  {
    key: 'daily-request-cap',
    name: '每日请求上限 500',
    description: '每个成员自然日请求数达到 500 后拒绝，返回 429。',
    category: 'usage',
    scope_type: 'team',
    effect: 'deny',
    action: 'block',
    priority: 700,
    status_code: 429,
    conditions: {
      usage: { metric: 'requests', window: 'day', aggregate: 'member', gte: 500 },
    },
  },
  {
    key: 'daily-cost-cap',
    name: '每日成本上限 50 积分',
    description: '每个成员自然日消耗达到 50 积分后拒绝。',
    category: 'usage',
    scope_type: 'team',
    effect: 'deny',
    action: 'block',
    priority: 700,
    status_code: 429,
    conditions: {
      budget: { metric: 'cost', period: 'day', aggregate: 'member', gte: 50 },
    },
  },
  {
    key: 'block-subagents',
    name: '禁止子代理请求',
    description: '拒绝被识别为子代理的请求，保留主线程使用。',
    category: 'session',
    scope_type: 'team',
    effect: 'deny',
    action: 'block',
    priority: 600,
    status_code: 403,
    conditions: { semantics: ['subagent'], session: { subagent: true } },
  },
  {
    key: 'block-images',
    name: '禁止图片与附件',
    description: '拒绝包含图片或附件的请求。',
    category: 'content',
    scope_type: 'team',
    effect: 'deny',
    action: 'block',
    priority: 600,
    status_code: 403,
    conditions: { media: { max_images: 0, forbid_attachments: true } },
  },
  {
    key: 'office-ip-allowlist',
    name: '仅允许办公网 IP',
    description: '只放行 10.0.0.0/8 与 192.168.0.0/16，需按实际网段修改。',
    category: 'network',
    scope_type: 'team',
    effect: 'allow',
    action: 'warn',
    priority: 100,
    conditions: { ips: ['10.0.0.0/8', '192.168.0.0/16'] },
    settings: { allowlist_dimensions: ['ips'] },
  },
];

function listTemplates() {
  return TEMPLATES.map(template => ({ ...template }));
}

function getTemplate(key) {
  return listTemplates().find(template => template.key === key) || null;
}

module.exports = { listTemplates, getTemplate };
