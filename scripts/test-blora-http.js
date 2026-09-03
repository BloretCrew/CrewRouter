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
  const dist = path.dirname(autoPath);
  const css = fs.readFileSync(path.join(dist, 'blora.css'), 'utf8');
  const imports = [...css.matchAll(/@import\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(imports.includes('./tokens.css'));
  assert.ok(imports.includes('./components/button/button.css'));
  const reachable = new Set();
  const visitCss = async (relative) => {
    if (reachable.has(relative)) return;
    reachable.add(relative);
    const source = fs.readFileSync(path.join(dist, relative), 'utf8');
    for (const imported of [...source.matchAll(/@import\s+["']([^"']+)["']/g)].map((m) => m[1])) {
      assert.ok(imported.startsWith('./'), `${relative}: import must be relative: ${imported}`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), imported));
      assert.ok(target.endsWith('.css'), `${relative}: import must target CSS: ${imported}`);
      assert.ok(!target.startsWith('../') && !target.includes('/../'), `${relative}: import escapes dist: ${imported}`);
      await visitCss(target);
    }
  };
  await visitCss('blora.css');
  assert.ok(reachable.size >= 93, `expected complete Blora CSS graph, got ${reachable.size}`);

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
    assert.ok(reachable.has('tokens.css'));
    assert.ok(reachable.has('components/button/button.css'));
    for (const file of reachable) {
      const response = await request(`/blora/${file}?v=2.0.8`);
      assert.strictEqual(response.status, 200, file);
      assert.match(response.type, file.endsWith('.css') ? /text\/css/ : /javascript/);
      assert.match(response.cache, /max-age=31536000/);
      assert.ok(response.body.length > 0);
    }
    for (const [file, type] of [['blora.css', 'text/css'], ['tokens.dark.css', 'text/css'], ['components/button/button.css', 'text/css'], ['auto.js', 'javascript']]) {
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
