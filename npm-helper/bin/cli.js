#!/usr/bin/env node
'use strict';

/**
 * crewrouter-helper —— 客户端事件统一上报器（Node.js 零依赖版）
 *
 * 子命令与 Python 版 cr-report.py / cr-login 一一对应：
 *   hook    --harness <id> [--event <type>]   读 stdin Claude 风格 hook JSON 转发
 *   emit    --harness <id> --event <t> [--session <id>] [--tool <n>] [--cwd <dir>]
 *   watch   [--harness grok] [--interval 5]   常驻 tail ~/.grok/sessions/**\/updates.jsonl
 *   login   [--url <base>]                    OAuth PKCE 浏览器授权
 *   logout                                    删除本地凭证
 *   test    [--harness hermes]                发测试事件验证链路
 *   --print                                   输出有效 access token（自动刷新）
 *
 * 铁律：hook 模式任何失败都静默退出 0，绝不阻塞客户端工具执行。
 */

const fs = require('fs');

const { CONFIG_PATH } = require('../lib/config');
const { getCredential, runLogin } = require('../lib/oauth');
const { postJson } = require('../lib/http');
const reporter = require('../lib/reporter');

const PROG = 'crewrouter-helper';
const EVENT_CHOICES = new Set(['session_start', 'session_end', 'tool_use']);

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 极简旗标解析：--flag value 或 --flag=value；valueFlags 声明需要取值的旗标 */
function parseFlags(argv, valueFlags) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (eq !== -1) out[name] = a.slice(eq + 1);
      else if (valueFlags.has(name)) out[name] = argv[++i];
      else out[name] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

// hook 模式铁律：任何错误静默 exit 0，绝不阻塞宿主客户端
async function cmdHook(argv) {
  try {
    const flags = parseFlags(argv, new Set(['--harness', '--event']));
    const harness = flags['--harness'];
    if (!harness) return 0;
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch (_) {}
    let detail = {};
    try { detail = raw.trim() ? JSON.parse(raw) : {}; } catch (_) {
      detail = { raw: raw.slice(0, 512) };
    }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return 0;
    const cred = await getCredential();
    if (cred) {
      await reporter.postEvent(
        cred,
        reporter.buildHookPayload(String(harness), flags['--event'] || null, detail)
      );
    }
  } catch (_) {}
  return 0;
}

async function cmdEmit(argv) {
  const flags = parseFlags(argv, new Set(['--harness', '--event', '--session', '--tool', '--cwd']));
  const harness = flags['--harness'];
  const event = flags['--event'];
  if (!harness || !event || !EVENT_CHOICES.has(event)) {
    console.error(
      `[${PROG}] 用法：${PROG} emit --harness <id> --event session_start|session_end|tool_use` +
        ` [--session <id>] [--tool <n>] [--cwd <dir>]`
    );
    return 2;
  }
  const cred = await getCredential();
  if (cred) {
    await reporter.postEvent(cred, {
      harness: String(harness),
      event,
      session_id: flags['--session'] || null,
      tool_name: flags['--tool'] || null,
      cwd: flags['--cwd'] || process.cwd(),
      ts: nowSec(),
    });
  }
  return 0;
}

async function cmdTest(argv) {
  const flags = parseFlags(argv, new Set(['--harness']));
  const cred = await getCredential();
  if (!cred) {
    console.error(`[${PROG}] 配置缺失：${CONFIG_PATH}`);
    return 1;
  }
  const payload = {
    harness: String(flags['--harness'] || 'hermes'),
    event: 'session_start',
    session_id: `${PROG}-test-${nowSec()}`,
    cwd: process.cwd(),
    ts: nowSec(),
    detail: { source: `${PROG} test` },
  };
  try {
    const res = await postJson(cred.url + '/api/client-events', payload, {
      token: cred.token,
      timeoutMs: 5000,
    });
    console.log(`[${PROG}] HTTP ${res.status} -> ${res.body}`);
    return res.status >= 200 && res.status < 300 ? 0 : 1;
  } catch (err) {
    console.error(`[${PROG}] 失败：${err.message}`);
    return 1;
  }
}

async function cmdLogout() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH);
      console.log(`[${PROG}] 已删除 ${CONFIG_PATH}`);
    } else {
      console.log(`[${PROG}] 未找到本地凭证（${CONFIG_PATH}）`);
    }
    return 0;
  } catch (err) {
    console.error(`[${PROG}] 删除配置失败：${err.message}`);
    return 1;
  }
}

async function cmdPrint() {
  let cred = null;
  try { cred = await getCredential(); } catch (_) {}
  if (!cred) {
    console.error(`[${PROG}] 无有效凭证，请先执行 ${PROG} login`);
    return 1;
  }
  process.stdout.write(cred.token + '\n'); // stdout 只输出 token 本身
  return 0;
}

const HELP = `${PROG} —— 客户端事件统一上报器（Node.js 零依赖）

用法：
  ${PROG} hook    --harness <id> [--event <type>]     读 stdin Claude 风格 hook JSON 转发
  ${PROG} emit    --harness <id> --event <t> [--session <id>] [--tool <n>] [--cwd <dir>]
  ${PROG} watch   [--harness grok] [--interval 5]     tail ~/.grok/sessions/**/updates.jsonl
  ${PROG} login   [--url http://127.0.0.1:20003]      浏览器 OAuth PKCE 授权
  ${PROG} logout                                      删除本地凭证
  ${PROG} test    [--harness hermes]                  发测试事件验证链路
  ${PROG} --print                                    输出有效 access token（自动刷新）

事件取值：session_start | session_end | tool_use
harness 取值（服务端校验 8 种）：claude_code / codex / grok / opencode /
qwen_code / hermes / openclaw / deepseek_harness

配置文件：~/.config/cr-report.json（CREWROUTER_CONFIG / CR_REPORT_CONFIG 可覆盖路径）
环境变量：CREWROUTER_URL 覆盖服务端地址；CREWROUTER_KEY 提供静态 Key 回落；
CREWROUTER_NO_BROWSER=1 只打印授权链接不拉起浏览器。`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      return 0;
    case '--print':
      return cmdPrint();
    case 'hook':
      return cmdHook(rest);
    case 'emit':
      return cmdEmit(rest);
    case 'watch': {
      const flags = parseFlags(rest, new Set(['--harness', '--interval']));
      return reporter.cmdWatch({ harness: flags['--harness'], interval: flags['--interval'] }, getCredential);
    }
    case 'test':
      return cmdTest(rest);
    case 'login': {
      const flags = parseFlags(rest, new Set(['--url']));
      return runLogin({ url: flags['--url'] || process.env.CREWROUTER_URL });
    }
    case 'logout':
      return cmdLogout();
    default:
      console.error(`[${PROG}] 未知命令：${cmd}\n\n` + HELP);
      return 2;
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch(() => process.exit(0)); // 兜底：绝不让上报器把宿主客户端搞挂
