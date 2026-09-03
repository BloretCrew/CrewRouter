'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const bloraDir = path.join(root, 'node_modules/@bloret-crew/blora-design/dist');
const pages = ['/pages/index.html', '/pages/setup.html', '/pages/feishu-bind.html', '/pages/set-password.html'];

execFileSync(process.execPath, [path.join(__dirname, 'test-blora-public-batch-a.js')], { stdio: 'inherit' });

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const base = pathname.startsWith('/blora/') ? bloraDir : publicDir;
  const relative = pathname.startsWith('/blora/') ? pathname.slice('/blora'.length) : pathname;
  const file = path.resolve(base, `.${relative}`);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) return res.writeHead(404).end();
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return res.writeHead(404).end();
    res.writeHead(200).end(fs.readFileSync(file));
  });
});

server.listen(0, '127.0.0.1', async () => {
  try {
    const { port } = server.address();
    for (const page of pages) {
      const response = await fetch(`http://127.0.0.1:${port}${page}`);
      assert.strictEqual(response.status, 200, `${page} should be served`);
      const html = await response.text();
      assert.match(html, /\/blora\/auto\.js\?v=2\.0\.8/);
      assert.doesNotMatch(html, /(?:password|token|secret)\s*[:=]\s*['"][^'"]+/i);
    }
    for (const asset of ['/blora/blora.css?v=2.0.8', '/blora/tokens.dark.css?v=2.0.8', '/blora/auto.js?v=2.0.8', '/css/auth-shell.css']) {
      const response = await fetch(`http://127.0.0.1:${port}${asset}`);
      assert.strictEqual(response.status, 200, `${asset} should be served`);
    }
    console.log('Blora public Batch A isolated HTTP smoke passed on 127.0.0.1.');
  } finally {
    server.close();
  }
});
