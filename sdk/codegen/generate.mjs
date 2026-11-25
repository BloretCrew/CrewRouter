#!/usr/bin/env node
'use strict';

// SDK contract generator.
//
// Inputs:
//   - server/routes/mounts.js          declarative mount table
//   - server/routes/*.js               Express routers (parsed with acorn)
//   - public/js/api-key-permissions.json + server/utils/api-key-permissions.js
//   - server/constants/route-access.js
//
// Outputs (deterministic, committed):
//   - sdk/contract/operations.json
//   - sdk/contract/openapi.json
//   - sdk/typescript/src/generated/operations.ts
//   - docs/api/reference.md
//
// Usage:
//   node sdk/codegen/generate.mjs
//   node sdk/codegen/generate.mjs --check   # fail if outputs are stale

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as acorn from 'acorn';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);

const { REAL_MOUNTS } = require(path.join(ROOT, 'server/routes/mounts.js'));
const { matchPermission } = require(path.join(ROOT, 'server/utils/api-key-permissions.js'));
const {
  isSessionOnly,
  isPublicPath,
  isGatewayOrEventPath,
} = require(path.join(ROOT, 'server/constants/route-access.js'));

const ROUTES_DIR = path.join(ROOT, 'server/routes');
const OUT_MANIFEST = path.join(ROOT, 'sdk/contract/operations.json');
const OUT_OPENAPI = path.join(ROOT, 'sdk/contract/openapi.json');
const OUT_OPENAPI_DOCS = path.join(ROOT, 'docs/api/openapi.json');
const OUT_TS = path.join(ROOT, 'sdk/typescript/src/generated/operations.ts');
const OUT_PY = path.join(ROOT, 'sdk/python/src/crewrouter/generated/operations.py');
const OUT_GO = path.join(ROOT, 'sdk/go/operations_gen.go');
const OUT_REFERENCE = path.join(ROOT, 'docs/api/reference.md');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const value = node[key];
    if (value && typeof value === 'object') walk(value, visit);
  }
}

function literalString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked).join('');
  }
  return null;
}

function requireTarget(node) {
  if (!node || node.type !== 'CallExpression') return null;
  if (node.callee?.type !== 'Identifier' || node.callee.name !== 'require') return null;
  return literalString(node.arguments[0]);
}

function resolveModule(fromFile, request) {
  if (!request || !request.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), request);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function normalizeRoutePath(value) {
  let route = String(value || '').trim();
  if (!route) return '/';
  if (!route.startsWith('/')) route = `/${route}`;
  // Express path-to-regexp constraints are irrelevant for the contract surface.
  route = route.replace(/:[A-Za-z0-9_]+(?:\([^)]*\))?/g, (match) => {
    const name = match.slice(1).split('(')[0];
    return `:${name}`;
  });
  return route.replace(/\/{2,}/g, '/');
}

function joinPath(prefix, route) {
  const base = prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  const suffix = route === '/' ? '' : route;
  const joined = `${base}${suffix}` || '/';
  return joined.replace(/\/{2,}/g, '/') || '/';
}

function parseFile(file, prefix, visited, collected) {
  if (visited.has(file)) return;
  visited.add(file);
  const source = fs.readFileSync(file, 'utf8');
  if (!/express\.Router\(\)|Router\(\)/.test(source)) return;

  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    });
  } catch (error) {
    throw new Error(`Failed to parse ${path.relative(ROOT, file)}: ${error.message}`);
  }

  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression' || callee.computed) return;

    const objectName = callee.object?.type === 'Identifier' ? callee.object.name : null;
    const method = callee.property?.type === 'Identifier' ? callee.property.name : null;
    if (objectName !== 'router' || !method) return;

    if (HTTP_METHODS.has(method)) {
      const route = literalString(node.arguments[0]);
      if (!route) return;
      collected.push({
        file,
        method: method.toUpperCase(),
        route: normalizeRoutePath(route),
        fullPath: joinPath(prefix, normalizeRoutePath(route)),
        streaming: source.includes('text/event-stream'),
      });
      return;
    }

    // router.route('/x').get(...).post(...)
    if (method === 'route') {
      const route = literalString(node.arguments[0]);
      if (!route) return;
      const tail = source.slice(node.end, node.end + 400);
      for (const verb of HTTP_METHODS) {
        if (new RegExp(`\\.${verb}\\(`).test(tail)) {
          collected.push({
            file,
            method: verb.toUpperCase(),
            route: normalizeRoutePath(route),
            fullPath: joinPath(prefix, normalizeRoutePath(route)),
            streaming: source.includes('text/event-stream'),
          });
        }
      }
      return;
    }

    if (method !== 'use') return;
    let childPrefix = prefix;
    let index = 0;
    const first = node.arguments[0];
    if (literalString(first) !== null) {
      childPrefix = joinPath(prefix, normalizeRoutePath(literalString(first)));
      index = 1;
    } else if (first?.type === 'ArrayExpression') {
      const paths = first.elements.map(literalString).filter((value) => value !== null);
      if (paths.length) {
        for (const childPath of paths) {
          for (let argIndex = 1; argIndex < node.arguments.length; argIndex += 1) {
            const target = requireTarget(node.arguments[argIndex]);
            const childFile = resolveModule(file, target);
            if (childFile) parseFile(childFile, joinPath(prefix, normalizeRoutePath(childPath)), visited, collected);
          }
        }
        return;
      }
    }
    for (; index < node.arguments.length; index += 1) {
      const target = requireTarget(node.arguments[index]);
      const childFile = resolveModule(file, target);
      if (childFile) parseFile(childFile, childPrefix, visited, collected);
    }
  });
}

function camel(value) {
  return String(value)
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ''))
    .replace(/^[A-Z]/, (ch) => ch.toLowerCase());
}

const ACTION_SUFFIX = /^(refresh|ping|test|sync|fetch|cleanup|toggle|enable|disable|reset|verify|approve|revoke|rotate|run|purge|compress|check|apply|upload|redeem|read|seen|join|leave|summary|search|cancel|batch|import|export|order|analyze|fix|add|remove|reorder|star|hide|publish|grant)(?:-|$)/;
const GATEWAY_CANONICAL = /^\/v1\/(?:chat\/completions|messages|responses|models)$/;

function operationName(fullPath, method) {
  const isGateway = GATEWAY_CANONICAL.test(fullPath);
  let segments = fullPath.replace(/^\/v1\//, '').replace(/^\/api\//, '').split('/').filter(Boolean);
  if (segments.length === 0) segments = ['root'];

  const namespace = camel(segments.shift() || 'root');
  let actionVerb = null;
  const lastRaw = segments[segments.length - 1];
  if (lastRaw && !lastRaw.startsWith(':') && ACTION_SUFFIX.test(lastRaw)) {
    actionVerb = camel(lastRaw);
    segments.pop();
  }

  const resources = [];
  for (const segment of segments) {
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      resources.push(`by${camel(name).replace(/^./, (ch) => ch.toUpperCase())}`);
    } else {
      resources.push(camel(segment));
    }
  }

  const last = segments[segments.length - 1] || '';
  let verb;
  if (actionVerb) verb = actionVerb;
  else if (method === 'GET') verb = last.startsWith(':') ? 'get' : 'list';
  else if (method === 'POST') verb = 'create';
  else if (method === 'PUT' || method === 'PATCH') verb = 'update';
  else if (method === 'DELETE') verb = 'delete';
  else verb = method.toLowerCase();

  let id = [namespace, ...resources, verb].filter(Boolean).join('.');
  if (isGateway) id = `gateway.${id}`;
  return id.replace(/\.+/g, '.').replace(/\.$/, '');
}

