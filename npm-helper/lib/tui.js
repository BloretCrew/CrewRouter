'use strict';

// Copyright (C) 2026 Bloret
// SPDX-License-Identifier: GPL-3.0-only

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { CONFIG_PATH, loadCfg, saveCfg, effectiveUrl } = require('./config');

const HARNESS_CHOICES = [
  ['Claude Code', 'claude_code', '.claude/settings.json'],
  ['Qwen Code', 'qwen_code', '.qwen/settings.json'],
  ['Codex', 'codex', '.codex/config.toml'],
];

function commandFor(harness) {
  return `crewrouter-helper hook --harness ${harness}`;
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function addHook(settings, command) {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  for (const event of ['SessionStart', 'SessionEnd', 'PostToolUse']) {
    const entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const already = entries.some((entry) =>
      Array.isArray(entry && entry.hooks) && entry.hooks.some((hook) => hook && hook.command === command)
    );
    if (!already) entries.push({ hooks: [{ type: 'command', command }] });
    settings.hooks[event] = entries;
  }
  return settings;
}

function configureJsonClient(harness, relativePath) {
  const file = path.join(os.homedir(), relativePath);
  const settings = addHook(readJson(file), commandFor(harness));
  writeJson(file, settings);
  return file;
}

function configureCodex() {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) {}
  if (!/^codex_hooks\s*=\s*true\s*$/m.test(text)) text = `codex_hooks = true\n${text}`;
  const command = commandFor('codex');
  const section = /(^\[hooks\.PostToolUse\][\s\S]*?)(?=^\[|$(?![\s\S]))/m;
  if (section.test(text)) {
    text = text.replace(section, (block) => {
      if (/^command\s*=\s*/m.test(block)) return block.replace(/^command\s*=\s*.*$/m, `command = ${JSON.stringify(command)}`);
      return `${block.trimEnd()}\ncommand = ${JSON.stringify(command)}\n`;
    });
  } else {
    text = `${text.trimEnd()}\n\n[hooks.PostToolUse]\ncommand = ${JSON.stringify(command)}\n`;
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

function configureClient(index) {
  if (index === 0 || index === 1) return configureJsonClient(HARNESS_CHOICES[index][1], HARNESS_CHOICES[index][2]);
  if (index === 2) return configureCodex();
  throw new Error('未知客户端');
}

function askText(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function selectMenu(title, items, { selected = 0, multi = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let cursor = Math.max(0, Math.min(selected, items.length - 1));
    const chosen = new Set();
    let escapeBuffer = '';
    const previousRaw = process.stdin.isRaw;
    const draw = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(`=== ${title} ===\n`);
      items.forEach((item, index) => {
        const mark = multi ? (chosen.has(index) ? '[✓]' : '[ ]') : ' ';
        const pointer = index === cursor ? '❯' : ' ';
        console.log(`${pointer} ${mark} ${item}`);
      });
      console.log(`\n↑/↓ 选择${multi ? '，空格勾选' : ''}，Enter 确认，q 取消`);
    };
    const finish = (value) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(Boolean(previousRaw));
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');
      resolve(value);
    };
    const onData = (buffer) => {
      for (const byte of buffer) {
        const key = String.fromCharCode(byte);
        if (escapeBuffer || byte === 0x1b) {
          escapeBuffer += key;
          if (escapeBuffer === '\x1b[A') {
            cursor = (cursor + items.length - 1) % items.length;
            escapeBuffer = '';
          } else if (escapeBuffer === '\x1b[B') {
            cursor = (cursor + 1) % items.length;
            escapeBuffer = '';
          } else if (escapeBuffer.length > 3) escapeBuffer = '';
          continue;
        }
        if (byte === 3 || key.toLowerCase() === 'q') return finish(null);
        if (multi && key === ' ') {
          if (chosen.has(cursor)) chosen.delete(cursor); else chosen.add(cursor);
        } else if (byte === 13 || byte === 10) {
          return finish(multi ? [...chosen].sort((a, b) => a - b) : cursor);
        } else if (key === 'k') cursor = (cursor + items.length - 1) % items.length;
        else if (key === 'j') cursor = (cursor + 1) % items.length;
      }
      draw();
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.stdout.write('\x1b[?25l');
    draw();
  });
}

async function chooseClient() {
  const items = HARNESS_CHOICES.map((item) => `${item[0]} (${path.join('~', item[2])})`).concat('全部配置');
  const choice = await selectMenu('选择要写入上报 Hook 的客户端', items);
  if (choice === null) return [];
  return choice === HARNESS_CHOICES.length ? HARNESS_CHOICES.map((_, index) => index) : [choice];
}

async function configureClients() {
  const selected = await chooseClient();
  if (!selected.length) return;
  const confirmed = await selectMenu('确认写入客户端配置', ['继续（保留已有配置）', '取消']);
  if (confirmed !== 0) return;
  for (const index of selected) {
    try { console.log(`已配置 ${HARNESS_CHOICES[index][0]}：${configureClient(index)}`); }
    catch (err) { console.log(`配置 ${HARNESS_CHOICES[index][0]} 失败：${err.message}`); }
  }
  console.log('配置完成。');
}

function showStatus() {
  const cfg = loadCfg();
  console.log('\nCrewRouter Helper 状态');
  console.log(`  配置文件：${CONFIG_PATH}`);
  console.log(`  服务地址：${effectiveUrl(cfg) || '未配置'}`);
  console.log(`  凭证状态：${cfg && (cfg.access_token || cfg.key) ? '已配置' : '未配置'}`);
}

async function runTui(actions) {
  const menu = ['查看状态', '登录 / 配置服务', '配置客户端 Hook', '发送测试事件', '退出'];
  for (;;) {
    const choice = await selectMenu('CrewRouter Helper', menu);
    if (choice === null || choice === 4) break;
    if (choice === 0) showStatus();
    else if (choice === 1) {
      const url = await askText('服务地址（留空使用官方商店或 CREWROUTER_URL）：');
      await actions.login(url ? { url } : {});
    } else if (choice === 2) await configureClients();
    else if (choice === 3) await actions.test();
    await askText('按 Enter 返回主菜单...');
  }
  return 0;
}

module.exports = { runTui, configureClient, configureClients, selectMenu };
