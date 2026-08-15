/**
 * 自动更新模块
 *
 * 检查官方版本、下载安装包、覆盖程序文件并重启进程。
 * 面向 self-hosted 直接运行（dist/ 布局）；Docker / 只读环境仅允许检查。
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const Logger = require('../logger');
const config = require('../config-loader');

const execFileAsync = promisify(execFile);

const UPDATE_VERSION_URL =
  process.env.CR_UPDATE_VERSION_URL || 'https://router.crantai.com/api/version';
const UPDATE_PACKAGE_URL =
  process.env.CR_UPDATE_PACKAGE_URL || 'https://router.crantai.com/api/updates/latest';

/** 安装时允许覆盖的顶层文件/目录（相对 payload 根） */
const OVERWRITE_ENTRIES = [
  'server.js',
  'public',
  'package.json',
  'config.example.json',
];

/** 绝对不能覆盖 */
const PRESERVE_NAMES = new Set([
  'config.json',
  'node_modules',
  'data',
  'log',
  'logs',
  '.env',
  'updates',
]);

// ---------- 状态机 ----------
const state = {
  phase: 'idle', // idle | checking | downloading | extracting | installing | restarting | error | up_to_date
  message: '',
  progress: 0,
  currentVersion: null,
  latestVersion: null,
  latestName: null,
  hasUpdate: false,
  canApply: false,
  reason: null,
  error: null,
  lastCheckedAt: null,
  updatedAt: null,
};

let applyLock = false;

function setState(partial) {
  Object.assign(state, partial);
  state.updatedAt = new Date().toISOString();
  Logger.info(
    `[update] 状态: phase=${state.phase} progress=${state.progress}% message=${state.message || '-'}`
  );
}

function getStatus() {
  return {
    phase: state.phase,
    message: state.message,
    progress: state.progress,
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    latestName: state.latestName,
    hasUpdate: state.hasUpdate,
    canApply: state.canApply,
    reason: state.reason,
    error: state.error,
    lastCheckedAt: state.lastCheckedAt,
    updatedAt: state.updatedAt,
    versionUrl: UPDATE_VERSION_URL,
    packageUrl: UPDATE_PACKAGE_URL,
  };
}

// ---------- 版本比较 ----------
function parseSemver(v) {
  if (!v || typeof v !== 'string') return null;
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * @returns {number} -1 if a<b, 0 if equal, 1 if a>b
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      if (pa[i] < pb[i]) return -1;
      if (pa[i] > pb[i]) return 1;
    }
    return 0;
  }
  // 非标准：字符串全等视为相同，否则视为有更新（远程更新）
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (sa === sb) return 0;
  return -1;
}

// ---------- 运行环境探测 ----------
function isDockerEnv() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch (_) {
    /* ignore */
  }
  if (process.env.CR_DISABLE_AUTO_UPDATE === '1' || process.env.CR_DISABLE_AUTO_UPDATE === 'true') {
    return true;
  }
  return false;
}

function readLocalVersion(appRoot) {
  const candidates = [
    appRoot && path.join(appRoot, 'package.json'),
    path.join(__dirname, 'package.json'),
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (pkg.version) return { version: pkg.version, path: p };
      }
    } catch (err) {
      Logger.warn(`[update] 读取 package.json 失败: ${p} — ${err.message}`);
    }
  }
  return {
    version: process.env.npm_package_version || config.app?.version || '0.0.0',
    path: null,
  };
}

/**
 * 定位应用根目录（生产 dist：含 server.js + package.json）
 */
