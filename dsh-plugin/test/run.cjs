'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.resolve(__dirname, '..');
const hostRoot = path.resolve(process.env.DSH_INSTALL_ROOT || '/opt/dsh/dsh');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-dsh-plugin-tests-'));
try {
  if (!fs.existsSync(path.join(hostRoot, 'package.json'))) throw new Error(`DSH installation root not found: ${hostRoot}`);
  const pkg = path.join(temp, 'package');
  fs.mkdirSync(pkg, { recursive: true });
  fs.copyFileSync(path.join(source, 'index.js'), path.join(pkg, 'index.js'));
  fs.copyFileSync(path.join(source, 'package.json'), path.join(pkg, 'package.json'));
  fs.cpSync(path.join(source, 'test'), path.join(pkg, 'test'), { recursive: true, filter: input => !input.endsWith('run.cjs') && !input.endsWith('credential-key.test.js') && !input.endsWith('loader-smoke.js') });
  const nodeModules = path.join(pkg, 'node_modules');
  const scope = path.join(nodeModules, '@deepseek-ai');
  fs.mkdirSync(scope, { recursive: true });
  for (const name of ['dsh-tools', 'dsh-credentials', 'schemastery']) {
    const target = path.join(hostRoot, 'node_modules', '@deepseek-ai', name);
    fs.symlinkSync(target, path.join(scope, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const result = spawnSync(process.execPath, ['--test', path.join(pkg, 'test', 'plugin.test.js')], {
    cwd: pkg,
    env: { ...process.env, DSH_INSTALL_ROOT: hostRoot },
    stdio: 'inherit',
    timeout: 60000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
