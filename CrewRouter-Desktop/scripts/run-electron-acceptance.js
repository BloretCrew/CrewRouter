'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-electron-acceptance-'));
const output = path.join(root, '.hermes', 'screenshots');
const sourceElectron = path.join(root, 'node_modules', '.bin', 'electron');
const packagedElectron = path.join(root, 'dist', 'linux-unpacked', 'crewrouter-desktop');
// 使用正式源码 main 运行验收；打包 Server 由 test:packaged-server 单独验证。
const electron = sourceElectron;
const electronArgs = ['--disable-gpu', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])];

function run(phase) {
  const env = { ...process.env, CREWROUTER_ACCEPTANCE_USER_DATA: userData, CREWROUTER_ACCEPTANCE_PHASE: phase, CREWROUTER_ACCEPTANCE_OUTPUT: output };
  delete env.CREWROUTER_SERVER_ROOT;
  delete env.CREWROUTER_PACKAGED_SERVER_ROOT;
  const args = [...electronArgs, 'scripts/capture-local-username.js'];
  const result = spawnSync('xvfb-run', ['-a', electron, ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`Electron ${phase} acceptance failed with exit code ${result.status}`);
}

try {
  fs.mkdirSync(output, { recursive: true });
  run('first');
  run('restart');
  console.log(JSON.stringify({ userData, screenshots: ['local-username-oobe-960x700.png', 'local-username-console-960x700.png', 'local-username-console-600x700.png'] }));
} finally {
  fs.rmSync(userData, { recursive: true, force: true });
}