function resolveAppRoot() {
  const candidates = [
    // 构建后：updater 打进 server.js，__dirname 为 dist/
    path.join(__dirname),
    path.join(__dirname, '..'),
    process.cwd(),
    path.join(process.cwd(), 'dist'),
  ];

  for (const dir of candidates) {
    try {
      const serverJs = path.join(dir, 'server.js');
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(serverJs) && fs.existsSync(pkg)) {
        return dir;
      }
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

function canWriteDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    // 尝试创建临时文件
    const probe = path.join(dir, `.update-write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 是否从源码入口运行（server/index.js / nodemon），而非 dist/server.js
 */
function isRunningFromSource() {
  const entry = process.argv[1] || '';
  if (/[/\\]server[/\\]index\.js$/.test(entry)) return true;
  // 未打包时本文件位于 server/utils/
  if (/[/\\]server[/\\]utils$/.test(__dirname)) return true;
  return false;
}

function getRuntimeInfo() {
  const docker = isDockerEnv();
  const fromSource = isRunningFromSource();
  // 源码模式不把项目里的 dist/ 当成当前运行目录去覆盖
  const appRoot = fromSource ? null : resolveAppRoot();
  const { version: currentVersion } = readLocalVersion(appRoot);
  const isDistLayout = !!(appRoot && fs.existsSync(path.join(appRoot, 'server.js')));

  let canApply = true;
  let reason = null;

  if (docker) {
    canApply = false;
    reason = '当前运行在 Docker 或已禁用自动更新（CR_DISABLE_AUTO_UPDATE）。请通过重建镜像 / docker compose 更新。';
  } else if (fromSource) {
    canApply = false;
    reason = '当前为源码开发模式，自动更新仅支持构建后的 dist 直接运行部署。';
  } else if (!appRoot) {
    canApply = false;
    reason = '未检测到可更新的 dist 布局（需要与 server.js 同级的 package.json）。';
  } else if (!canWriteDir(appRoot)) {
    canApply = false;
    reason = `应用目录不可写: ${appRoot}`;
  }

  return {
    appRoot,
    currentVersion,
    canApply,
    reason,
    isDocker: docker,
    isDistLayout,
    fromSource,
  };
}

// ---------- 检查更新 ----------
async function checkForUpdate() {
  setState({
    phase: 'checking',
    message: '正在检查更新…',
    progress: 0,
    error: null,
  });

  const runtime = getRuntimeInfo();
  state.currentVersion = runtime.currentVersion;
  state.canApply = runtime.canApply;
  state.reason = runtime.reason;

  try {
    Logger.info(
      `[update] 请求版本信息: url=${UPDATE_VERSION_URL} local=${runtime.currentVersion}`
    );
    const resp = await axios.get(UPDATE_VERSION_URL, {
      timeout: 12000,
      headers: {
        Accept: 'application/json',
        'User-Agent': `CrewRouter-Updater/${runtime.currentVersion}`,
      },
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const remote = resp.data || {};
    const latestVersion = remote.version || remote.latest || null;
    const latestName = remote.name || null;

    if (!latestVersion) {
      throw new Error('官方版本接口未返回 version 字段');
    }

    const cmp = compareSemver(runtime.currentVersion, latestVersion);
    const hasUpdate = cmp < 0;

    state.latestVersion = latestVersion;
    state.latestName = latestName;
    state.hasUpdate = hasUpdate;
    state.lastCheckedAt = new Date().toISOString();

    if (hasUpdate) {
      setState({
        phase: 'idle',
        message: `发现新版本 ${latestVersion}`,
        progress: 0,
        hasUpdate: true,
      });
    } else {
      setState({
        phase: 'up_to_date',
        message: '已是最新版本',
        progress: 100,
        hasUpdate: false,
      });
    }

    Logger.success(
      `[update] 检查完成: local=${runtime.currentVersion} remote=${latestVersion} hasUpdate=${hasUpdate} canApply=${runtime.canApply}`
    );

    return {
      currentVersion: runtime.currentVersion,
      latestVersion,
      latestName,
      hasUpdate,
      canApply: runtime.canApply,
      reason: runtime.reason,
      remote,
      appRoot: runtime.appRoot,
      isDocker: runtime.isDocker,
      packageUrl: UPDATE_PACKAGE_URL,
      versionUrl: UPDATE_VERSION_URL,
      lastCheckedAt: state.lastCheckedAt,
    };
  } catch (err) {
    const msg = err.response
      ? `版本检查失败: HTTP ${err.response.status}`
      : `版本检查失败: ${err.message}`;
    Logger.error(`[update] ${msg}`, err.message);
    setState({
      phase: 'error',
      message: msg,
      error: msg,
      progress: 0,
    });
    throw Object.assign(new Error(msg), { statusCode: 502 });
  }
}

// ---------- 文件系统辅助 ----------
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmrf(target) {
  if (!target || !fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

function findPayloadRoot(extractDir, maxDepth = 5) {
  const queue = [{ dir: extractDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    const hasServer = entries.includes('server.js');
    const hasPkg = entries.includes('package.json');
    if (hasServer && hasPkg) {
      return dir;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isDirectory()) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
  return null;
}

function findArchives(dir, maxDepth = 3) {
  const result = [];
  const queue = [{ dir, depth: 0 }];
  while (queue.length) {
    const { dir: d, depth } = queue.shift();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(d);
    } catch (_) {
      continue;
    }
    for (const name of entries) {
      const full = path.join(d, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (st.isDirectory()) {
        queue.push({ dir: full, depth: depth + 1 });
      } else if (/\.(tar\.gz|tgz)$/i.test(name)) {
        result.push(full);
      }
    }
  }
  return result;
}

async function runCmd(bin, args, opts = {}) {
  Logger.info(`[update] 执行: ${bin} ${args.join(' ')}`);
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: opts.timeout || 120000,
      cwd: opts.cwd,
      env: process.env,
    });
    if (stdout && stdout.trim()) {
      Logger.info(`[update] ${bin} stdout: ${stdout.trim().slice(0, 500)}`);
    }
    if (stderr && stderr.trim()) {
      Logger.info(`[update] ${bin} stderr: ${stderr.trim().slice(0, 500)}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`未找到命令 ${bin}，请安装后重试（如 apt install unzip tar）`);
    }
    const detail = (err.stderr || err.stdout || err.message || '').toString().slice(0, 800);
    throw new Error(`${bin} 失败: ${detail}`);
  }
}