function classify(mount, entry) {
  const fullPath = entry.fullPath;
  const sessionOnly = isSessionOnly(fullPath);
  const publicPath = isPublicPath(fullPath);
  const gatewayOrEvent = isGatewayOrEventPath(fullPath);
  const permission = sessionOnly ? null : matchPermission(entry.method, fullPath);
  const dynamic = fullPath.includes('*');
  const streaming = entry.method === 'POST' && /\/v1\/(?:chat\/completions|messages|responses)$/.test(fullPath);

  let authModes;
  if (sessionOnly) authModes = ['session'];
  else if (publicPath) authModes = [];
  else if (gatewayOrEvent) authModes = ['api_key', 'oauth'];
  else if (permission) authModes = ['api_key', 'session'];
  else authModes = ['session'];

  let sdkStatus = 'generated';
  let exclusion = null;
  if (sessionOnly) {
    sdkStatus = 'excluded';
    exclusion = 'session_only';
  } else if (dynamic) {
    sdkStatus = 'manual';
  } else if (streaming) {
    sdkStatus = 'manual';
  } else if (!permission && !publicPath && !gatewayOrEvent) {
    sdkStatus = 'excluded';
    exclusion = 'permission_not_configured';
  } else if (mount.feature === 'demo') {
    sdkStatus = 'excluded';
    exclusion = 'demo_only';
  }

  return {
    permission,
    adminOnly: false,
    authModes,
    streaming,
    dynamic,
    sdkStatus,
    exclusion,
  };
}

function collectOperations() {
  const operations = [];
  const seen = new Set();

  for (const mount of REAL_MOUNTS) {
    if (mount.runtime === 'nested' || mount.runtime === 'demo') continue;
    const modulePath = path.resolve(ROUTES_DIR, mount.module);
    const file = fs.existsSync(modulePath) ? modulePath : `${modulePath}.js`;
    if (!fs.existsSync(file)) continue;
    const collected = [];
    parseFile(file, mount.mount, new Set(), collected);
    for (const entry of collected) {
      const key = `${entry.method} ${entry.fullPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const info = classify(mount, entry);
      operations.push({
        operationId: operationName(entry.fullPath, entry.method),
        method: entry.method,
        path: entry.fullPath,
        aliases: [],
        module: path.relative(ROOT, entry.file),
        mount: mount.mount,
        feature: mount.feature,
        permission: info.permission?.id || null,
        permissionGroup: info.permission?.group || null,
        adminOnly: info.permission?.adminOnly === true,
        authModes: info.authModes,
        streaming: info.streaming,
        dynamic: info.dynamic,
        request: {
          body: ['POST', 'PUT', 'PATCH'].includes(entry.method) ? 'json' : null,
          contentTypes: ['POST', 'PUT', 'PATCH'].includes(entry.method) ? ['application/json'] : [],
          schemaRef: null,
        },
        response: {
          kind: info.streaming ? 'sse' : 'json',
          schemaRef: null,
          schemaStatus: 'untyped',
        },
        limits: { body: mount.feature === 'gateway' ? '50mb' : '2mb' },
        sdkStatus: info.sdkStatus,
        exclusion: info.exclusion,
        contractVersion: 1,
      });
    }
  }

  // /v1 and /api mount the same router. Canonical paths:
  //   - gateway completions/models -> /v1/*
  //   - everything else (cache, etc.) -> /api/*
  // The non-canonical twin is kept in the manifest as an excluded alias so
  // coverage checks still see it, but generated method trees stay unique.
  for (const op of operations) {
    if (op.path.startsWith('/api/')) {
      const canonicalPath = op.path.replace(/^\/api\//, '/v1/');
      if (!GATEWAY_CANONICAL.test(canonicalPath)) continue;
      const canonical = operations.find((candidate) => candidate.method === op.method && candidate.path === canonicalPath);
      if (canonical) {
        canonical.aliases.push(op.path);
        op.sdkStatus = 'excluded';
        op.exclusion = 'alias';
      }
    } else if (op.path.startsWith('/v1/') && !GATEWAY_CANONICAL.test(op.path)) {
      const canonicalPath = op.path.replace(/^\/v1\//, '/api/');
      const canonical = operations.find((candidate) => candidate.method === op.method && candidate.path === canonicalPath);
      if (canonical) {
        canonical.aliases.push(op.path);
        op.sdkStatus = 'excluded';
        op.exclusion = 'alias';
      }
    }
  }

  const filtered = operations;

  // Stable operationIds with deterministic collision suffixes. Aliases do not
  // participate in naming so they cannot steal a canonical method name.
  const used = new Map();
  for (const op of filtered.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`))) {
    if (op.sdkStatus === 'excluded' && op.exclusion === 'alias') {
      op.operationId = `${op.operationId}.alias`;
      continue;
    }
    const base = op.operationId;
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    if (count > 0) op.operationId = `${base}${count + 1}`;
  }

  return filtered.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

