'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_STDIO_BYTES = 256 * 1024;
const TASK_TIMEOUT_MS = 30000;
const MAX_TASK_ENTRY_BYTES = 256 * 1024;
const FORBIDDEN_ISOLATED_PERMISSIONS = new Set([
  'storage', 'network', 'gateway:modify', 'billing:modify', 'apikey:modify', 'provider:register',
  'routes:register', 'cron:register', 'events:subscribe', 'usage:read', 'export:usage',
  'models:read', 'preferences:read', 'audit:write', 'meta:read', 'admin:view', 'webhook:register',
]);

function selectBwrap(env = process.env) {
  const configured = String(env.CR_PLUGIN_BWRAP_PATH || '').trim();
  const candidates = configured ? [configured] : ['/usr/bin/bwrap', '/bin/bwrap'];
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function sandboxHostIdentity() {
  return { uid: process.getuid() === 0 ? 65534 : process.getuid(), gid: process.getgid() === 0 ? 65534 : process.getgid() };
}

function resolveSandboxNodePath(env = process.env) {
  const candidate = String(env.CR_PLUGIN_NODE_PATH || process.execPath);
  try {
    if (!path.isAbsolute(candidate) || !fs.statSync(candidate).isFile()) throw new Error('invalid path');
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.realpathSync(candidate);
  } catch {
    throw new Error('CR_PLUGIN_NODE_PATH 必须指向可执行的绝对 Node 路径');
  }
}

function setprivPath() {
  return ['/usr/bin/setpriv', '/bin/setpriv'].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function spawnAsSandboxHost(command, args, options = {}) {
  const identity = sandboxHostIdentity();
  if (process.getuid() !== 0) return spawn(command, args, { ...options, uid: identity.uid, gid: identity.gid });
  const setpriv = setprivPath();
  if (!setpriv) throw new Error('root host requires setpriv to drop to the isolated worker host UID');
  return spawn(setpriv, ['--reuid', String(identity.uid), '--regid', String(identity.gid), '--clear-groups', '--', command, ...args], options);
}

function spawnSyncAsSandboxHost(command, args, options = {}) {
  const identity = sandboxHostIdentity();
  if (process.getuid() !== 0) return spawnSync(command, args, { ...options, uid: identity.uid, gid: identity.gid });
  const setpriv = setprivPath();
  if (!setpriv) throw new Error('root host requires setpriv to drop to the isolated worker host UID');
  return spawnSync(setpriv, ['--reuid', String(identity.uid), '--regid', String(identity.gid), '--clear-groups', '--', command, ...args], options);
}

function assertRuntimeAvailable(env = process.env) {
  if (process.platform !== 'linux') throw new Error('isolated-task 当前仅支持 Linux + bubblewrap');
  if (env.CR_ENABLE_PLUGIN_BWRAP !== '1') throw new Error('isolated-task 未启用；需管理员显式设置 CR_ENABLE_PLUGIN_BWRAP=1');
  const bwrap = selectBwrap(env);
  if (!bwrap) throw new Error('isolated-task 模式需要 bubblewrap；未找到可执行文件，拒绝回退到主进程');
  return bwrap;
}

function probeRuntime({ env = process.env, timeoutMs = 3000 } = {}) {
  const bwrap = assertRuntimeAvailable(env);
  const nodePath = resolveSandboxNodePath(env);
  const shellPath = '/bin/sh';
  const hostIdentity = sandboxHostIdentity();
  const runtimeFiles = getRuntimeFiles([nodePath, shellPath]);
  const directories = new Set(['/tmp', '/proc', '/dev']);
  for (const file of runtimeFiles) { let parent = path.dirname(file); while (parent !== '/') { directories.add(parent); parent = path.dirname(parent); } }
  const args = [
    '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
    '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--clearenv', '--setenv', 'HOME', '/tmp',
    '--uid', '65534', '--gid', '65534', '--cap-drop', 'ALL',
    '--disable-userns', '--assert-userns-disabled', '--die-with-parent',
  ];
  for (const dir of [...directories].filter(dir => !['/tmp', '/proc', '/dev'].includes(dir)).sort((a, b) => a.length - b.length)) args.push('--dir', dir);
  for (const file of runtimeFiles) args.push('--ro-bind', file, file);
  const wrapper = 'ulimit -v 4194304; ulimit -t 25; ulimit -n 64; ulimit -f 1024; ulimit -c 0; exec "$@"';
  const probeSource = 'const fs=require("node:fs"); const l=fs.readFileSync("/proc/self/limits","utf8"); const row=n=>l.split("\\n").find(x=>x.startsWith(n)); const num=x=>Number(x.trim().split(/\\s+/)[3]); if(process.getuid()!==65534||process.getgid()!==65534||num(row("Max address space"))!==4294967296||num(row("Max cpu time"))!==25||num(row("Max open files"))!==64) { process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),mem:num(row("Max address space")),cpu:num(row("Max cpu time")),fds:num(row("Max open files"))})); process.exit(4); } process.stdout.write(String(process.getuid())+" "+typeof fetch)';
  args.push('--', shellPath, '-c', wrapper, 'cr-plugin-probe', nodePath, '-e', probeSource);
  const result = spawnSyncAsSandboxHost(bwrap, args, { encoding: 'utf8', env: {}, timeout: timeoutMs });
  if (result.error || result.status !== 0 || String(result.stdout).trim() !== '65534 function') {
    throw new Error(`bubblewrap namespaces/uid probe failed: ${String(result.stderr || result.stdout || result.error || result.status).slice(0, 500)}`);
  }
  return { bwrap, uid: 65534, networkNamespace: true, pidNamespace: true, capabilitiesDropped: true };
}

function assertModeSupported(manifest, env = process.env) {
  const permissions = new Set(manifest.permissions || []);
  const incompatible = [...permissions].filter(permission => FORBIDDEN_ISOLATED_PERMISSIONS.has(permission));
  if (incompatible.length) throw new Error(`隔离任务模式不支持这些宿主进程能力: ${incompatible.join(', ')}`);
  probeRuntime({ env });
  if (manifest.executionMode !== 'isolated-task') throw new Error('插件未声明 isolated-task 执行模式');
  if (!permissions.has('tasks:register')) throw new Error('隔离任务模式需要 tasks:register 权限');
  if (!Array.isArray(manifest.taskHandlers) || !manifest.taskHandlers.length || manifest.taskHandlers.some(name => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(String(name)))) {
    throw new Error('isolated-task 需要有效的 taskHandlers 名称数组');
  }
  if (manifest.hooks || (manifest.routes || []).length || (manifest.cron || []).length || (manifest.pages || []).length || (manifest.slots || []).length) {
    throw new Error('isolated-task 目前仅支持纯后台任务，不支持 hooks/routes/cron/pages/slots');
  }
}

function getRuntimeFiles(executables) {
  const files = new Set(executables.map(value => path.resolve(value)));
  for (const executable of executables) {
    try {
      const output = execFileSync('ldd', [executable], { encoding: 'utf8', timeout: 2000, env: { PATH: '/usr/bin:/bin' } });
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/(?:=>\s*)?(\/[^\s()]+)/);
        if (match && fs.existsSync(match[1]) && fs.statSync(match[1]).isFile()) files.add(path.resolve(match[1]));
      }
    } catch (error) {
      throw new Error(`无法确定隔离 runtime 动态库 (${executable}): ${error.message}`);
    }
  }
  return [...files];
}

