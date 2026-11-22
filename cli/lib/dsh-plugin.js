'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { cliHome, ensurePrivateDir, atomicWriteJson, readJson } = require('./config');

const PACKAGE_NAME = '@bloret-crew/dsh-crewrouter';
function bundledPluginDir() {
  for (const candidate of [path.resolve(__dirname, '../../dsh-plugin'), path.resolve(__dirname, '../dsh-plugin')]) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error('随附 DSH 插件文件不完整；请重新安装 CrewRouter CLI。');
}
const PACKAGE = () => `file:${bundledPluginDir()}`;
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

function state() { return readJson(STATE_PATH(), { version: 1, profiles: {} }); }

function saveInstallState(profile, installed) {
  const saved = state();
  if (installed) saved.profiles[profile] = { installed: true, package: PACKAGE_NAME, installedAt: new Date().toISOString() };
  else delete saved.profiles[profile];
  ensurePrivateDir();
  atomicWriteJson(STATE_PATH(), saved, 0o600);
}

function isInstalled(profile, name = PACKAGE_NAME) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile)) return false;
  const manifestPath = path.join(process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh'), 'profiles', profile, 'package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }).some(([dependency, value]) => dependency === name || dependency.startsWith(`${name}@`) || (typeof value === 'string' && value.startsWith(`file:${bundledPluginDir()}`)));
  } catch { return false; }
}

async function confirm(profile) {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const ui = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await ui.question(`将为 DSH profile「${profile}」安装 CrewRouter 插件（会修改该 profile），继续？[y/N] `)).trim().toLowerCase() === 'y';
  } finally { ui.close(); }
}

async function install(profile, { yes = false } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile)) throw new Error('DSH profile 名称格式无效。');
  const dsh = candidates();
  if (!dsh) throw new Error('未在 PATH 中找到 DSH CLI。请安装 DSH 后重试。');
  if (isInstalled(profile)) {
    console.log(`DSH profile「${profile}」已声明 CrewRouter 插件，不重复安装。`);
    return 0;
  }
  if (!yes && !(await confirm(profile))) throw new Error('已取消；没有修改 DSH profile。');
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
  if (!stdin.isTTY || !stdout.isTTY || process.env.CR_DSH_PLUGIN_SKIP === '1' || process.env.CR_CLI_HOME || process.env.CREWROUTER_CLI_SERVER_ROOT) return;
  const dsh = candidates();
  if (!dsh) return;
  const saved = state();
  if (Object.values(saved.profiles || {}).some(item => item.installed)) return;
  const profileRoot = path.join(process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh'), 'profiles');
  try { if (fs.readdirSync(profileRoot, { withFileTypes: true }).some(entry => entry.isDirectory() && isInstalled(entry.name))) return; } catch {}
  const ui = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await ui.question('检测到 DSH。是否现在为指定 profile 安装 CrewRouter 插件？[y/N] ')).trim().toLowerCase();
    if (answer !== 'y') return;
    const profile = (await ui.question('DSH profile 名称（例如 standard）：')).trim();
    ui.close();
    await install(profile, { yes: true });
  } finally { if (ui) ui.close(); }
}

module.exports = { command, offerFirstRun, install, candidates, runDsh, PACKAGE, bundledPluginDir, PACKAGE_NAME, isInstalled };
