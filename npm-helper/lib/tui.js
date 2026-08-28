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

function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  return { rl, ask };
}

async function chooseClient(ask) {
  console.log('\n选择要写入上报 Hook 的客户端：');
  HARNESS_CHOICES.forEach((item, i) => console.log(`  ${i + 1}. ${item[0]} (${path.join('~', item[2])})`));
  console.log('  4. 全部配置');
  const choice = (await ask('请输入编号：')).trim();
  if (choice === '4') return [0, 1, 2];
  const index = Number(choice) - 1;
  return Number.isInteger(index) && index >= 0 && index < 3 ? [index] : [];
}

async function configureClients(ask) {
  const selected = await chooseClient(ask);
  if (!selected.length) {
    console.log('未选择有效客户端。');
    return;
  }
  const confirmed = (await ask('将保留原有配置并写入 Hook，继续吗？[Y/n] ')).trim().toLowerCase();
  if (confirmed && confirmed !== 'y' && confirmed !== 'yes') return;
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
  const { rl, ask } = createPrompt();
  try {
    for (;;) {
      console.log('\n=== CrewRouter Helper ===');
      console.log('1. 查看状态');
      console.log('2. 登录 / 配置服务');
      console.log('3. 配置客户端 Hook');
      console.log('4. 发送测试事件');
      console.log('5. 退出');
      const choice = (await ask('请选择：')).trim();
      if (choice === '1') showStatus();
      else if (choice === '2') {
        const url = (await ask('服务地址（留空使用官方商店或 CREWROUTER_URL）：')).trim();
        await actions.login(url ? { url } : {});
      } else if (choice === '3') await configureClients(ask);
      else if (choice === '4') await actions.test();
      else if (choice === '5' || choice.toLowerCase() === 'q') break;
      else console.log('请输入 1-5。');
    }
  } finally {
    rl.close();
  }
  return 0;
}

module.exports = { runTui, configureClient, configureClients };