function openApiPath(expressPath) {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function managementSchemas() {
  const nullableString = { type: ['string', 'null'] };
  const numberOrString = { oneOf: [{ type: 'number' }, { type: 'string' }] };
  const object = (properties, required = []) => ({
    type: 'object', properties, required, additionalProperties: true,
  });
  return {
    ApiKeyTag: object({ id: { oneOf: [{ type: 'integer' }, { type: 'string' }] }, name: { type: 'string' }, color: nullableString }, ['id', 'name']),
    ApiKeyModelQueueItem: object({
      model_id: { type: 'string' }, name: nullableString, sort_order: { type: 'integer' },
    }, ['model_id']),
    ApiKeyHarnessModel: object({
      harness: { type: 'string' }, model_id: { type: 'string' }, name: { type: 'string' },
      provider_name: { type: 'string' }, label: { type: 'string' },
    }, ['harness', 'model_id', 'name', 'provider_name', 'label']),
    AvailableHarness: object({ id: { type: 'string' }, label: { type: 'string' } }, ['id', 'label']),
    ApiKeyHarnessModelsResponse: object({
      harness_models: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyHarnessModel' } },
      available_harnesses: { type: 'array', items: { $ref: '#/components/schemas/AvailableHarness' } },
    }, ['harness_models', 'available_harnesses']),
    RequestModelBinding: object({
      request_model_name: { type: 'string' }, harness: nullableString, model_id: { type: 'string' },
      name: { type: 'string' }, provider_name: { type: 'string' },
    }, ['request_model_name', 'model_id', 'name', 'provider_name']),
    RequestModelBindingTarget: object({
      id: { type: 'string' }, name: { type: 'string' }, alias: nullableString, upstream_model_id: nullableString,
    }, ['id', 'name']),
    ApiKeyRequestModelBindingsResponse: object({
      bindings: { type: 'array', items: { $ref: '#/components/schemas/RequestModelBinding' } },
      models: { type: 'array', items: { $ref: '#/components/schemas/RequestModelBindingTarget' } },
      available_harnesses: { type: 'array', items: { $ref: '#/components/schemas/AvailableHarness' } },
    }, ['bindings', 'models', 'available_harnesses']),
    ApiKeyRequestModelBinding: object({
      request_model_name: { type: 'string' }, harness: nullableString, model_id: { type: 'string' },
      name: nullableString, provider_name: nullableString,
    }, ['request_model_name', 'model_id']),
    ApiKeyMember: object({
      id: { type: 'integer' }, username: { type: 'string' }, email: nullableString,
    }, ['id', 'username']),
    ApiKeyOwner: object({
      id: { type: 'integer' }, username: { type: 'string' }, email: nullableString,
    }, ['id', 'username']),
    ApiKeyListItem: object({
      id: { type: 'integer' }, name: { type: 'string' }, key_group: { type: 'string' },
      key_prefix: nullableString,
      key_value: { ...nullableString, description: 'Redacted as null unless the credential has keys.secret and the key is owned by the caller.' },
      permissions: { type: 'array', items: { type: 'string' } },
      custom_model_name: { type: 'string' }, current_model_id: nullableString,
      current_model_name: nullableString, current_model_provider_name: nullableString,
      is_system: { type: 'boolean' }, created_at: nullableString, last_used_at: nullableString,
      expires_at: nullableString, signature_enabled: { type: 'boolean' }, signature_template: { type: 'string' },
      api_signature_enabled: { type: 'boolean' }, api_signature_template: { type: 'string' },
      quota_warning_enabled: { type: 'boolean' }, swallow_images: { type: 'boolean' },
      crewrouter_commands: { type: 'boolean' }, enabled: { type: 'boolean' },
      schedule_enabled: { type: 'boolean' }, schedule_on_time: nullableString, schedule_off_time: nullableString,
      schedule_days: { type: 'array', items: { type: 'integer' } }, schedule_timezone: nullableString,
      current_model_test_ok: { type: ['boolean', 'null'] }, current_model_test_latency_ms: { type: ['integer', 'null'] },
      current_model_test_tokens_per_second: { type: ['number', 'null'] }, current_model_test_tested_at: nullableString,
      total_tokens: numberOrString, total_cost: numberOrString, total_requests: numberOrString,
      tags: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyTag' } },
      model_queue: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyQueueItem' } },
      harness_models: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyHarnessModel' } },
      request_model_bindings: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyRequestModelBinding' } },
      owner: { anyOf: [{ $ref: '#/components/schemas/ApiKeyOwner' }, { type: 'null' }] },
      members: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyMember' } },
      member_count: { type: 'integer' }, is_owner: { type: 'boolean' }, is_co_key: { type: 'boolean' },
      key_type: { type: 'string', enum: ['normal', 'co_key'] },
      co_key_role: { type: ['string', 'null'], enum: ['owner', 'member', null] },
    }, ['id', 'name', 'key_value', 'permissions', 'enabled', 'tags', 'model_queue']),
    DailyUsageItem: object({
      date: { type: 'string', format: 'date' }, total_tokens: numberOrString,
      total_cost: numberOrString, total_requests: numberOrString,
    }, ['date', 'total_tokens', 'total_cost', 'total_requests']),
    ApiKeyDailyUsageItem: object({
      date: { type: 'string', format: 'date' }, model_id: { type: 'string' },
      model_name: nullableString, tokens: numberOrString, cost: numberOrString, requests: numberOrString,
    }, ['date', 'model_id', 'tokens', 'cost', 'requests']),
    UserKeyTag: object({
      id: { type: 'integer' }, name: { type: 'string' }, color: { type: 'string' },
      sort_order: { type: 'integer' }, created_at: { type: 'string', format: 'date-time' },
    }, ['id', 'name', 'color', 'sort_order', 'created_at']),
    ApiKeyMember: object({
      id: { type: 'integer' }, username: { type: 'string' }, email: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
    }, ['id', 'username', 'email', 'created_at']),
    ApiKeyMembersResponse: object({
      is_owner: { type: 'boolean' },
      members: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyMember' } },
    }, ['is_owner', 'members']),
    ApiKeyQuotaWarning: object({ quota_warning_enabled: { type: 'boolean' } }),
    ApiKeyFusionConfig: object({
      panel_models: { type: 'array', items: { type: 'string' } },
      judge_model_id: { type: 'string' }, outer_model_id: { type: 'string' },
      fusion_enabled: { type: 'boolean' }, fusion_synthesis_prompt_enabled: { type: 'boolean' },
    }, ['panel_models', 'judge_model_id', 'outer_model_id', 'fusion_enabled', 'fusion_synthesis_prompt_enabled']),
    ApiKeyFusionConfigPut: object({
      panel_models: { type: 'array', maxItems: 10, items: { type: 'string' } },
      judge_model_id: { type: 'string' }, outer_model_id: { type: 'string' },
      fusion_enabled: { type: 'boolean' }, fusion_synthesis_prompt_enabled: { type: 'boolean' },
    }, ['panel_models']),
    ApiKeyActionSuccess: object({ success: { const: true } }),
    ApiKeyEnabledUpdateResponse: object({ success: { const: true }, enabled: { type: 'boolean' } }),
    ApiKeySwallowImagesUpdateResponse: object({ success: { const: true }, swallow_images: { type: 'boolean' } }),
    ApiKeyCommandsUpdateResponse: object({ success: { const: true }, crewrouter_commands: { type: 'boolean' } }),
    ApiKeyEnabledUpdateResponse: object({ success: { const: true }, enabled: { type: 'boolean' } }),
    ApiKeySwallowImagesUpdateResponse: object({ success: { const: true }, swallow_images: { type: 'boolean' } }),
    ApiKeyCommandsUpdateResponse: object({ success: { const: true }, crewrouter_commands: { type: 'boolean' } }),
    ApiKeyClaudeConfig: object({
      env: object({
        ANTHROPIC_BASE_URL: { type: 'string' },
        ANTHROPIC_AUTH_TOKEN: { type: 'string', description: 'Contains the API Key secret. Only the key owner can retrieve this configuration; never log or expose it.' },
        ANTHROPIC_MODEL: { type: 'string' },
        ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: 'string' },
        ANTHROPIC_DEFAULT_SONNET_MODEL: { type: 'string' },
        ANTHROPIC_DEFAULT_OPUS_MODEL: { type: 'string' },
      }),
      model: { type: 'string' }, effortLevel: { type: 'string' },
    }, ['env', 'model', 'effortLevel']),
    ApiKeySchedule: object({
      schedule_enabled: { type: 'boolean' }, schedule_on_time: nullableString,
      schedule_off_time: nullableString, schedule_days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
      schedule_timezone: { type: 'string' },
    }, ['schedule_enabled', 'schedule_on_time', 'schedule_off_time', 'schedule_days', 'schedule_timezone']),
    CurrentModel: object({
      id: { type: 'string' }, name: { type: 'string' }, provider: { type: 'string' },
      series: nullableString, description: nullableString,
    }, ['id', 'name', 'provider']),
    CurrentModelResponse: object({
      currentModel: { anyOf: [{ $ref: '#/components/schemas/CurrentModel' }, { type: 'null' }] },
    }, ['currentModel']),
    AdminUser: object({
      id: { type: 'integer' }, username: { type: 'string' }, email: nullableString,
      email_verified: { type: 'boolean' }, avatar: nullableString, balance: numberOrString,
      refund_balance: numberOrString, is_admin: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'object', additionalProperties: true } },
      rate_limit_rpm: { type: 'integer' }, rate_limit_tpm: numberOrString,
      created_at: { type: 'string', format: 'date-time' }, team_id: { type: ['integer', 'null'] }, team_name: nullableString,
    }, ['id', 'username', 'email_verified', 'is_admin', 'created_at']),
    AdminUserStats: object({ adminCount: { type: 'integer' }, verifiedCount: { type: 'integer' }, totalBalance: { type: 'number' } }, ['adminCount', 'verifiedCount', 'totalBalance']),
    AdminUsersPage: object({
      items: { type: 'array', items: { $ref: '#/components/schemas/AdminUser' } },
      total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' },
      stats: { $ref: '#/components/schemas/AdminUserStats' },
    }, ['items', 'total', 'page', 'limit', 'stats']),
    AdminUsageLog: object({
      id: { type: 'integer' }, user_id: { type: 'integer' }, model_id: nullableString,
      api_key_id: { type: ['integer', 'null'] }, tokens_used: { type: ['integer', 'string', 'null'] },
      prompt_tokens: { type: ['integer', 'string', 'null'] }, completion_tokens: { type: ['integer', 'string', 'null'] },
      cached_tokens: { type: ['integer', 'string', 'null'] }, provider_id: { type: ['string', 'null'] },
      request_type: nullableString, request_source: { type: 'string' }, user_agent: nullableString,
      latency_ms: { type: ['number', 'string', 'null'] }, ip_address: nullableString,
      custom_instruction_count: { type: 'integer' }, cost: { type: ['number', 'string', 'null'] },
      created_at: { type: 'string', format: 'date-time' }, username: nullableString,
      key_prefix: nullableString, key_name: nullableString, series: nullableString,
      model_name: nullableString, upstream_model_id: nullableString, requested_model: nullableString,
      resolved_model: nullableString, response_model: nullableString, provider_name: nullableString,
    }, ['id', 'user_id', 'request_source', 'custom_instruction_count', 'created_at']),
    AdminUsageLogsResponse: object({
      total: { type: 'integer' }, page: { type: 'integer' },
      logs: { type: 'array', items: { $ref: '#/components/schemas/AdminUsageLog' } },
    }, ['total', 'page', 'logs']),
    AdminStatsFilterOption: object({
      id: { oneOf: [{ type: 'integer' }, { type: 'string' }] }, name: { type: 'string' },
    }, ['id', 'name']),
    AdminStatsFiltersResponse: object({
      users: { type: 'array', items: { $ref: '#/components/schemas/AdminStatsFilterOption' } },
      teams: { type: 'array', items: { $ref: '#/components/schemas/AdminStatsFilterOption' } },
      models: { type: 'array', items: { $ref: '#/components/schemas/AdminStatsFilterOption' } },
      providers: { type: 'array', items: { $ref: '#/components/schemas/AdminStatsFilterOption' } },
      sources: { type: 'array', items: { $ref: '#/components/schemas/AdminStatsFilterOption' } },
      projects: { type: 'array', items: { $ref: '#/components/schemas/AdminStatsFilterOption' } },
    }, ['users', 'teams', 'models', 'providers', 'sources', 'projects']),
    AdminProduct: object({
      id: { type: 'integer' }, name: { type: 'string' }, description: nullableString,
      price: numberOrString, image_url: nullableString, link: nullableString,
      is_active: { type: 'boolean' }, sort_order: { type: 'integer' },
      created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
    }, ['id', 'name', 'is_active', 'sort_order', 'created_at', 'updated_at']),
    TeamMember: object({
      id: { type: 'integer' }, username: { type: 'string' }, email: nullableString,
      avatar: nullableString, created_at: { type: 'string', format: 'date-time' },
    }, ['id', 'username', 'created_at']),
    TeamModelListItem: object({
      mapping_id: { type: ['integer', 'null'] }, enabled: { type: 'boolean' },
      model_id: { type: 'string' }, name: { type: 'string' }, provider: nullableString,
      series: nullableString, description: nullableString,
      input_price_per_1k_tokens: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
      output_price_per_1k_tokens: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
      icon_url: nullableString, upstream_model_id: nullableString, alias: nullableString,
      model_multiplier: numberOrString, test_ok: { type: ['boolean', 'null'] },
      test_latency_ms: { type: ['number', 'string', 'null'] }, test_tokens_per_second: { type: ['number', 'string', 'null'] },
      test_error: nullableString, test_tested_at: nullableString,
      provider_id: nullableString, provider_name: nullableString, provider_enabled: { type: ['boolean', 'null'] },
    }, ['enabled', 'model_id', 'name']),
    UserUsageLog: object({
      id: { type: 'integer' }, user_id: { type: 'integer' }, model_id: nullableString,
      api_key_id: { type: ['integer', 'null'] }, tokens_used: { type: ['integer', 'string', 'null'] },
      prompt_tokens: { type: ['integer', 'string', 'null'] }, completion_tokens: { type: ['integer', 'string', 'null'] },
      cached_tokens: { type: ['integer', 'string', 'null'] }, provider_id: { type: ['string', 'null'] },
      request_type: nullableString, request_source: { type: 'string' }, user_agent: nullableString,
      latency_ms: { type: ['number', 'string', 'null'] }, ip_address: nullableString,
      cost: { type: ['number', 'string', 'null'] }, created_at: { type: 'string', format: 'date-time' },
      key_prefix: nullableString, key_name: nullableString, series: nullableString,
      model_name: nullableString, upstream_model_id: nullableString, requested_model: nullableString,
      resolved_model: nullableString, response_model: nullableString, provider_name: nullableString,
    }, ['id', 'user_id', 'request_source', 'created_at']),
    UserUsageLogsResponse: object({
      total: { type: 'integer' }, page: { type: 'integer' },
      logs: { type: 'array', items: { $ref: '#/components/schemas/UserUsageLog' } },
    }, ['total', 'page', 'logs']),
    UserUsageLogDetail: {
      allOf: [
        { $ref: '#/components/schemas/UserUsageLog' },
        object({
          is_stream: { type: ['boolean', 'null'] }, ttft_ms: numberOrString,
          upstream_first_byte_ms: numberOrString, generation_ms: numberOrString, tpot_ms: numberOrString,
          output_tps: numberOrString, e2e_ms: numberOrString, upstream_processing_ms: numberOrString,
          service_tier: nullableString, rate_limit: {}, messages: {}, response: {},
        }),
      ],
      description: 'Detailed user-owned usage record. messages and response are opaque upstream JSON and may contain sensitive/high-volume data.',
    },
    UserUsageLogDetailResponse: object({
      log: { $ref: '#/components/schemas/UserUsageLogDetail' },
    }, ['log']),
    AdminUsageLog: {
      allOf: [
        { $ref: '#/components/schemas/UserUsageLog' },
        object({ username: nullableString, custom_instruction_count: { type: 'integer' } }, ['custom_instruction_count']),
      ],
      description: 'Administrator-visible usage record. Restricted to authenticated administrators.',
    },
    AdminUsageLogsResponse: object({
      total: { type: 'integer' }, page: { type: 'integer' },
      logs: { type: 'array', items: { $ref: '#/components/schemas/AdminUsageLog' } },
    }, ['total', 'page', 'logs']),
    StatsFilterOption: object({ id: { type: 'string' }, name: { type: 'string' } }, ['id', 'name']),
    StatsFilterTeam: object({ id: { type: 'integer' }, name: { type: 'string' } }, ['id', 'name']),
    UserStatsFiltersResponse: object({
      sources: { type: 'array', items: { $ref: '#/components/schemas/StatsFilterOption' } },
      models: { type: 'array', items: { $ref: '#/components/schemas/StatsFilterOption' } },
      providers: { type: 'array', items: { $ref: '#/components/schemas/StatsFilterOption' } },
      teams: { type: 'array', items: { $ref: '#/components/schemas/StatsFilterTeam' } },
    }, ['sources', 'models', 'providers', 'teams']),
    ProviderQuotaSummary: {
      type: 'object',
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, quota: {}, keys: { type: 'array', items: {} },
        aggregated: {}, cached: { type: 'boolean' }, checked_at: nullableString, last_attempt_at: nullableString,
        last_valid_at: nullableString, status: { type: 'string' }, coverage: {}, stale: { type: 'boolean' },
        error: { type: 'string' }, history: {},
      },
      required: ['id', 'name', 'quota', 'keys', 'aggregated', 'cached', 'checked_at', 'last_attempt_at', 'last_valid_at', 'status', 'coverage', 'stale'],
      additionalProperties: true,
      description: 'Outer status fields are stable. Quota, key and coverage payloads are provider-specific and intentionally opaque.',
    },
    UserProviderQuotaResponse: object({
      providers: { type: 'array', items: { $ref: '#/components/schemas/ProviderQuotaSummary' } },
    }, ['providers']),
    ApiKeyQueueItem: object({
      model_id: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' },
      provider: nullableString, series: nullableString, icon_url: nullableString, sort_order: { type: 'integer' },
    }, ['model_id', 'id', 'name', 'sort_order']),
    ApiKeyAvailableModel: object({
      id: { type: 'string' }, name: { type: 'string' }, provider: { type: 'string' },
      series: nullableString, description: nullableString, enabled: { type: 'boolean' }, icon_url: nullableString,
      input_price_per_1k_tokens: numberOrString, output_price_per_1k_tokens: numberOrString,
      assigned: { type: 'boolean' }, sort_order: { type: ['integer', 'null'] },
    }, ['id', 'name', 'provider', 'enabled', 'assigned']),
    ApiKeyModelsResponse: object({
      models: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyAvailableModel' } },
      queue: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyQueueItem' } },
    }, ['models', 'queue']),
    ApiKeyModelsUpdateResponse: object({
      success: { const: true }, modelIds: { type: 'array', items: { type: 'string' } },
      current_model_id: nullableString,
    }, ['success', 'modelIds', 'current_model_id']),
    ApiKeyTagsResponse: object({ tags: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyTag' } } }, ['tags']),
    UserModelListItem: object({
      id: { type: 'string' }, upstream_model_id: { type: 'string' }, name: { type: 'string' },
      alias: nullableString, provider: { type: 'string' }, provider_name: { type: 'string' },
      input_price_per_1k_tokens: numberOrString, output_price_per_1k_tokens: numberOrString,
      output_kind: { type: 'string' },
    }, ['id', 'upstream_model_id', 'name', 'provider', 'provider_name', 'output_kind']),
    UserModelInfo: object({
      model_id: { type: 'string' }, name: { type: 'string' }, alias: nullableString,
      series: nullableString, description: nullableString,
      input_price_per_1k_tokens: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
      output_price_per_1k_tokens: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
      cached_output_price_per_1k_tokens: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
      reference_input_price_per_1k_tokens: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
      reference_output_price_per_1k_tokens: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
      rate_limit_rpm: { type: ['integer', 'null'] }, rate_limit_tpm: { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }] },
      icon_url: nullableString, series_icon_url: nullableString, created_by: { type: ['integer', 'null'] },
      enabled: { type: 'boolean' }, billing_mode: nullableString,
      model_multiplier: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
      completion_multiplier: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
      thinking_model_id: nullableString, non_thinking_model_id: nullableString,
      upstream_model_id: { type: 'string' }, provider_id: { type: 'string' }, provider_name: { type: 'string' },
      test_ok: { type: ['boolean', 'null'] }, test_latency_ms: { type: ['number', 'string', 'null'] },
      test_tokens_per_second: { type: ['number', 'string', 'null'] }, test_total_tokens: numberOrString,
      test_error: nullableString, test_tested_at: nullableString,
    }, ['model_id', 'name', 'enabled', 'upstream_model_id', 'provider_id', 'provider_name']),
    UserProviderListItem: object({
      id: { type: 'string' }, name: { type: 'string' },
      format: { type: 'string', enum: ['openai', 'anthropic', 'responses', 'gemini'] },
      created_by: { type: ['integer', 'null'] },
    }, ['id', 'name', 'format', 'created_by']),
    UserProduct: object({
      id: { type: 'integer' }, name: { type: 'string' }, description: nullableString,
      image_url: nullableString, link: nullableString, sort_order: { type: 'integer' },
    }, ['id', 'name', 'sort_order']),
    ProviderTag: object({
      id: { type: 'integer' }, name: { type: 'string' }, color: { type: 'string' },
      sort_order: { type: 'integer' },
    }, ['id', 'name', 'color', 'sort_order']),
    AdminProviderTag: object({
      id: { type: 'integer' }, name: { type: 'string' }, color: { type: 'string' },
      sort_order: { type: 'integer' }, created_at: { type: 'string', format: 'date-time' },
    }, ['id', 'name', 'color', 'sort_order']),
    AdminProviderTagUpdateResponse: object({ id: { type: 'integer' }, name: { type: 'string' }, color: { type: 'string' }, sort_order: { type: 'integer' } }, ['id', 'name', 'color', 'sort_order']),
    UserCodeBalanceItem: object({
      amount: numberOrString, fee_rate: numberOrString, code: { type: 'string' },
      code_amount: numberOrString, net_amount: numberOrString,
    }, ['amount', 'fee_rate', 'code', 'code_amount', 'net_amount']),
    ModelUptimeSummaryItem: object({
      uptime_pct: { type: ['number', 'null'] }, label: { type: 'string' },
      total_success: { type: 'integer' }, total_fail: { type: 'integer' },
      spark: { type: 'array', items: { type: 'string', enum: ['none', 'ok', 'degraded', 'outage'] } },
    }, ['uptime_pct', 'label', 'total_success', 'total_fail', 'spark']),
    ModelUptimeDailyResponse: object({
      days: { type: 'integer' }, granularity: { const: 'day' },
      items: { type: 'object', additionalProperties: { $ref: '#/components/schemas/ModelUptimeSummaryItem' } },
    }, ['days', 'granularity', 'items']),
    ModelUptimeSlotResponse: object({
      days: { const: 1 }, hours: { const: 24 }, slots: { type: 'integer' }, granularity: { const: '15m' },
      items: { type: 'object', additionalProperties: { $ref: '#/components/schemas/ModelUptimeSummaryItem' } },
    }, ['days', 'hours', 'slots', 'granularity', 'items']),
    ModelUptimeDetailPoint: object({
      date: { type: 'string', format: 'date-time' },
      status: { type: 'string', enum: ['none', 'ok', 'degraded', 'outage'] },
      success: { type: 'integer' }, fail: { type: 'integer' },
    }, ['date', 'status', 'success', 'fail']),
    ModelUptimeDailyDetail: object({
      model_id: { type: 'string' }, uptime_pct: { type: ['number', 'null'] },
      label: { type: 'string' }, total_success: { type: 'integer' }, total_fail: { type: 'integer' },
      granularity: { const: 'day' }, days: { type: 'array', items: { $ref: '#/components/schemas/ModelUptimeDetailPoint' } },
    }, ['model_id', 'uptime_pct', 'label', 'total_success', 'total_fail', 'granularity', 'days']),
    ModelUptimeSlotDetail: object({
      model_id: { type: 'string' }, uptime_pct: { type: ['number', 'null'] },
      label: { type: 'string' }, total_success: { type: 'integer' }, total_fail: { type: 'integer' },
      granularity: { const: '15m' }, hours: { const: 24 }, slots: { type: 'integer' },
      days: { type: 'array', items: { $ref: '#/components/schemas/ModelUptimeDetailPoint' } },
    }, ['model_id', 'uptime_pct', 'label', 'total_success', 'total_fail', 'granularity', 'hours', 'slots', 'days']),
    ModelUptimeDetailResponse: {
      oneOf: [
        { $ref: '#/components/schemas/ModelUptimeDailyDetail' },
        { $ref: '#/components/schemas/ModelUptimeSlotDetail' },
      ],
    },
    ModelUptimeResponse: {
      oneOf: [
        { $ref: '#/components/schemas/ModelUptimeDailyResponse' },
        { $ref: '#/components/schemas/ModelUptimeSlotResponse' },
      ],
    },
    TeamQuotaRule: {
      type: 'object',
      properties: {
        id: { type: 'string' }, rule_type: { type: 'string', enum: ['requests', 'tokens'] },
        rule_value: numberOrString, duration_hours: { type: 'number' }, description: { type: 'string' },
      },
      required: ['rule_type'],
      additionalProperties: true,
      description: 'Legacy Team quota rules may omit id/value fields or carry extension fields; newly created rules populate id, rule_value and duration_hours.',
    },
    TeamQuotaRuleCreateRequest: object({
      rule_type: { type: 'string', enum: ['requests', 'tokens'] }, rule_value: numberOrString,
      duration_hours: { type: 'number', exclusiveMinimum: 0 }, description: { type: 'string' },
    }, ['rule_type', 'rule_value', 'duration_hours']),
    TeamQuotaRuleCreated: object({
      id: { type: 'string' }, rule_type: { type: 'string', enum: ['requests', 'tokens'] },
      rule_value: { type: 'number' }, duration_hours: { type: 'number' }, description: { type: 'string' },
    }, ['id', 'rule_type', 'rule_value', 'duration_hours', 'description']),
    TeamRuleDeleteResponse: object({ success: { const: true } }),
    BalanceGroup: object({
      id: { type: 'integer' }, name: { type: 'string' }, description: nullableString,
      rules: { type: 'array', items: { $ref: '#/components/schemas/TeamQuotaRule' } },
    }, ['id', 'name', 'rules']),
    UserBalance: object({
      balance: { type: 'number' }, refund_balance: { type: 'number' },
      rate_limit_rpm: { type: 'integer' }, rate_limit_tpm: { type: 'integer' },
      group: { anyOf: [{ $ref: '#/components/schemas/BalanceGroup' }, { type: 'null' }] },
    }, ['balance', 'refund_balance', 'rate_limit_rpm', 'rate_limit_tpm', 'group']),
  };
}

