'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const moduleFixture = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/api-signature.js'), 'utf8'), {
  module: moduleFixture, Buffer, require(name) {
    if (name === '../models/database') return { pool: { query() { throw new Error('Unexpected database query'); } } };
    if (name === '../logger') return { warn() {}, info() {} };
    if (name === './quota-data') return { getUserQuotaBuffer: () => [] };
    if (name === '../proxy-pool') return { pinnedFetch() { throw new Error('Unexpected upstream request'); } };
    throw new Error(`Unexpected dependency: ${name}`);
  }
});
const signature = moduleFixture.exports;

function fakeRes() {
  const headers = new Map();
  return {
    headersSent: false,
    headers,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
  };
}

test('resolveSignatureConfig honors the user master switch and key-level opt-out', () => {
  const user = { api_signature_enabled: true, api_signature_template: 'user-template' };

  const inherited = signature.resolveSignatureConfig({ key: { signature_enabled: null, signature_template: null }, user });
  assert.deepEqual(
    { enabled: inherited.enabled, template: inherited.template, source: inherited.source, keyEnabled: inherited.keyEnabled },
    { enabled: true, template: 'user-template', source: 'user', keyEnabled: null }
  );

  const forcedOff = signature.resolveSignatureConfig({ key: { signature_enabled: false, signature_template: 'key-template' }, user });
  assert.equal(forcedOff.enabled, false);
  assert.equal(forcedOff.template, 'key-template');
  assert.equal(forcedOff.source, 'key');

  const perKeyOn = signature.resolveSignatureConfig({ key: { signature_enabled: true }, user: { api_signature_enabled: true, api_signature_template: 'u' } });
  assert.equal(perKeyOn.enabled, true);
  assert.equal(perKeyOn.template, 'u');
  assert.equal(perKeyOn.source, 'key');

  // User master off is authoritative even for legacy per-Key force-on overrides.
  const masterOff = signature.resolveSignatureConfig({ key: { signature_enabled: true }, user: { api_signature_enabled: false, api_signature_template: 'u' } });
  assert.equal(masterOff.enabled, false);
  assert.equal(masterOff.template, 'u');
  assert.equal(masterOff.source, 'user');

  const blankKeyTemplate = signature.resolveSignatureConfig({ key: { signature_enabled: true, signature_template: '   ' }, user });
  assert.equal(blankKeyTemplate.template, 'user-template', 'blank key template inherits the user template');

  const emptyUser = signature.resolveSignatureConfig({ key: {}, user: { api_signature_enabled: false, api_signature_template: '' } });
  assert.deepEqual({ enabled: emptyUser.enabled, template: emptyUser.template }, { enabled: false, template: '' });
});

test('template validation trims, enforces limits and rejects wrong types', () => {
  assert.equal(signature.validateSignatureTemplate(null), '');
  assert.equal(signature.validateSignatureTemplate('  {model}  '), '{model}');
  assert.equal(signature.validateSignatureTemplate(''), '');
  assert.throws(() => signature.validateSignatureTemplate(42), err => err.status === 400 && err.code === 'invalid_signature_template');
  assert.throws(
    () => signature.validateSignatureTemplate('x'.repeat(signature.SIGNATURE_TEMPLATE_MAX_LENGTH + 1)),
    err => err.status === 400 && err.code === 'invalid_signature_template'
  );
  assert.equal(signature.validateSignatureEnabled(true), true);
  assert.throws(() => signature.validateSignatureEnabled('true'), err => err.status === 400 && err.code === 'invalid_signature_enabled');
  assert.equal(signature.validateSignatureTriState(null), null);
  assert.equal(signature.validateSignatureTriState(false), false);
  assert.throws(() => signature.validateSignatureTriState(1), err => err.status === 400);
});

test('empty template means no signature and never falls back to the default template', async () => {
  assert.equal(await signature.buildSignature({ template: '', meta: { model: 'm' } }), '');
  assert.equal(await signature.buildSignature({ template: '   ', meta: { model: 'm' } }), '');
  assert.equal(await signature.buildSignature({ template: null, meta: { model: 'm' } }), '');
});

test('buildSignature substitutes variables already preloaded and cleans dangling separators', async () => {
  const text = await signature.buildSignature({
    template: '{model} · {tokens} · {team_name} · {group_name} · {provider}',
    meta: { model: 'gpt-test', promptTokens: 1000, completionTokens: 234, providerName: 'OpenAI' },
    preloaded: { teamName: 'Team' }
  });
  assert.equal(text, 'gpt-test · 1.2k tokens · Team · Team · OpenAI');
});

