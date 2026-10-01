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

// 内置 PostgreSQL：当前平台的 @embedded-postgres 二进制必须存在且可执行，否则打包后的本地模式无法使用。
const platformPackage = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const binaryRoot = path.join(__dirname, '..', 'node_modules', platformPackage);
const postgresBinary = path.join(binaryRoot, 'native', 'bin', process.platform === 'win32' ? 'postgres.exe' : 'postgres');
let embedded = { package: platformPackage, present: false, executable: false };
if (process.env.CREWROUTER_SKIP_EMBEDDED_POSTGRES_CHECK !== '1') {
  if (!fs.existsSync(binaryRoot)) throw new Error(`Embedded PostgreSQL package ${platformPackage} is not installed; run npm install on the target platform`);
  if (!fs.existsSync(postgresBinary)) throw new Error(`Embedded PostgreSQL binary not found: ${postgresBinary}`);
  try { fs.accessSync(postgresBinary, fs.constants.X_OK); } catch { throw new Error(`Embedded PostgreSQL binary is not executable: ${postgresBinary}`); }
  embedded = { package: platformPackage, present: true, executable: true };
}
console.log(JSON.stringify({ root, required, dependencies: Object.keys(packageJson.dependencies || {}).length, safe: true, embedded }));