function managementSuccessStatus(operationId) {
  return operationId === 'user.keyTags.create' ? 201 : 200;
}

function managementResponseSchema(operationId) {
  const schemas = {
    'user.apiKeys.list': { type: 'array', items: { $ref: '#/components/schemas/ApiKeyListItem' } },
    'admin.users.list': { oneOf: [{ type: 'array', items: { $ref: '#/components/schemas/AdminUser' } }, { $ref: '#/components/schemas/AdminUsersPage' }] },
    'admin.products.list': { type: 'array', items: { $ref: '#/components/schemas/AdminProduct' } },
    'admin.usageLogs.list': { $ref: '#/components/schemas/AdminUsageLogsResponse' },
    'admin.stats.multi.filters.list': { $ref: '#/components/schemas/AdminStatsFiltersResponse' },
    'admin.providerTags.list': { type: 'array', items: { $ref: '#/components/schemas/AdminProviderTag' } },
    'admin.providerTags.create': { $ref: '#/components/schemas/AdminProviderTagUpdateResponse' },
    'admin.providerTags.byId.update': { $ref: '#/components/schemas/AdminProviderTagUpdateResponse' },
    'admin.providerTags.byId.delete': { $ref: '#/components/schemas/ApiKeyActionSuccess' },
    'admin.providerTags.reorder': { $ref: '#/components/schemas/ApiKeyActionSuccess' },
    'admin.teams.byId.members.list': { type: 'array', items: { $ref: '#/components/schemas/TeamMember' } },
    'admin.teams.byId.models.list': { type: 'array', items: { $ref: '#/components/schemas/TeamModelListItem' } },
    'admin.teams.byId.rules.list': { type: 'array', items: { $ref: '#/components/schemas/TeamQuotaRule' } },
    'admin.teams.byId.rules.create': { $ref: '#/components/schemas/TeamQuotaRuleCreated' },
    'admin.teams.byId.rules.byRuleId.delete': { $ref: '#/components/schemas/TeamRuleDeleteResponse' },
    'user.usage.list': { type: 'array', items: { $ref: '#/components/schemas/DailyUsageItem' } },
    'user.balance.list': { $ref: '#/components/schemas/UserBalance' },
    'user.models.list': { type: 'array', items: { $ref: '#/components/schemas/UserModelListItem' } },
    'user.models.byId.info.list': { $ref: '#/components/schemas/UserModelInfo' },
    'user.providers.list': { type: 'array', items: { $ref: '#/components/schemas/UserProviderListItem' } },
    'user.products.list': { type: 'array', items: { $ref: '#/components/schemas/UserProduct' } },
    'user.providerTags.list': { type: 'array', items: { $ref: '#/components/schemas/ProviderTag' } },
    'user.providers.quota.list': { $ref: '#/components/schemas/UserProviderQuotaResponse' },
    'user.codeBalances.list': { type: 'array', items: { $ref: '#/components/schemas/UserCodeBalanceItem' } },
    'user.models.uptime.list': { $ref: '#/components/schemas/ModelUptimeResponse' },
    'user.models.byId.uptime.list': { $ref: '#/components/schemas/ModelUptimeDetailResponse' },
    'admin.models.uptime.list': { $ref: '#/components/schemas/ModelUptimeResponse' },
    'admin.models.byId.uptime.list': { $ref: '#/components/schemas/ModelUptimeDetailResponse' },
    'user.apiKeys.byId.usage.list': { type: 'array', items: { $ref: '#/components/schemas/ApiKeyDailyUsageItem' } },
    'user.apiKeys.byId.models.list': { $ref: '#/components/schemas/ApiKeyModelsResponse' },
    'user.apiKeys.byId.harnessModels.list': { $ref: '#/components/schemas/ApiKeyHarnessModelsResponse' },
    'user.apiKeys.byId.requestModelBindings.list': { $ref: '#/components/schemas/ApiKeyRequestModelBindingsResponse' },
    'user.apiKeys.byId.models.update': { $ref: '#/components/schemas/ApiKeyModelsUpdateResponse' },
    'user.apiKeys.byId.config.list': { $ref: '#/components/schemas/ApiKeyClaudeConfig' },
    'user.apiKeys.byId.fusionConfig.list': { $ref: '#/components/schemas/ApiKeyFusionConfig' },
    'user.apiKeys.byId.fusionConfig.update': { $ref: '#/components/schemas/ApiKeyActionSuccess' },
    'user.apiKeys.byId.tags.update': { $ref: '#/components/schemas/ApiKeyTagsResponse' },
    'user.apiKeys.byId.enabled.update': { $ref: '#/components/schemas/ApiKeyEnabledUpdateResponse' },
    'user.apiKeys.byId.swallowImages.update': { $ref: '#/components/schemas/ApiKeySwallowImagesUpdateResponse' },
    'user.apiKeys.byId.crewrouterCommands.update': { $ref: '#/components/schemas/ApiKeyCommandsUpdateResponse' },
    'user.keyTags.list': { type: 'array', items: { $ref: '#/components/schemas/UserKeyTag' } },
    'user.keyTags.create': { $ref: '#/components/schemas/UserKeyTag' },
    'user.keyTags.byId.update': { $ref: '#/components/schemas/UserKeyTag' },
    'user.apiKeys.byId.members.list': { $ref: '#/components/schemas/ApiKeyMembersResponse' },
    'user.apiKeys.byId.quotaWarning.list': { $ref: '#/components/schemas/ApiKeyQuotaWarning' },
    'user.apiKeys.byId.quotaWarning.update': { $ref: '#/components/schemas/ApiKeyQuotaWarning' },
    'user.apiKeys.byId.schedule.list': { $ref: '#/components/schemas/ApiKeySchedule' },
    'user.currentModel.list': { $ref: '#/components/schemas/CurrentModelResponse' },
    'user.usageLogs.list': { $ref: '#/components/schemas/UserUsageLogsResponse' },
    'user.usageLogs.byId.get': { $ref: '#/components/schemas/UserUsageLogDetailResponse' },
    'user.stats.filters.list': { $ref: '#/components/schemas/UserStatsFiltersResponse' },
    'user.providers.quota.list': { $ref: '#/components/schemas/UserProviderQuotaResponse' },
  };
  return schemas[operationId] || null;
}

