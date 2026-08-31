'use strict';
const fs = require('fs');
const path = require('path');
const { hookPath } = require('./hooks');
function dir() { return path.join(path.dirname(hookPath()), 'backups'); }
function backup() { if (!fs.existsSync(hookPath())) throw new Error('Helper Hook 不存在'); fs.mkdirSync(dir(), { recursive: true }); const target = path.join(dir(), `crewrouter-helper.${Date.now()}.json`); fs.copyFileSync(hookPath(), target); fs.chmodSync(target, 0o600); return target; }
function listBackups() { try { return fs.readdirSync(dir()).filter((n) => /^crewrouter-helper\.\d+\.json$/.test(n)).sort().reverse().map((n) => ({ name: n, path: path.join(dir(), n) })); } catch { return []; } }
function restore(file) { const target = file ? path.resolve(file) : listBackups()[0]?.path; if (!target || !fs.existsSync(target)) throw new Error('备份不存在'); let data; try { data = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { throw new Error('备份 JSON 损坏'); } if (!data || typeof data !== 'object' || !data.hooks) throw new Error('备份格式无效'); const tmp = `${hookPath()}.${process.pid}.restore.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, hookPath()); return hookPath(); }
module.exports = { backup, listBackups, restore };
