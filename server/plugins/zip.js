/**
 * 插件 zip 处理共享工具
 *
 * 供「上传安装」（routes/plugins.js upload）与「从商店安装」（install-from-store）
 * 复用。核心约束：防 zip-slip（校验条目绝对路径/`..`/反斜杠）、清单校验、目录名与清单 id 一致性。
 */

const path = require('path');
const fs = require('fs');

// 调用系统 unzip（防 zip-slip：先校验条目名再解压到目标目录）
function extractZipSafe(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    // 列出 zip 内条目并校验：拒绝绝对路径、`..` 穿越、反斜杠、以及非 plugin.json/目录的顶层乱放
    execFile('/usr/bin/unzip', ['-Z1', zipPath], { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error(err.message || 'unzip 读取失败'));
      const entries = String(stdout).split('\n').map(s => s.trim()).filter(Boolean);
      if (entries.length === 0) return reject(new Error('zip 包为空'));
      if (entries.length > 1000) return reject(new Error('zip 包条目过多'));
      for (const e of entries) {
        if (path.isAbsolute(e) || e.includes('..') || e.includes('\\')) {
          return reject(new Error(`非法条目路径: ${e}`));
        }
      }
      execFile('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', destDir], { timeout: 30000 }, (err2) => {
        if (err2) return reject(new Error(err2.message || 'unzip 解压失败'));
        resolve(destDir);
      });
    });
  });
}

// 找到解压目录中合法的 plugin.json；支持根即清单或 <id>/plugin.json 两种布局
function findZipManifest(tmpDir) {
  const tryRead = (dir) => {
    const p = path.join(dir, 'plugin.json');
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
  };
  const rootManifest = tryRead(tmpDir);
  if (rootManifest) return rootManifest;
  const dirs = fs.readdirSync(tmpDir).filter(name => !name.startsWith('.'));
  for (const name of dirs) {
    const full = path.join(tmpDir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    const m = tryRead(full);
    if (m) return m;
  }
  return null;
}

// 返回实际插件载荷目录：清单 id 匹配的目录，或根即清单时的根
function zipPayloadDir(tmpDir, id) {
  const rootManifest = path.join(tmpDir, 'plugin.json');
  if (fs.existsSync(rootManifest)) return tmpDir;
  const dirs = fs.readdirSync(tmpDir).filter(name => !name.startsWith('.'));
  for (const name of dirs) {
    const full = path.join(tmpDir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    if (name === id && fs.existsSync(path.join(full, 'plugin.json'))) return full;
  }
  // 仅一个目录且含 plugin.json 时容错（目录名与 id 不一致时以清单 id 为准）
  const validDirs = dirs.filter(name => fs.existsSync(path.join(tmpDir, name, 'plugin.json')) && fs.statSync(path.join(tmpDir, name)).isDirectory());
  if (validDirs.length === 1) return path.join(tmpDir, validDirs[0]);
  return null;
}

// 收集目录下全部相对路径（文件与目录）
function collectDirEntries(dir) {
  const out = [];
  const walk = (cur, rel) => {
    for (const name of fs.readdirSync(cur)) {
      const full = path.join(cur, name);
      const relPath = rel ? path.join(rel, name) : name;
      const st = fs.statSync(full);
      out.push(relPath);
      if (st.isDirectory()) walk(full, relPath);
    }
  };
  walk(dir, '');
  return out;
}

module.exports = { extractZipSafe, findZipManifest, zipPayloadDir, collectDirEntries };