function buildBwrapArgs({ bwrap, nodePath, workerPath, pluginEntry, frameFile, scratchDir, env = process.env }) {
  const shellPath = '/bin/sh';
  if (!fs.existsSync(shellPath)) throw new Error('isolated-task 资源限制要求 /bin/sh');
  const runtimeFiles = getRuntimeFiles([nodePath, shellPath]);
  const directories = new Set(['/tmp', '/home', '/proc', '/dev']);
  for (const file of runtimeFiles) {
    let parent = path.dirname(file);
    while (parent !== '/') { directories.add(parent); parent = path.dirname(parent); }
  }
  const args = [
    '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
    '--dir', '/tmp', '--bind', scratchDir, '/tmp', '--dir', '/home', '--dir', '/home/plugin',
    '--proc', '/proc', '--dev', '/dev', '--clearenv',
    '--setenv', 'PATH', '/tmp', '--setenv', 'HOME', '/tmp', '--setenv', 'NODE_NO_WARNINGS', '1',
    '--setenv', 'CR_PLUGIN_SANDBOXED', '1',
    '--uid', '65534', '--gid', '65534', '--cap-drop', 'ALL',
    '--disable-userns', '--assert-userns-disabled', '--die-with-parent',
  ];
  for (const dir of [...directories].filter(dir => dir !== '/tmp' && dir !== '/home' && dir !== '/proc' && dir !== '/dev').sort((a, b) => a.length - b.length)) args.push('--dir', dir);
  for (const file of runtimeFiles) args.push('--ro-bind', file, file);
  args.push('--ro-bind', pluginEntry, '/tmp/plugin-entry.js');
  args.push('--ro-bind', frameFile, '/tmp/request.json');
  args.push('--ro-bind', workerPath, '/tmp/worker.js');
  const resourceWrapper = 'ulimit -v 4194304; ulimit -t 25; ulimit -n 64; ulimit -f 1024; ulimit -c 0; exec "$@"';
  args.push('--chdir', '/tmp', '--', shellPath, '-c', resourceWrapper, 'cr-plugin-sandbox', nodePath, '/tmp/worker.js');
  return { command: bwrap, args };
}

