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
    const operation = {
      operationId: op.operationId,
      summary: `${op.method} ${op.path}`,
      tags: [op.permissionGroup || op.feature],
      security: op.authModes.includes('oauth') ? [{ oauthBearer: [] }] : op.authModes.includes('api_key') ? [{ bearerApiKey: [] }] : [],
      parameters,
      responses: {
        200: {
          description: 'Successful response',
          content: op.streaming
            ? { 'text/event-stream': { schema: { type: 'string' } } }
            : { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
        },
      },
      'x-crewrouter-permission': op.permission,
      'x-crewrouter-auth-modes': op.authModes,
      'x-crewrouter-streaming': op.streaming,
      'x-crewrouter-body-limit': op.limits.body,
    };
    if (op.aliases.length) operation['x-crewrouter-aliases'] = op.aliases;
    if (op.sdkStatus === 'excluded') operation['x-crewrouter-excluded'] = op.exclusion;
    if (['POST', 'PUT', 'PATCH'].includes(op.method) && op.request.body === 'json') {
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
      schemas: signatureSchemas(),
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