test('content append is skipped for structured output, tool-only responses and header mode', () => {
  const json = signature.shouldAppendSignatureToContent({ format: 'openai', requestBody: { response_format: { type: 'json_schema' } }, responseShape: { choices: [{ message: { content: '{}' } }] } });
  assert.equal(json.append, false);
  assert.equal(json.reason, 'json_response_format');

  const geminiJson = signature.shouldAppendSignatureToContent({
    format: 'ir',
    requestBody: { ir: { passthrough: { gemini: { generationConfigExtras: { responseMimeType: 'application/json' } } } } }
  });
  assert.equal(geminiJson.append, false);

  const toolOnly = signature.shouldAppendSignatureToContent({
    format: 'openai',
    responseShape: { choices: [{ message: { content: null, tool_calls: [{ id: '1' }] }, finish_reason: 'tool_calls' }] }
  });
  assert.equal(toolOnly.append, false);

  const headerOnly = signature.shouldAppendSignatureToContent({
    format: 'openai', mode: 'header', responseShape: { choices: [{ message: { content: 'hi' } }] }
  });
  assert.equal(headerOnly.append, false);
  assert.equal(headerOnly.reason, 'mode_header');

  const emptyAnthropic = signature.shouldAppendSignatureToContent({ format: 'anthropic', responseShape: { content: [] } });
  assert.equal(emptyAnthropic.append, false);
  assert.equal(emptyAnthropic.reason, 'no_text_content');

  const emptyResponses = signature.shouldAppendSignatureToContent({
    format: 'responses', responseShape: { output: [{ type: 'function_call' }] }
  });
  assert.equal(emptyResponses.append, false);
});

test('applySignatureToJson never creates missing structures and honors mode semantics', () => {
  const res = fakeRes();
  const openai = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };
  const result = signature.applySignatureToJson(res, 'openai', openai, 'sig', { mode: 'both' });
  assert.equal(result.header, true);
  assert.equal(result.appendContent, true);
  assert.equal(openai.choices[0].message.content, 'hello\n\nsig');
  assert.equal(res.headers.get(signature.SIGNATURE_HEADER.toLowerCase()), 'sig');

  const contentOnlyRes = fakeRes();
  const contentOnly = signature.applySignatureToJson(contentOnlyRes, 'openai', { choices: [{ message: { content: 'hi' } }] }, 'sig', { mode: 'content' });
  assert.equal(contentOnly.header, false);
  assert.equal(contentOnlyRes.headers.has(signature.SIGNATURE_HEADER.toLowerCase()), false, 'content mode does not set headers');

  const noText = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: '1' }] } }] };
  const skipped = signature.applySignatureToJson(fakeRes(), 'openai', noText, 'sig', { mode: 'both' });
  assert.equal(skipped.appendContent, false);
  assert.equal(noText.choices[0].message.content, null, 'never creates a content field');

  const anthropic = { content: [{ type: 'tool_use', id: '1' }, { type: 'text', text: 'ok' }] };
  signature.applySignatureToJson(fakeRes(), 'anthropic', anthropic, 'sig', { mode: 'both' });
  assert.equal(anthropic.content[0].text, undefined);
  assert.equal(anthropic.content[1].text, 'ok\n\nsig');

  const responses = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], output_text: 'hi' };
  signature.applySignatureToJson(fakeRes(), 'responses', responses, 'sig', { mode: 'both' });
  assert.equal(responses.output[0].content[0].text, 'hi\n\nsig');
  assert.equal(responses.output_text, 'hi\n\nsig');

  const ir = { message: { blocks: [{ type: 'text', text: 'first' }, { type: 'text', text: 'last' }] } };
  signature.applySignatureToJson(fakeRes(), 'ir', ir, 'sig', { mode: 'both' });
  assert.equal(ir.message.blocks[0].text, 'first');
  assert.equal(ir.message.blocks[1].text, 'last\n\nsig');
});

test('stream plan drops content in header mode and keeps it for text responses', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(signature.planStreamSignatureInjection({ mode: 'header', hasTextContent: true }))),
    { appendContent: false, reason: 'mode_header', note: 'stream_headers_already_flushed' }
  );
  assert.equal(signature.planStreamSignatureInjection({ mode: 'both', hasTextContent: true }).appendContent, true);
  assert.equal(signature.planStreamSignatureInjection({ mode: 'both', hasTextContent: false }).appendContent, false);
});

test('中文响应头使用可解码的 Base64，content 模式不写头', () => {
  const http = require('node:http');
  const request = { method: 'GET' };
  const res = new http.ServerResponse(request);
  assert.equal(signature.setSignatureHeaders(res, '模型 · 缓存命中 78%'), true);
  assert.equal(res.getHeader('X-CrewRouter-Signature'), undefined);
  assert.equal(Buffer.from(res.getHeader('X-CrewRouter-Signature-B64'), 'base64').toString('utf8'), '模型 · 缓存命中 78%');
});

test('真实 Gemini 结构化设置跳过正文，流式跳过不触发签名查询', async () => {
  for (const config of [{ responseMimeType: 'application/json' }, { responseJsonSchema: { type: 'object' } }, { responseSchema: { type: 'OBJECT' } }]) {
    assert.equal(signature.shouldAppendSignatureToContent({
      format: 'ir', requestBody: { generationConfig: config }, hasTextContent: true
    }).append, false);
  }
  const req = { headers: { 'x-crewrouter-signature-mode': 'header' }, body: {},
    apiUser: { signature: { enabled: true, template: '{quota_info}' }, userId: 1 } };
  const result = await signature.finalizeStreamSignature(req, {}, { hasTextContent: true, emitText() { assert.fail('must skip'); } });
  assert.equal(result.appended, false);
  assert.equal(result.reason, 'mode_header');
  assert.equal(req._signaturePreloadPromise, undefined);
});