function signatureSchemas() {
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  const template = {
    type: ['string', 'null'], maxLength: 2000,
    description: 'Trimmed before storage and length validation (maximum 2000 UTF-16 code units after trim). Explicit null or an empty/whitespace-only string clears the template. Missing fields never clear existing values.',
  };
  const userEnabled = { type: 'boolean' };
  const keyEnabled = { type: ['boolean', 'null'], description: 'true enables, false disables, null inherits the owning user default (not the Co-Key member default).' };
  const text = { type: 'string', maxLength: 2000 };
  const legacy = schema => ({ ...schema, deprecated: true, description: `${schema.description || ''} Compatibility alias, retained for one release.`.trim() });
  const put = key => {
    const enabled = key ? keyEnabled : userEnabled;
    const aliases = field => [field, `signature_${field}`, `${key ? 'key' : 'api'}_signature_${field}`];
    return {
      type: 'object',
      description: 'Complete replacement, not PATCH: both enabled and template are mandatory. Legacy aliases may supply either required field for one release, including mixed new/legacy names. If multiple aliases are present their normalized values must agree; conflicts return 400. Unrecognized properties are ignored. All fields are validated before any database write.',
      properties: Object.fromEntries(['enabled', 'template'].flatMap(field => aliases(field).map((name, i) => [name, i ? legacy(field === 'enabled' ? enabled : template) : field === 'enabled' ? enabled : template]))),
      anyOf: [
        { required: ['enabled', 'template'] },
        { allOf: ['enabled', 'template'].map(field => ({ anyOf: aliases(field).map(name => ({ required: [name] })) })) },
      ],
      additionalProperties: true,
    };
  };
  const inherited = object({ enabled: userEnabled, template: text });
  const effective = object({
    enabled: { type: 'boolean', description: 'Resolved switch; an empty resolved template still produces no signature.' },
    template: { ...text, description: 'Trimmed Key template, or the owning user template when the Key template is empty. Empty means no signature; the example default is never inserted automatically.' },
    source: { type: 'string', enum: ['user', 'key'], description: 'Source of the enabled switch, independent of template inheritance.' },
  });
  const userProperties = {
    enabled: userEnabled, template: text,
    api_signature_enabled: legacy(userEnabled), api_signature_template: legacy(text),
  };
  const keyProperties = {
    enabled: keyEnabled, template,
    key_signature_enabled: legacy(keyEnabled), key_signature_template: legacy(template),
    user_signature_enabled: legacy(userEnabled), user_signature_template: legacy(text),
    inherited, effective,
  };
  return {
    UserSignaturePut: put(false),
    KeySignaturePut: put(true),
    UserSignature: object({ ...userProperties, defaults: object({ template: text, variables: { type: 'array', items: { type: 'string' } } }) }),
    UserSignatureUpdated: object({ success: { const: true }, ...userProperties }),
    KeySignature: object(keyProperties),
    KeySignatureUpdated: object({ success: { const: true }, ...keyProperties }),
    SignatureValidationError: object({
      error: { type: 'string' },
      code: { type: 'string', enum: ['missing_signature_field', 'invalid_signature_field', 'conflicting_signature_fields', 'invalid_signature_enabled', 'invalid_signature_template'] },
    }),
  };
}

