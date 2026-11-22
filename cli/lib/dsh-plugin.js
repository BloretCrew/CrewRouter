'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const os = require('node:os');
const { cliHome, ensurePrivateDir, atomicWriteJson, readJson } = require('./config');

const PACKAGE_NAME = '@bloret-crew/dsh-crewrouter';
function bundledPluginDir() {
  for (const candidate of [path.resolve(__dirname, '../../dsh-plugin'), path.resolve(__dirname, '../dsh-plugin')]) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error('随附 DSH 插件文件不完整；请重新安装 CrewRouter CLI。');
}
const PACKAGE = () => `file:${bundledPluginDir()}`;
function dshHome() {
  const configured = String(process.env.DSH_HOME || '').trim();
  return path.resolve(configured || path.join(os.homedir(), '.dsh'));
}
function profileDir(profile) { return path.join(dshHome(), 'profiles', profile); }
const STATE_PATH = () => path.join(cliHome(), 'dsh-plugin.json');

function candidates() {
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .flatMap(dir => names.map(name => path.join(dir, name))).find(file => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });
}

function runDsh(executable, args, options = {}) {
  const windowsShim = process.platform === 'win32' && /\.cmd$/i.test(executable);
  const command = windowsShim ? process.env.ComSpec || 'cmd.exe' : executable;
  const commandArgs = windowsShim ? ['/d', '/s', '/c', `"${[executable, ...args].map(value => `"${String(value).replaceAll('"', '""')}"`).join(' ')}"`] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', shell: false, timeout: options.timeout || 180000, windowsHide: true });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

function state() {
  const value = readJson(STATE_PATH(), { version: 1, profiles: {} });
  if (!value || typeof value !== 'object' || value.version !== 1 || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) return { version: 1, profiles: {} };
  return value;
}

function saveInstallState(profile, installed) {
  const saved = state();
  if (installed) saved.profiles[profile] = { installed: true, package: PACKAGE_NAME, installedAt: new Date().toISOString() };
  else delete saved.profiles[profile];
  ensurePrivateDir();
  atomicWriteJson(STATE_PATH(), saved, 0o600);
}

function profilePackageManifest(profile) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile)) return null;
  const manifestPath = path.join(profileDir(profile), 'package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || manifest.name !== `dsh-profile-${profile}` || !manifest.dsh || typeof manifest.dsh !== 'object') return null;
    return manifest;
  } catch { return null; }
}

function isInstalled(profile, name = PACKAGE_NAME) {
  const manifest = profilePackageManifest(profile);
  try {
    if (!manifest) return false;
    return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }).some(([dependency, value]) => dependency === name || dependency.startsWith(`${name}@`) || (typeof value === 'string' && value.startsWith(`file:${bundledPluginDir()}`)));
  } catch { return false; }
}

async function confirm(profile, context = '会修改该 profile') {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const ui = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await ui.question(`将为 DSH profile「${profile}」安装 CrewRouter 插件（${context}），继续？[y/N] `)).trim().toLowerCase() === 'y';
  } finally { ui.close(); }
}

async function install(profile, { yes = false } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile)) throw new Error('DSH profile 名称格式无效。');
  const dsh = candidates();
  if (!dsh) throw new Error('未在 PATH 中找到 DSH CLI。请安装 DSH 后重试。');
  if (isInstalled(profile)) {
    console.log(`DSH profile「${profile}」已声明 CrewRouter 插件，不重复安装。`);
    const recorded = state().profiles[profile]?.installed === true;
    if (!recorded) saveInstallState(profile, true);
    return 0;
  }
  if (!yes && !(await confirm(profile))) throw new Error('已取消；没有修改 DSH profile。');
  if (!profilePackageManifest(profile)) {
    const defaultProfile = ['web', 'headless', 'acp', 'sdk', 'sdk-minimal'].includes(profile);
    if (!yes) {
      const accepted = await confirm(profile, defaultProfile ? 'profile 未初始化，DSH 将按内置模板创建' : '将创建新 profile');
      if (!accepted) throw new Error('已取消；没有初始化或修改 DSH profile。');
    }
    if (!defaultProfile) throw new Error(`profile「${profile}」尚未初始化；请先通过 DSH 的默认模板创建 profile，再重试插件安装。`);
  }
  const result = await runDsh(dsh, ['plugin', '--profile', profile, 'add', PACKAGE()]);
  if (result.code !== 0) throw Object.assign(new Error(`DSH 插件安装失败，退出码 ${result.code}。请查看上方 DSH 输出后重试。`), { exitCode: result.code });
  saveInstallState(profile, true);
  console.log(`已为 DSH profile「${profile}」安装 CrewRouter 插件。`);
  return 0;
}

