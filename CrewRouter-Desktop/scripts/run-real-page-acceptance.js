'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
const desktop = path.resolve(__dirname, '..');
const output = path.join(root, '.hermes', 'screenshots');
function freePort() { return new Promise((resolve, reject) => { const server = http.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); server.on('error', reject); }); }
function waitFor(url) { return new Promise((resolve, reject) => { const deadline = Date.now() + 60000; const poll = () => http.get(url, response => { let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => response.statusCode >= 200 && response.statusCode < 500 ? resolve({ status: response.statusCode, body }) : setTimeout(poll, 300)); }).on('error', () => Date.now() < deadline ? setTimeout(poll, 300) : reject(new Error(`Timed out waiting for ${url}`))); poll(); }); }
function startTeam(port) { const env = { ...process.env, CR_APP_PORT: String(port), CR_APP_HOST: '127.0.0.1', CR_DEMO: 'true', CR_RUNTIME: 'server', CR_EDITION: 'team', CR_CONFIG_PATH: path.join(os.tmpdir(), `crewrouter-no-config-${process.pid}.json`), NODE_ENV: 'development' }; const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', () => {}); child.stderr.on('data', () => {}); return child; }
(async () => { const port = await freePort(); const team = startTeam(port); try { await waitFor(`http://127.0.0.1:${port}/api/version`); const env = { ...process.env, CREWROUTER_TEAM_URL: `http://127.0.0.1:${port}`, CREWROUTER_CAPTURE_OUTPUT: output }; const result = spawnSync('xvfb-run', ['-a', path.join(desktop, 'node_modules/.bin/electron'), '--disable-gpu', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), path.join(desktop, 'scripts/capture-real-pages.js')], { cwd: desktop, env, stdio: 'inherit' }); if (result.status !== 0) throw new Error(`real page acceptance failed with exit code ${result.status}`); } finally { team.kill('SIGTERM'); } })().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
