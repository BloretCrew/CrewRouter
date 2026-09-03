#!/usr/bin/env node
'use strict';
const assert = require('assert');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const packageJsonPath = require.resolve('@bloret-crew/blora-design/package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
assert.strictEqual(packageJson.version, '2.0.8');
assert.strictEqual(packageJson.exports['./auto'].import, './dist/auto.js');
const dist = path.join(path.dirname(packageJsonPath), 'dist');
const app = express();
app.use('/blora', express.static(dist, { index: false, dotfiles: 'deny', fallthrough: false, maxAge: '1y', setHeaders(res) { res.setHeader('Cache-Control', 'public, max-age=31536000'); } }));
const server = http.createServer(app);
const request = (url) => new Promise((resolve, reject) => {
  const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: url }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], cache: res.headers['cache-control'], body: Buffer.concat(chunks) })); });
  req.on('error', reject);
});
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [file, type] of [['blora.css', 'text/css'], ['tokens.dark.css', 'text/css'], ['auto.js', 'javascript']]) {
      const response = await request(`/blora/${file}?v=2.0.8`);
      assert.strictEqual(response.status, 200, file);
      assert.match(response.type, new RegExp(type.replace('/', '\\/' )));
      assert.match(response.cache, /max-age=31536000/);
      assert.ok(response.body.length > 0);
    }
    for (const url of ['/blora/../package.json', '/blora/%2e%2e/package.json', '/blora/.package.json', '/blora/not-found.css']) {
      const response = await request(url);
      assert.notStrictEqual(response.status, 200, url);
    }
    console.log('Blora HTTP smoke checks passed.');
  } finally { server.close(); }
})().catch((error) => { server.close(); console.error(error.stack || error); process.exitCode = 1; });
