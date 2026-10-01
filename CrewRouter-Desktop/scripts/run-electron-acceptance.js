'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.resolve(root, '..', '.hermes', 'screenshots');
const electron = path.join(root, 'node_modules', '.bin', 'electron');
if (path.relative(path.resolve(root, '..'), output).startsWith('..')) throw new Error(`Electron acceptance output must be in repository root: ${output}`);
const electronArgs = ['--disable-gpu', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])];

// 每个脚本都跑两个阶段：first（首次 OOBE）与 restart（同一 userData 重启后自动连接）。
const scenarios = [
  { script: 'scripts/capture-local-username.js', screenshots: ['launcher-welcome-960x700.png', 'local-username-oobe-960x700.png', 'launcher-local-progress-960x700.png', 'personal-model-library-960x700.png', 'personal-model-library-600x700.png'] },
  { script: 'scripts/capture-desktop-settings.js', screenshots: ['console-desktop-settings-960x700.png', 'launcher-saved-960x700.png', 'desktop-settings-local-960x700.png', 'desktop-settings-local-600x700.png'] },
];

function run(script, phase, userData) {
  const env = { ...process.env, CREWROUTER_ACCEPTANCE_USER_DATA: userData, CREWROUTER_ACCEPTANCE_PHASE: phase, CREWROUTER_ACCEPTANCE_OUTPUT: output };
  delete env.CREWROUTER_SERVER_ROOT;
  delete env.CREWROUTER_PACKAGED_SERVER_ROOT;
  const result = spawnSync('xvfb-run', ['-a', electron, ...electronArgs, script], { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Electron ${script} (${phase}) acceptance failed with exit code ${result.status}`);
}

fs.mkdirSync(output, { recursive: true });
const produced = [];
for (const scenario of scenarios) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-electron-acceptance-'));
  try {
    run(scenario.script, 'first', userData);
    run(scenario.script, 'restart', userData);
    for (const file of scenario.screenshots) {
      if (!fs.existsSync(path.join(output, file))) throw new Error(`Missing screenshot ${file} from ${scenario.script}`);
      produced.push(file);
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ output, screenshots: produced }));