function buildOpenApi(operations) {
  const paths = {};
  for (const op of operations) {
    if (op.sdkStatus === 'excluded' && op.exclusion === 'alias') continue;
    const apiPath = openApiPath(op.path);
    paths[apiPath] ||= {};
    const parameters = [...op.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const successStatus = managementSuccessStatus(op.operationId);
    const operation = {
      operationId: op.operationId,
      summary: `${op.method} ${op.path}`,
      tags: [op.permissionGroup || op.feature],
      security: op.authModes.includes('oauth') ? [{ oauthBearer: [] }] : op.authModes.includes('api_key') ? [{ bearerApiKey: [] }] : [],
      parameters,
      responses: {
        [successStatus]: {
          description: 'Successful response',
          content: op.streaming
            ? { 'text/event-stream': { schema: { type: 'string' } } }
            : { 'application/json': { schema: managementResponseSchema(op.operationId) || { type: 'object', additionalProperties: true } } },
        },
      },
      'x-crewrouter-permission': op.permission,
      'x-crewrouter-auth-modes': op.authModes,
      'x-crewrouter-streaming': op.streaming,
      'x-crewrouter-body-limit': op.limits.body,
    };
    if (op.operationId === 'admin.users.list') {
      operation.description = 'Administrator-only user list. Without the page query, returns a full array for legacy consumers. With page specified, returns a paginated object containing items, total, page, limit and filtered stats.';
    }
    if (op.operationId === 'admin.teams.byId.rules.create') {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/TeamQuotaRuleCreateRequest' } } },
      };
    }
    if (op.operationId === 'user.usageLogs.byId.get') {
      operation.description = 'Returns one usage record owned by the authenticated user. messages and response are opaque upstream payloads, can be large, and may contain user data; avoid logging or redistributing them.';
    }
    if (op.operationId === 'user.apiKeys.byId.config.list') {
      operation.description = 'Owner-only Claude Code configuration. Requires keys.secret and an API Key owned by the caller. The response contains the API Key in ANTHROPIC_AUTH_TOKEN; never log or expose it. Legacy hash-only keys return HTTP 410 and must be regenerated.';
    }
    if (op.operationId === 'user.apiKeys.byId.fusionConfig.update') {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKeyFusionConfigPut' } } },
      };
      operation.responses[400] = {
        description: 'Invalid Fusion configuration, including a missing/non-array panel_models or more than 10 distinct non-empty panel models.',
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
      };
      operation.responses[403] = {
        description: 'The API Key owner is not authorized to use one of the configured models.',
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
      };
    }
    if (op.aliases.length) operation['x-crewrouter-aliases'] = op.aliases;
    if (op.sdkStatus === 'excluded') operation['x-crewrouter-excluded'] = op.exclusion;
    if (!operation.requestBody && ['POST', 'PUT', 'PATCH'].includes(op.method) && op.request.body === 'json') {
      operation.requestBody = {
        required: false,
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
      };
    }
    const signatureKey = op.path === '/api/user/api-keys/:id/signature';
    if ((signatureKey || op.path === '/api/user/signature') && ['GET', 'PUT'].includes(op.method)) {
      const name = signatureKey ? 'Key' : 'User';
      const ref = schema => ({ $ref: `#/components/schemas/${schema}` });
      operation.responses[200].content = {
        'application/json': { schema: ref(`${name}Signature${op.method === 'PUT' ? 'Updated' : ''}`) },
      };
      operation.description = signatureKey
        ? 'Key signature configuration. Co-Key members with management access read and update this Key, while inherited/effective values always use the owning user defaults. An empty resolved template produces no signature.'
        : 'User default signature configuration. The example defaults.template is informational only, never an automatic fallback. Empty templates produce no signature.';
      if (op.method === 'PUT') {
        operation.description += ' Complete PUT requires enabled and template (or their legacy aliases); omitted fields return 400 rather than resetting existing values. Validation precedes the atomic write and cache invalidation follows successful commit.';
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: ref(`${name}SignaturePut`) } },
        };
        operation.responses[400] = {
          description: 'Invalid signature settings: missing enabled/template (including accepted aliases), undefined field, conflicting aliases after normalization, non-boolean switch (only Key accepts null), non-string/non-null template, or template longer than 2000 after trim. No fields are written and no cache is invalidated.',
          content: { 'application/json': { schema: ref('SignatureValidationError') } },
        };
      }
    }
    paths[apiPath][op.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'CrewRouter API',
      version: '27.0.0-beta.1',
      description: 'OpenAI/Anthropic/Gemini-compatible model gateway plus management API.',
    },
    servers: [{ url: 'https://your-host', description: 'CrewRouter instance' }],
    components: {
      schemas: { ...managementSchemas(), ...signatureSchemas() },
      securitySchemes: {
        bearerApiKey: { type: 'http', scheme: 'bearer', description: 'API Key: Authorization: Bearer sk-...' },
        xApiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        oauthBearer: { type: 'http', scheme: 'bearer', description: 'OAuth access token crh_... (gateway only)' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'connect.sid' },
      },
    },
    paths,
  };
}