async function downloadPackage(destFile) {
  ensureDir(path.dirname(destFile));
  if (fs.existsSync(destFile)) fs.unlinkSync(destFile);

  Logger.info(`[update] 开始下载: ${UPDATE_PACKAGE_URL} → ${destFile}`);
  setState({ phase: 'downloading', message: '正在下载更新包…', progress: 5, error: null });

  const resp = await axios.get(UPDATE_PACKAGE_URL, {
    responseType: 'stream',
    timeout: 10 * 60 * 1000,
    headers: {
      'User-Agent': `CrewRouter-Updater/${state.currentVersion || 'unknown'}`,
    },
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const total = parseInt(resp.headers['content-length'] || '0', 10) || 0;
  let received = 0;

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destFile);
    resp.data.on('data', (chunk) => {
      received += chunk.length;
      if (total > 0) {
        const pct = Math.min(45, 5 + Math.floor((received / total) * 40));
        if (pct !== state.progress) {
          state.progress = pct;
          state.message = `正在下载更新包… ${Math.round((received / total) * 100)}%`;
        }
      }
    });
    resp.data.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    resp.data.pipe(ws);
  });

  const stat = fs.statSync(destFile);
  if (stat.size < 100) {
    throw new Error(`下载的更新包过小（${stat.size} 字节），可能不是有效文件`);
  }
  Logger.success(`[update] 下载完成: size=${stat.size} path=${destFile}`);
  setState({
    phase: 'downloading',
    message: `下载完成（${(stat.size / 1024 / 1024).toFixed(2)} MB）`,
    progress: 50,
  });
  return destFile;
}

async function extractPackage(zipPath, extractDir) {
  setState({ phase: 'extracting', message: '正在解压更新包…', progress: 55, error: null });
  rmrf(extractDir);
  ensureDir(extractDir);

  await runCmd('unzip', ['-o', zipPath, '-d', extractDir], { timeout: 180000 });

  // 若 zip 内是 tar.gz，继续展开
  const archives = findArchives(extractDir);
  for (const archive of archives) {
    Logger.info(`[update] 展开归档: ${archive}`);
    await runCmd('tar', ['-xzf', archive, '-C', extractDir], { timeout: 180000 });
  }

  const payloadRoot = findPayloadRoot(extractDir);
  if (!payloadRoot) {
    throw new Error(
      '解压后未找到有效程序目录（需要同时包含 server.js 与 package.json）。请确认官方更新包格式正确。'
    );
  }
  Logger.success(`[update] 定位 payload: ${payloadRoot}`);
  setState({ phase: 'extracting', message: '解压完成', progress: 65 });
  return payloadRoot;
}

