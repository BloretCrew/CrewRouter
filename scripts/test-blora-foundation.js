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
assert.ok(!pkg.dependencies['@fluentui/web-components']);
assert.ok(!lock.packages[''].dependencies?.['@fluentui/web-components']);
assert.ok(!Object.keys(lock.packages).some((name) => name.includes('@fluentui/')));
assert.strictEqual(lock.packages[''].dependencies['@bloret-crew/blora-design'], '2.0.8');
assert.strictEqual(blora.version, '2.0.8');
assert.strictEqual(blora.exports['./auto'].import, './dist/auto.js');
assert.strictEqual(blora.exports['./blora.css'], './dist/blora.css');
for (const file of ['blora.css', 'tokens.css', 'tokens.dark.css', 'auto.js']) assert.ok(fs.existsSync(path.join(root, 'node_modules/@bloret-crew/blora-design/dist', file)), `missing dist/${file}`);
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
assert.match(server, /app\.use\('\/blora',\s*createBloraResourceRouter\(\)/);
assert.match(server, /require\('\.\/blora-resources'\)/);
const resources = require(path.join(root, 'server/blora-resources.js'));
assert.strictEqual(resources.EXPECTED_VERSION, '2.0.8');
const pageNames = fs.readdirSync(path.join(root, 'public/pages')).filter((n) => n.endsWith('.html') && !n.endsWith('.bak'));
assert.strictEqual(pageNames.length, 13);
for (const name of pageNames) {
  const html = fs.readFileSync(path.join(root, 'public/pages', name), 'utf8');
  for (const marker of ['/blora/blora.css?v=2.0.8', '/blora/tokens.dark.css?v=2.0.8', '/blora/auto.js?v=2.0.8', '/js/blora-foundation.js']) assert.ok(html.includes(marker), `${name} missing ${marker}`);
  assert.ok(/<body\b[^>]*class=["'][^"']*\bblora-page\b/.test(html), `${name} missing blora-page scope`);
  assert.strictEqual([...html.matchAll(/\/blora\/(?:blora\.css|tokens\.dark\.css|auto\.js)\?v=([^"']+)/g)].every((m) => m[1] === '2.0.8'), true);
  assert.ok(html.indexOf("data-blora-color-scheme") < html.indexOf('/blora/blora.css'), `${name} theme bootstrap must precede Blora CSS`);
}
console.log('Blora foundation static checks passed.');
