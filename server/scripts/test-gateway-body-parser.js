'use strict';

// HTTP 回归：网关请求体解析（zstd 支持、大小限制、错误 JSON 化）
// 用法：node server/scripts/test-gateway-body-parser.js

const assert = require('assert');
const express = require('express');
const http = require('http');
const zlib = require('zlib');
const { createGatewayBodyParser, gatewayBodyError } = require('../middleware/gateway-body');

const LIMIT = 4 * 1024; // 测试专用小上限
const app = express();
app.set('env', 'production');
app.use(createGatewayBodyParser({ limit: LIMIT }));
app.use(gatewayBodyError);
app.post(['/v1/echo', '/api/echo'], (req, res) => res.json({ ok: true, body: req.body }));
// 非 JSON 的 zstd 请求：路由级 echo 也挂在网关前缀下，需要先过解析器

function request(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const cases = [];
  try {
    // 1. 普通 JSON（不带压缩）
    cases.push(['plain json', await request(port, '/v1/echo', { 'content-type': 'application/json' }, JSON.stringify({ a: 1 }))]);
    // 2. zstd 压缩 JSON —— 本修复的目标场景
    const zstdBody = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ hello: 'zstd' })));
    cases.push(['zstd json', await request(port, '/v1/echo', { 'content-type': 'application/json', 'content-encoding': 'zstd' }, zstdBody)]);
    // 3. gzip 压缩 JSON（body-parser 原生支持，不应回归）
    cases.push(['gzip json', await request(port, '/v1/echo', { 'content-type': 'application/json', 'content-encoding': 'gzip' }, zlib.gzipSync(Buffer.from(JSON.stringify({ hello: 'gzip' }))))]);
    // 4. 未压缩但带 content-length 的 zstd 头 + 非 JSON 内容类型
    cases.push(['zstd non-json', await request(port, '/v1/echo', { 'content-type': 'text/plain', 'content-encoding': 'zstd' }, zstdBody)]);
    // 5. 损坏的 zstd 数据
    cases.push(['corrupt zstd', await request(port, '/v1/echo', { 'content-type': 'application/json', 'content-encoding': 'zstd' }, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xaa, 0xbb]))]);
    // 6. 非法 JSON 的 zstd 请求
    cases.push(['zstd bad json', await request(port, '/v1/echo', { 'content-type': 'application/json', 'content-encoding': 'zstd' }, zlib.zstdCompressSync(Buffer.from('{nope')))]);
    // 7. 超过小上限的压缩请求（压缩后大小可控，直接超限）
    cases.push(['zstd too large', await request(port, '/v1/echo', { 'content-type': 'application/json', 'content-encoding': 'zstd' }, zlib.zstdCompressSync(Buffer.alloc(LIMIT * 4, 0x61)))]);
    // 8. 超限的普通请求
    cases.push(['plain too large', await request(port, '/v1/echo', { 'content-type': 'application/json' }, JSON.stringify({ pad: 'x'.repeat(LIMIT * 2) }))]);
    // 9. 非网关路径不受网关限制（普通 JSON）
    cases.push(['non-gateway', await request(port, '/api/echo', { 'content-type': 'application/json' }, JSON.stringify({ path: 'api' }))]);

    assert.deepStrictEqual(cases[0][1], { status: 200, body: '{"ok":true,"body":{"a":1}}' });
    assert.deepStrictEqual(cases[1][1], { status: 200, body: '{"ok":true,"body":{"hello":"zstd"}}' });
    assert.deepStrictEqual(cases[2][1], { status: 200, body: '{"ok":true,"body":{"hello":"gzip"}}' });
    assert.strictEqual(cases[3][1].status, 415);
    assert.ok(cases[3][1].body.includes('unsupported_content_encoding'), cases[3][1].body);
    assert.strictEqual(cases[4][1].status, 400);
    assert.ok(cases[4][1].body.includes('invalid_json'), cases[4][1].body);
    assert.strictEqual(cases[5][1].status, 400);
    assert.ok(cases[5][1].body.includes('invalid_json'), cases[5][1].body);
    assert.strictEqual(cases[6][1].status, 413);
    assert.ok(cases[6][1].body.includes('request_too_large'), cases[6][1].body);
    assert.strictEqual(cases[7][1].status, 413);
    assert.ok(cases[7][1].body.includes('request_too_large'), cases[7][1].body);
    assert.strictEqual(cases[8][1].status, 200);
  } finally {
    server.close();
  }
  for (const [name, result] of cases) console.log(name, result.status);
  console.log('gateway body parser tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