function backupCurrent(appRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(appRoot, 'data', 'updates', `backup-${stamp}`);
  ensureDir(backupDir);
  Logger.info(`[update] 备份当前程序 → ${backupDir}`);

  for (const name of OVERWRITE_ENTRIES) {
    const src = path.join(appRoot, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(backupDir, name);
    try {
      copyRecursive(src, dest);
      Logger.info(`[update] 已备份: ${name}`);
    } catch (err) {
      Logger.warn(`[update] 备份 ${name} 失败: ${err.message}`);
    }
  }
  return backupDir;
}

function restoreBackup(appRoot, backupDir) {
  if (!backupDir || !fs.existsSync(backupDir)) {
    Logger.warn('[update] 无备份可回滚');
    return;
  }
  Logger.warn(`[update] 尝试从备份回滚: ${backupDir}`);
  for (const name of OVERWRITE_ENTRIES) {
    const src = path.join(backupDir, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(appRoot, name);
    try {
      if (fs.existsSync(dest)) rmrf(dest);
      copyRecursive(src, dest);
      Logger.info(`[update] 已回滚: ${name}`);
    } catch (err) {
      Logger.error(`[update] 回滚 ${name} 失败: ${err.message}`);
    }
  }
}

function installPayload(payloadRoot, appRoot) {
  setState({ phase: 'installing', message: '正在安装更新文件…', progress: 70, error: null });

  for (const name of OVERWRITE_ENTRIES) {
    if (PRESERVE_NAMES.has(name)) continue;
    const src = path.join(payloadRoot, name);
    if (!fs.existsSync(src)) {
      Logger.info(`[update] payload 中无 ${name}，跳过`);
      continue;
    }
    const dest = path.join(appRoot, name);
    try {
      if (fs.existsSync(dest)) rmrf(dest);
      copyRecursive(src, dest);
      Logger.success(`[update] 已安装: ${name}`);
    } catch (err) {
      throw new Error(`安装 ${name} 失败: ${err.message}`);
    }
  }

  // 可选：更新上级 start.sh
  const startSrcCandidates = [
    path.join(payloadRoot, '..', 'start.sh'),
    path.join(payloadRoot, 'start.sh'),
  ];
  const parentDir = path.dirname(appRoot);
  for (const startSrc of startSrcCandidates) {
    if (fs.existsSync(startSrc) && canWriteDir(parentDir)) {
      const startDest = path.join(parentDir, 'start.sh');
      // 仅当上级已有 start.sh 或明确是 crewrouter 交付布局时覆盖
      if (fs.existsSync(startDest) || path.basename(parentDir).includes('crewrouter')) {
        try {
          fs.copyFileSync(startSrc, startDest);
          try {
            fs.chmodSync(startDest, 0o755);
          } catch (_) {
            /* ignore */
          }
          Logger.info(`[update] 已更新 start.sh → ${startDest}`);
        } catch (err) {
          Logger.warn(`[update] 更新 start.sh 失败: ${err.message}`);
        }
      }
      break;
    }
  }

  setState({ phase: 'installing', message: '文件安装完成', progress: 80 });
}

function depsChanged(oldPkgPath, newPkgPath) {
  try {
    if (!fs.existsSync(oldPkgPath) || !fs.existsSync(newPkgPath)) return true;
    const oldDeps = JSON.parse(fs.readFileSync(oldPkgPath, 'utf8')).dependencies || {};
    const newDeps = JSON.parse(fs.readFileSync(newPkgPath, 'utf8')).dependencies || {};
    return JSON.stringify(oldDeps) !== JSON.stringify(newDeps);
  } catch (_) {
    return true;
  }
}

async function maybeNpmInstall(appRoot, backupDir) {
  const oldPkg = backupDir ? path.join(backupDir, 'package.json') : null;
  const newPkg = path.join(appRoot, 'package.json');
  if (oldPkg && !depsChanged(oldPkg, newPkg)) {
    Logger.info('[update] package.json dependencies 未变化，跳过 npm install');
    return;
  }
  setState({
    phase: 'installing',
    message: '正在安装依赖（npm install）…',
    progress: 85,
  });
  Logger.info(`[update] 执行 npm install --omit=dev @ ${appRoot}`);
  await runCmd(
    'npm',
    ['install', '--omit=dev', '--no-fund', '--no-audit'],
    { cwd: appRoot, timeout: 10 * 60 * 1000 }
  );
  Logger.success('[update] npm install 完成');
}

function scheduleRestart(appRoot) {
  setState({
    phase: 'restarting',
    message: '即将重启服务…',
    progress: 95,
  });

  const underSystemd = !!(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);
  // pm2 / forever 等通常会在进程退出后拉起；避免双重启动
  const underProcessManager =
    underSystemd ||
    !!process.env.PM2_HOME ||
    !!process.env.PM2_JSON_PROCESSING ||
    process.env.CR_UPDATE_RESTART_MODE === 'exit-only';

  if (underProcessManager) {
    Logger.info(
      '[update] 检测到进程管理器（systemd/pm2 等），仅退出进程由其负责拉起新版本'
    );
    setTimeout(() => {
      Logger.info('[update] process.exit(0)（托管重启）');
      process.exit(0);
    }, 800);
    return;
  }

  const port = config.app?.port || 20003;
  const nodeBin = process.execPath;
  const serverEntry = path.join(appRoot, 'server.js');
  const helperPath = path.join(appRoot, 'data', 'updates', `restart-${process.pid}.sh`);
  ensureDir(path.dirname(helperPath));

  const script = `#!/bin/bash
# CrewRouter 自动更新重启助手 — 由 updater 生成
set -e
APP_DIR=${JSON.stringify(appRoot)}
NODE_BIN=${JSON.stringify(nodeBin)}
ENTRY=${JSON.stringify(serverEntry)}
PORT=${JSON.stringify(String(port))}
LOG_FILE="$APP_DIR/data/updates/restart.log"

mkdir -p "$(dirname "$LOG_FILE")"
echo "[$(date -Iseconds)] 等待端口 $PORT 释放后重启…" >> "$LOG_FILE"

for i in $(seq 1 60); do
  if command -v ss >/dev/null 2>&1; then
    if ! ss -ltn 2>/dev/null | grep -qE ":${port}\\\\s"; then
      break
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if ! lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
  else
    sleep 1
    break
  fi
  sleep 0.5
done

sleep 0.5
cd "$APP_DIR"
echo "[$(date -Iseconds)] 启动: $NODE_BIN $ENTRY" >> "$LOG_FILE"
exec "$NODE_BIN" "$ENTRY" >> "$LOG_FILE" 2>&1
`;

  fs.writeFileSync(helperPath, script, { mode: 0o755 });
  Logger.info(`[update] 已写入重启脚本: ${helperPath}`);

  const child = spawn('bash', [helperPath], {
    detached: true,
    stdio: 'ignore',
    cwd: appRoot,
    env: process.env,
  });
  child.unref();
  Logger.success(`[update] 重启助手已拉起 (pid=${child.pid})，当前进程将退出`);

  // 给 HTTP 响应一点时间 flush
  setTimeout(() => {
    Logger.info('[update] process.exit(0) 以完成更新重启');
    process.exit(0);
  }, 800);
}

// ---------- 应用更新 ----------
async function applyUpdate() {
  if (applyLock) {
    const err = new Error('已有更新任务正在进行');
    err.statusCode = 409;
    throw err;
  }
  applyLock = true;
  let backupDir = null;
  const runtime = getRuntimeInfo();

  try {
    if (!runtime.canApply) {
      const err = new Error(runtime.reason || '当前环境不支持一键更新');
      err.statusCode = 400;
      throw err;
    }

    const check = await checkForUpdate();
    if (!check.hasUpdate) {
      const err = new Error('当前已是最新版本，无需更新');
      err.statusCode = 400;
      throw err;
    }

    const appRoot = runtime.appRoot;
    const workDir = path.join(appRoot, 'data', 'updates');
    const zipPath = path.join(workDir, 'download', 'latest.zip');
    const extractDir = path.join(workDir, 'extract');

    ensureDir(workDir);
    await downloadPackage(zipPath);
    const payloadRoot = await extractPackage(zipPath, extractDir);

    backupDir = backupCurrent(appRoot);
    installPayload(payloadRoot, appRoot);
    await maybeNpmInstall(appRoot, backupDir);

    setState({
      phase: 'restarting',
      message: '更新安装完成，正在重启…',
      progress: 95,
      hasUpdate: false,
      currentVersion: state.latestVersion || check.latestVersion,
    });

    // 清理 extract（保留 backup 与 download 便于排查）
    try {
      rmrf(extractDir);
    } catch (_) {
      /* ignore */
    }

    Logger.success(
      `[update] 安装完成: ${check.currentVersion} → ${check.latestVersion}，准备重启`
    );

    // 异步调度重启，让调用方先拿到响应
    setImmediate(() => {
      try {
        scheduleRestart(appRoot);
      } catch (e) {
        Logger.error(`[update] 调度重启失败: ${e.message}`);
        setState({ phase: 'error', message: e.message, error: e.message });
        applyLock = false;
      }
    });

    return {
      success: true,
      restarting: true,
      fromVersion: check.currentVersion,
      toVersion: check.latestVersion,
      message: '更新安装完成，服务即将重启',
    };
  } catch (err) {
    Logger.error(`[update] 应用更新失败: ${err.message}`);
    if (backupDir && runtime.appRoot) {
      try {
        restoreBackup(runtime.appRoot, backupDir);
      } catch (re) {
        Logger.error(`[update] 回滚失败: ${re.message}`);
      }
    }
    setState({
      phase: 'error',
      message: err.message,
      error: err.message,
      progress: 0,
    });
    applyLock = false;
    throw err;
  }
}

module.exports = {
  checkForUpdate,
  applyUpdate,
  getStatus,
  getRuntimeInfo,
  compareSemver,
  UPDATE_VERSION_URL,
  UPDATE_PACKAGE_URL,
};