async function command(args, { json = false } = {}) {
  const sub = args._[1] || 'status';
  const profiles = state().profiles || {};
  if (sub === 'status') {
    const result = { dsh: Boolean(candidates()), profiles };
    if (json) console.log(JSON.stringify({ ok: true, data: result }, null, 2));
    else console.log(`DSH: ${result.dsh ? '已检测到' : '未检测到'}\nCrewRouter 插件: ${Object.entries(profiles).filter(([, value]) => value.installed).map(([name]) => name).join(', ') || '未记录'}`);
    return 0;
  }
  if (sub === 'install') return install(String(args.profile || ''), { yes: args.yes === true });
  if (sub === 'uninstall') {
    const profile = String(args.profile || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile)) throw new Error('请用 --profile 指定合法的 DSH profile 名称。');
    if (!isInstalled(profile)) throw new Error(`在 DSH profile「${profile}」中没有找到 CrewRouter 插件。`);
    if (!args.yes && !(await confirm(profile))) throw new Error('已取消；没有修改 DSH profile。');
    const dsh = candidates();
    if (!dsh) throw new Error('未在 PATH 中找到 DSH CLI。');
    const result = await runDsh(dsh, ['plugin', '--profile', profile, 'remove', '@bloret-crew/dsh-crewrouter']);
    if (result.code !== 0) throw Object.assign(new Error(`DSH 插件卸载失败，退出码 ${result.code}。`), { exitCode: result.code });
    saveInstallState(profile, false);
    return 0;
  }
  throw Object.assign(new Error('用法：cr dsh-plugin [status|install|uninstall] --profile <名称> [--yes]'), { code: 'PARSE_ERROR' });
}

async function offerFirstRun() {
  if (!stdin.isTTY || !stdout.isTTY || process.env.CR_DSH_PLUGIN_SKIP === '1' || process.env.CR_CLI_HOME || process.env.CREWROUTER_CLI_SERVER_ROOT || process.env.CREWROUTER_DSH_PLUGIN_PROMPTED === '1') return;
  if (require('./config').loadConfig().dshPluginAutoPrompt === false) return;
  const dsh = candidates();
  if (!dsh) return;
  let discovered = false;
  const profileRoot = path.join(dshHome(), 'profiles');
  try { discovered = fs.readdirSync(profileRoot, { withFileTypes: true }).some(entry => entry.isDirectory() && isInstalled(entry.name)); } catch {}
  if (discovered) { if (!state().profiles.discovered?.installed) saveInstallState('discovered', true); return; }
  const saved = state();
  if (Object.values(saved.profiles || {}).some(item => item.installed)) return;
  const ui = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await ui.question('检测到 DSH。是否现在为指定 profile 安装 CrewRouter 插件？[y/N] ')).trim().toLowerCase();
    if (answer !== 'y') {
      const skip = (await ui.question('本次拒绝。是否记住选择、不再自动询问？[y/N] ')).trim().toLowerCase();
      if (skip === 'y') {
        const cfg = require('./config');
        const current = cfg.loadConfig();
        current.dshPluginAutoPrompt = false;
        cfg.saveConfig(current);
      }
      return;
    }
    const profile = (await ui.question('DSH profile 名称（例如 standard）：')).trim();
    ui.close();
    await install(profile, { yes: true });
  } finally { if (ui) ui.close(); }
}

module.exports = { command, offerFirstRun, install, candidates, runDsh, PACKAGE, bundledPluginDir, PACKAGE_NAME, isInstalled, dshHome, profilePackageManifest, state, saveInstallState };