function tsLiteral(value) {
  return JSON.stringify(value, null, 2);
}

function buildTypeScript(operations) {
  const list = operations.map((op) => ({
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    aliases: op.aliases,
    permission: op.permission,
    permissionGroup: op.permissionGroup,
    adminOnly: op.adminOnly,
    authModes: op.authModes,
    streaming: op.streaming,
    dynamic: op.dynamic,
    sdkStatus: op.sdkStatus,
    exclusion: op.exclusion,
    bodyLimit: op.limits.body,
  }));
  return `// DO NOT EDIT. Generated by sdk/codegen/generate.mjs from server/routes.\n\n` +
    `export interface CrewRouterOperation {\n` +
    `  readonly operationId: string;\n  readonly method: string;\n  readonly path: string;\n  readonly aliases: readonly string[];\n` +
    `  readonly permission: string | null;\n  readonly permissionGroup: string | null;\n  readonly adminOnly: boolean;\n` +
    `  readonly authModes: readonly string[];\n  readonly streaming: boolean;\n  readonly dynamic: boolean;\n` +
    `  readonly sdkStatus: 'generated' | 'manual' | 'excluded';\n  readonly exclusion: string | null;\n  readonly bodyLimit: string;\n}\n\n` +
    `export const CONTRACT_VERSION = 1;\n\n` +
    `export const OPERATIONS: Record<string, CrewRouterOperation> = ${tsLiteral(Object.fromEntries(list.map((op) => [op.operationId, op])))}\n\n` +
    `export const OPERATION_LIST: readonly CrewRouterOperation[] = Object.values(OPERATIONS);\n\n` +
    `export type OperationId = keyof typeof OPERATIONS;\n`;
}

