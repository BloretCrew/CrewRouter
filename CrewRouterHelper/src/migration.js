'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { configPath, loadConfig, saveConfig } = require('./config');
const { hookPath, EVENTS, hookConfig, installCommand } = require('./hooks');

function backupDir() { return process.env.CR_REPORT_BACKUP_DIR || path.join(path.dirname(configPath()), 'crewrouter-helper-backups'); }
function safeId(id) { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(String(id))) throw new Error('备份 ID 无效'); return String(id); }
function fileDigest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function allowedTarget(name) { return name === 'config.json' ? path.resolve(configPath()) : name === 'hook.json' ? path.resolve(hookPath()) : null; }
function listMigrationBackups() { try { return fs.readdirSync(backupDir(), { withFileTypes: true }).filter(x => x.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(x.name)).map(x => { const files = []; for (const name of ['config.json', 'hook.json']) if (fs.existsSync(path.join(backupDir(), x.name, name))) files.push(name); return { id: x.name, files, path: path.join(backupDir(), x.name) }; }).sort((a, b) => b.id.localeCompare(a.id)); } catch { return []; } }
function createBackup() {
  const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const dir = path.join(backupDir(), id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifest = { version: 1, id, created_at: new Date().toISOString(), files: [] };
  for (const [source, name] of [[configPath(), 'config.json'], [hookPath(), 'hook.json']]) {
    try {
      if (fs.statSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink()) {
        const target = path.join(dir, name); fs.copyFileSync(source, target); fs.chmodSync(target, 0o600);
        manifest.files.push({ name, path: name, sha256: fileDigest(source) });
      }
    } catch {}
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { id, path: dir, files: manifest.files.map(x => x.name) };
}
function backupPath(id) { const dir = path.join(backupDir(), safeId(id)); const root = path.resolve(backupDir()); if (path.dirname(dir) !== root || !fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('备份不存在'); return dir; }
function parseManifest(dir, id) {
  let manifest; try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { throw new Error('备份 manifest 损坏'); }
  if (!manifest || manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 2) throw new Error('备份 manifest 无效');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || !['config.json', 'hook.json'].includes(entry.name) || entry.path !== entry.name || seen.has(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('备份 manifest 文件项无效');
    seen.add(entry.name);
    const source = path.join(dir, entry.path);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || fileDigest(source) !== entry.sha256) throw new Error(`备份文件校验失败: ${entry.name}`);
    if (!allowedTarget(entry.name)) throw new Error('备份目标路径不受控');
  }
  return manifest;
}
function atomicCopy(source, target) { const tmp = `${target}.${process.pid}.${Date.now()}.tmp`; try { fs.copyFileSync(source, tmp); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, target); } finally { try { fs.unlinkSync(tmp); } catch {} } }
function snapshot(target) { if (!fs.existsSync(target)) return null; const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('当前目标文件不受控'); const tmp = `${target}.${process.pid}.${Date.now()}.snapshot`; fs.copyFileSync(target, tmp); return tmp; }
function restoreBackup(id) {
  const dir = backupPath(id); const manifest = parseManifest(dir, id); const snapshots = []; const staged = [];
  try {
    for (const entry of manifest.files) { const target = allowedTarget(entry.name); snapshots.push({ target, copy: snapshot(target) }); const tmp = `${target}.${process.pid}.${Date.now()}.restore`; fs.copyFileSync(path.join(dir, entry.path), tmp); fs.chmodSync(tmp, 0o600); staged.push({ target, tmp }); }
    for (const item of staged) fs.renameSync(item.tmp, item.target);
    return { id, restored: manifest.files.map(x => x.name) };
  } catch (err) {
    for (const item of staged) { try { fs.unlinkSync(item.tmp); } catch {} }
    const rollbackErrors = [];
    for (const item of snapshots.reverse()) { try { if (item.copy) atomicCopy(item.copy, item.target); else fs.rmSync(item.target, { force: true }); } catch (rollbackErr) { rollbackErrors.push(rollbackErr.message); } try { if (item.copy) fs.unlinkSync(item.copy); } catch {} }
    if (rollbackErrors.length) throw new Error(`恢复失败，回滚也失败：${rollbackErrors.join('; ')}`);
    throw new Error(`恢复失败，已回滚：${err.message}`);
  } finally { for (const item of snapshots) try { if (item.copy) fs.unlinkSync(item.copy); } catch {} }
}
function planMigration() { const cfg = loadConfig(); const actions = []; let next = cfg ? { ...cfg } : null; if (cfg && !cfg.profiles && cfg.url) { const profile = {}; for (const k of ['url', 'key', 'access_token', 'refresh_token', 'expires_at', 'client_id', 'scope']) if (cfg[k] !== undefined) profile[k] = cfg[k]; next = { profiles: { default: profile }, current_profile: 'default', ...profile }; actions.push('将旧 Python 单配置转换为 default profile'); } if (cfg && cfg.profiles && !cfg.current_profile) { next.current_profile = 'default' in cfg.profiles ? 'default' : Object.keys(cfg.profiles)[0]; actions.push('补充 current_profile'); } try { const data = JSON.parse(fs.readFileSync(hookPath(), 'utf8')); const command = data.hooks?.SessionStart?.[0]?.hooks?.[0]?.command; if (typeof command === 'string' && /cr-report\.py(?:\s|$)/.test(command)) actions.push('将 Helper 旧 Python Hook 路径迁移到当前 CLI'); } catch {} return { dry_run: true, actions, config: next, hook: actions.some(x => x.includes('Hook')) }; }
function migrate(yes = false) { const plan = planMigration(); if (!yes) return plan; if (!plan.actions.length) return { dry_run: false, changed: false, actions: [] }; const backup = createBackup(); try { if (plan.config) saveConfig(plan.config); let data; try { data = JSON.parse(fs.readFileSync(hookPath(), 'utf8')); } catch { data = null; } if (data) { const old = data.hooks?.SessionStart?.[0]?.hooks?.[0]?.command; if (typeof old === 'string' && /cr-report\.py(?:\s|$)/.test(old)) { const replacement = hookConfig(installCommand(path.resolve(__dirname, '../bin/cr-report.js'))); for (const event of EVENTS) if (data.hooks?.[event]) data.hooks[event] = replacement.hooks[event]; atomicWriteJson(hookPath(), data); } } return { dry_run: false, changed: true, backup_id: backup.id, actions: plan.actions }; } catch (err) { try { restoreBackup(backup.id); } catch (rollbackErr) { throw new Error(`迁移失败，回滚失败：${rollbackErr.message}; 原因：${err.message}`); } throw new Error(`迁移失败，已回滚：${err.message}`); } }
function atomicWriteJson(target, data) { const tmp = `${target}.${process.pid}.${Date.now()}.tmp`; try { fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, target); } finally { try { fs.unlinkSync(tmp); } catch {} } }
function rollback(id) { const selected = id || listMigrationBackups()[0]?.id; if (!selected) throw new Error('没有可回滚备份'); return restoreBackup(selected); }
module.exports = { backupDir, listMigrationBackups, createBackup, restoreBackup, planMigration, migrate, rollback, safeId };
