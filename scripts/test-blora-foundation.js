#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const lock = require(path.join(root, 'package-lock.json'));
const blora = require(path.join(root, 'node_modules/@bloret-crew/blora-design/package.json'));
assert.strictEqual(pkg.dependencies['@bloret-crew/blora-design'], '2.0.8');
assert.strictEqual(lock.packages[''].dependencies['@bloret-crew/blora-design'], '2.0.8');
assert.strictEqual(blora.version, '2.0.8');
for (const file of ['blora.css', 'tokens.css', 'tokens.dark.css', 'auto.js']) assert.ok(fs.existsSync(path.join(root, 'node_modules/@bloret-crew/blora-design/dist', file)), `missing dist/${file}`);
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
assert.match(server, /app\.use\('\/blora',\s*express\.static\(BLORA_DIST_DIR/);
assert.match(server, /BLORA_DIST_DIR/);
for (const name of fs.readdirSync(path.join(root, 'public/pages')).filter((n) => n.endsWith('.html') && !n.endsWith('.bak'))) {
  const html = fs.readFileSync(path.join(root, 'public/pages', name), 'utf8');
  for (const marker of ['/blora/blora.css', '/blora/tokens.css', '/blora/tokens.dark.css', '/blora/auto.js', '/js/blora-foundation.js']) assert.ok(html.includes(marker), `${name} missing ${marker}`);
}
console.log('Blora foundation static checks passed.');
