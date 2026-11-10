'use strict';

const readline = require('node:readline');

function ask(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(question, answer => { rl.close(); resolve(answer); });
  });
}

function readAll(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

function askSecret(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('当前不是交互式终端，请使用 --password-stdin 或 --api-key-stdin'));
  }
  return new Promise((resolve) => {
    output.write(question);
    const wasRaw = Boolean(input.isRaw);
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      try { input.setRawMode(wasRaw); } catch (_) {}
      if (!input.readableFlowing) input.pause();
      output.write('\n');
    };
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') { cleanup(); resolve(value); return; }
        if (ch === '\u0003') { cleanup(); process.exitCode = 130; resolve(''); return; }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        if (ch >= ' ' && ch !== '\u007f') value += ch;
      }
    };
    try { input.setRawMode(true); } catch (_) {}
    input.resume();
    input.on('data', onData);
  });
}

function confirm(question, { defaultValue = false, input = process.stdin, output = process.stdout } = {}) {
  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
  return ask(`${question}${suffix}`, { input, output }).then(answer => {
    const value = answer.trim().toLowerCase();
    if (!value) return defaultValue;
    return value === 'y' || value === 'yes' || value === '是';
  });
}

module.exports = { ask, askSecret, readAll, confirm };
