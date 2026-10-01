'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packageFile = require.resolve('@bloret-crew/blora-design/package.json');
const packageRoot = path.join(path.dirname(packageFile), 'dist');
const packageInfo = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
if (packageInfo.version !== '2.1.0') throw new Error(`Expected Blora 2.1.0, got ${packageInfo.version}`);
const targetRoot = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'blora-design');

function copyCssAssets(sourceRoot, relative = '') {
  for (const entry of fs.readdirSync(path.join(sourceRoot, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) copyCssAssets(sourceRoot, child);
    else if (entry.isFile() && entry.name.endsWith('.css')) {
      const source = path.join(sourceRoot, child);
      const target = path.join(targetRoot, child);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}

if (!fs.existsSync(packageRoot)) throw new Error(`Missing official Blora package: ${packageRoot}`);
for (const name of ['blora.css', 'tokens.dark.css', 'blora.global.js', 'icons-full.global.js']) {
  if (!packageInfo.exports[`./${name}`]) throw new Error(`Missing public Blora entry: ${name}`);
}
fs.rmSync(targetRoot, { recursive: true, force: true });
copyCssAssets(packageRoot);
for (const name of ['blora.global.js', 'icons-full.global.js']) {
  fs.copyFileSync(path.join(packageRoot, name), path.join(targetRoot, name));
}
console.log(`Prepared official Blora CSS assets in ${path.relative(process.cwd(), targetRoot)}`);
