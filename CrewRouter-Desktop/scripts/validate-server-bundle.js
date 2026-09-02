'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.env.CREWROUTER_STAGE_ROOT || process.argv[2] || path.join(__dirname, '..', 'staging', 'server'));
const required = ['server.js', 'package.json', 'public', 'lang'];
const forbidden = /(^|\/)(?:\.env(?:\..*)?|.*\.(?:db|sqlite|sqlite3)|credentials?|secrets?)(?:$|\/)/i;

if (!fs.existsSync(root)) throw new Error(`Server staging directory not found: ${root}`);
for (const item of required) if (!fs.existsSync(path.join(root, item))) throw new Error(`Server bundle is missing ${item}`);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageJson.main !== 'server.js') throw new Error('Server bundle package.json must use server.js as main');
const unsafe = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = path.relative(root, path.join(dir, entry.name));
    if (forbidden.test(relative)) unsafe.push(relative);
    if (entry.isDirectory()) walk(path.join(dir, entry.name));
  }
}
walk(root);
if (unsafe.length) throw new Error(`Unsafe files found in server bundle: ${unsafe.join(', ')}`);
console.log(JSON.stringify({ root, required, dependencies: Object.keys(packageJson.dependencies || {}).length, safe: true }));