function parseWorkerOutput(output) {
  if (output.length > MAX_STDIO_BYTES) throw new Error('隔离 worker 输出超过上限');
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error('隔离 worker 必须返回一个 JSON frame');
  const result = JSON.parse(lines[0]);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('隔离 worker 响应必须为对象');
  return result;
}

function runTaskInBwrap({ pluginId, pluginDir, taskName, payload, taskId, attempt, env = process.env, timeoutMs = TASK_TIMEOUT_MS, signal }) {
  const bwrap = selectBwrap(env);
  if (!bwrap) return Promise.reject(new Error('未找到 bubblewrap；拒绝回退到主进程执行隔离任务'));
  const nodePath = resolveSandboxNodePath(env);
  const canonicalPluginDir = fs.realpathSync(pluginDir);
  const pluginEntry = path.join(canonicalPluginDir, 'task-entry.js');
  if (!fs.existsSync(pluginEntry) || !fs.lstatSync(pluginEntry).isFile() || fs.lstatSync(pluginEntry).isSymbolicLink()) return Promise.reject(new Error('隔离插件缺少普通文件 task-entry.js'));
  if (fs.statSync(pluginEntry).size > MAX_TASK_ENTRY_BYTES) return Promise.reject(new Error('隔离 task-entry.js 超过 256 KiB'));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-plugin-sandbox-'));
  const hostIdentity = sandboxHostIdentity();
  if (process.getuid() === 0) fs.chownSync(scratchDir, hostIdentity.uid, hostIdentity.gid);
  const frameFile = path.join(scratchDir, 'request.json');
  const workerPath = path.join(__dirname, 'task-worker.js');
  const request = JSON.stringify({ protocol: 1, pluginId, taskName, taskId, attempt, payload });
  if (Buffer.byteLength(request, 'utf8') > MAX_FRAME_BYTES) {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    return Promise.reject(new Error('隔离任务 RPC 请求超过 64 KiB'));
  }
  fs.writeFileSync(frameFile, request, { mode: 0o440 });
  if (process.getuid() === 0) fs.chownSync(frameFile, hostIdentity.uid, hostIdentity.gid);
  const { command, args } = buildBwrapArgs({ bwrap, nodePath, workerPath, pluginEntry, frameFile, scratchDir, env });
  return new Promise((resolve, reject) => {
    const child = spawnAsSandboxHost(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: {}, shell: false, detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
      fail(new Error(`隔离任务 ${taskId} 超时，worker 已终止`));
    }, timeoutMs);
    const onAbort = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
      fail(signal.reason || new Error('隔离任务已取消'));
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {}
      reject(error);
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > MAX_STDIO_BYTES) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
        fail(new Error('隔离 worker 输出超过上限'));
      }
    });
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096); });
    child.once('error', fail);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`隔离 worker 失败 (${signal || code}): ${stderr.slice(0, 500)} ${stdout.slice(0, 500)}`);
        const frame = parseWorkerOutput(stdout);
        if (frame.protocol !== 1 || frame.taskId !== taskId) throw new Error('隔离 worker RPC 响应关联不匹配');
        try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {}
        if (frame.error) reject(new Error(String(frame.error).slice(0, 2000)));
        else resolve(frame.result == null ? null : frame.result);
      } catch (error) {
        try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {}
        reject(error);
      }
    });
  });
}

function createSandboxToken() { return randomUUID(); }

module.exports = { MAX_FRAME_BYTES, MAX_STDIO_BYTES, MAX_TASK_ENTRY_BYTES, TASK_TIMEOUT_MS, FORBIDDEN_ISOLATED_PERMISSIONS, selectBwrap, resolveSandboxNodePath, assertRuntimeAvailable, probeRuntime, assertModeSupported, buildBwrapArgs, parseWorkerOutput, runTaskInBwrap, createSandboxToken };
