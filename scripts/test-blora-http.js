#!/usr/bin/env node
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createBloraResourceRouter, packageJson } = require('../server/blora-resources');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

async function main() {
  assert.strictEqual(packageJson.exports['./auto'].import, './dist/auto.js');
  assert.strictEqual(packageJson.exports['./auto'].require, undefined);
  const auto = await import('@bloret-crew/blora-design/auto');
  assert.strictEqual(typeof auto.defineAllBloraElements, 'function');
  const autoPath = path.join(path.dirname(require.resolve('@bloret-crew/blora-design/package.json')), 'dist/auto.js');
  assert.strictEqual((await import(pathToFileURL(autoPath).href)).defineAllBloraElements instanceof Function, true);
  const css = fs.readFileSync(path.join(path.dirname(autoPath), 'blora.css'), 'utf8');
  assert.match(css, /@import ["']\.\/tokens\.css["']/);
  assert.match(css, /@import ["']\.\/components\/button\/button\.css["']/);

  const app = express();
  app.use('/blora', createBloraResourceRouter());
  app.use((error, req, res, next) => { if (res.headersSent) return next(error); res.status(500).type('text/plain').send('unexpected'); });
  const server = http.createServer(app);
  const errors = [];
  server.on('clientError', (error) => errors.push(error));
  const request = (url) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: url }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], cache: res.headers['cache-control'], body: Buffer.concat(chunks).toString('utf8') })); });
    req.on('error', reject);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [file, type] of [['blora.css', 'text/css'], ['tokens.dark.css', 'text/css'], ['auto.js', 'javascript']]) {
      const response = await request(`/blora/${file}?v=2.0.8`);
      assert.strictEqual(response.status, 200, file); assert.match(response.type, new RegExp(type)); assert.match(response.cache, /max-age=31536000/); assert.ok(response.body.length > 0);
    }
    for (const url of ['/blora/../package.json', '/blora/%2e%2e/package.json', '/blora/.package.json', '/blora/not-found.css']) {
      const response = await request(url); assert.strictEqual(response.status, 404, url); assert.match(response.type, /text\/plain/); assert.strictEqual(response.body, 'Not Found');
    }
    assert.deepStrictEqual(errors, []);
    console.log('Blora ESM and production-route HTTP smoke checks passed.');
  } finally { server.close(); }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