function operationSummaryList(operations) {
  return operations.map((op) => ({
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    aliases: op.aliases,
    permission: op.permission,
    permissionGroup: op.permissionGroup,
    adminOnly: op.adminOnly,
    authModes: op.authModes,
    streaming: op.streaming,
    dynamic: op.dynamic,
    sdkStatus: op.sdkStatus,
    exclusion: op.exclusion,
  }));
}

function pyLiteral(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pyLiteral(item)}`).join(', ')}}`;
  }
  return 'None';
}

function buildPython(operations) {
  const entries = operationSummaryList(operations)
    .map((op) => `    ${JSON.stringify(op.operationId)}: ${pyLiteral(op)},`)
    .join('\n');
  return `# DO NOT EDIT. Generated by sdk/codegen/generate.mjs from server/routes.\n\n` +
    `from __future__ import annotations\n\n` +
    `from typing import Any\n\n` +
    `CONTRACT_VERSION = 1\n\n` +
    `OPERATIONS: dict[str, dict[str, Any]] = {\n${entries}\n}\n\n` +
    `OPERATION_LIST: list[dict[str, Any]] = list(OPERATIONS.values())\n`;
}

function goQuote(value) {
  return JSON.stringify(String(value));
}

function buildGo(operations) {
  const summaries = operationSummaryList(operations);
  const entries = summaries.map((op) => {
    const aliases = `[]string{${op.aliases.map(goQuote).join(', ')}}`;
    const authModes = `[]string{${op.authModes.map(goQuote).join(', ')}}`;
    const permission = op.permission === null ? '""' : goQuote(op.permission);
    const permissionGroup = op.permissionGroup === null ? '""' : goQuote(op.permissionGroup);
    const exclusion = op.exclusion === null ? '""' : goQuote(op.exclusion);
    return `\t${goQuote(op.operationId)}: {\n` +
      `\t\tOperationID:     ${goQuote(op.operationId)},\n` +
      `\t\tMethod:          ${goQuote(op.method)},\n` +
      `\t\tPath:            ${goQuote(op.path)},\n` +
      `\t\tAliases:         ${aliases},\n` +
      `\t\tPermission:      ${permission},\n` +
      `\t\tPermissionGroup: ${permissionGroup},\n` +
      `\t\tAdminOnly:       ${op.adminOnly},\n` +
      `\t\tAuthModes:       ${authModes},\n` +
      `\t\tStreaming:       ${op.streaming},\n` +
      `\t\tDynamic:         ${op.dynamic},\n` +
      `\t\tSDKStatus:       ${goQuote(op.sdkStatus)},\n` +
      `\t\tExclusion:       ${exclusion},\n` +
      `\t\tBodyLimit:       ${goQuote(op.bodyLimit)},\n` +
      `\t},\n`;
  }).join('');
  return `// Code generated by sdk/codegen/generate.mjs. DO NOT EDIT.\n\n` +
    `package crewrouter\n\n` +
    `// ContractVersion is the generated operation-surface version.\n` +
    `const ContractVersion = 1\n\n` +
    `// Operation describes one CrewRouter HTTP operation.\n` +
    `type Operation struct {\n` +
    `\tOperationID     string\n` +
    `\tMethod          string\n` +
    `\tPath            string\n` +
    `\tAliases         []string\n` +
    `\tPermission      string\n` +
    `\tPermissionGroup string\n` +
    `\tAdminOnly       bool\n` +
    `\tAuthModes       []string\n` +
    `\tStreaming       bool\n` +
    `\tDynamic         bool\n` +
    `\tSDKStatus       string\n` +
    `\tExclusion       string\n` +
    `\tBodyLimit       string\n` +
    `}\n\n` +
    `// Operations is the generated operation catalog.\n` +
    `var Operations = map[string]Operation{\n${entries}}\n`;
}

function buildReference(operations) {
  const groups = new Map();
  for (const op of operations) {
    const key = op.permissionGroup || op.feature;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(op);
  }
  const lines = ['# CrewRouter API Reference', '', '> Generated from `sdk/contract/operations.json`. Do not edit by hand.', ''];
  for (const [group, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${group}`, '', '| operationId | Method | Path | Permission | Auth | Streaming |', '| --- | --- | --- | --- | --- | --- |');
    for (const op of items.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`))) {
      lines.push(`| \`${op.operationId}\` | ${op.method} | \`${op.path}\` | ${op.permission ? `\`${op.permission}\`` : '—'} | ${op.authModes.join(', ') || 'public'} | ${op.streaming ? 'yes' : 'no'} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function main() {
  const check = process.argv.includes('--check');
  const operations = collectOperations();
  const manifest = {
    contractVersion: 1,
    generatedBy: 'sdk/codegen/generate.mjs',
    operations,
  };
  const openapi = buildOpenApi(operations);
  const outputs = [
    [OUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`],
    [OUT_OPENAPI, `${JSON.stringify(openapi, null, 2)}\n`],
    [OUT_OPENAPI_DOCS, `${JSON.stringify(openapi, null, 2)}\n`],
    [OUT_TS, buildTypeScript(operations)],
    [OUT_PY, buildPython(operations)],
    [OUT_GO, buildGo(operations)],
    [OUT_REFERENCE, buildReference(operations)],
  ];

  let stale = false;
  for (const [file, content] of outputs) {
    const relative = path.relative(ROOT, file);
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (current !== content) {
        console.error(`[sdk:check] stale: ${relative}`);
        stale = true;
      }
    } else {
      ensureDir(file);
      fs.writeFileSync(file, content);
      console.log(`[sdk:generate] wrote ${relative}`);
    }
  }

  const summary = operations.reduce((acc, op) => {
    acc[op.sdkStatus] = (acc[op.sdkStatus] || 0) + 1;
    return acc;
  }, {});
  console.log(`[sdk:generate] operations=${operations.length} generated=${summary.generated || 0} manual=${summary.manual || 0} excluded=${summary.excluded || 0}`);
  if (check && stale) process.exit(1);
}

main();
