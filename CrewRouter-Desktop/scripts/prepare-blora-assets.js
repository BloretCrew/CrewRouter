'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.join(__dirname, '..', 'node_modules', '@bloret-crew', 'blora-design', 'dist');
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
copyCssAssets(packageRoot);
console.log(`Prepared official Blora CSS assets in ${path.relative(process.cwd(), targetRoot)}`);
