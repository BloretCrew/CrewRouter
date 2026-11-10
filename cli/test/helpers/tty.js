'use strict';

const { PassThrough, Writable } = require('node:stream');
const { width } = require('../../lib/format');

function terminal(columns = 100, rows = 24) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; return input; };
  let screen = '';
  const output = new Writable({
    write(chunk, encoding, done) { screen += chunk.toString(); done(); },
  });
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  return {
    input,
    output,
    screen: () => screen.slice(screen.lastIndexOf('\x1b[?25l\x1b[H')),
    raw: () => screen,
    clear: () => { screen = ''; },
  };
}

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, { tries = 400, delay = 10 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await tick(delay);
  }
  throw new Error('terminal state not reached');
}

function plain(screen) {
  return screen
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function findText(tty, needle, occurrence = 0) {
  const lines = plain(tty.screen()).split(/\r?\n/);
  let seen = 0;
  for (let row = 0; row < lines.length; row++) {
    let column = 0;
    let index = lines[row].indexOf(needle);
    while (index >= 0) {
      if (seen === occurrence) return { x: width(lines[row].slice(0, index)) + 1, y: row + 1 };
      seen++;
      column = index + 1;
      index = lines[row].indexOf(needle, column);
    }
  }
  return null;
}

function findAnsiText(tty, needle, occurrence = 0) {
  const raw = tty.screen();
  const parts = raw.split(/\x1b\[(\d+);(\d+)H/);
  let seen = 0;
  for (let i = 1; i < parts.length; i += 3) {
    const row = Number(parts[i]);
    const column = Number(parts[i + 1]);
    const content = plain(parts[i + 2] || '');
    let index = content.indexOf(needle);
    while (index >= 0) {
      if (seen === occurrence) return { x: column + width(content.slice(0, index)), y: row };
      seen++;
      index = content.indexOf(needle, index + 1);
    }
  }
  return null;
}

async function clickAnsiText(tty, needle, occurrence = 0) {
  let at = findAnsiText(tty, needle, occurrence);
  if (!at) { await until(() => Boolean(findAnsiText(tty, needle, occurrence)), { tries: 200 }); at = findAnsiText(tty, needle, occurrence); }
  if (!at) throw new Error(`screen text not found: ${needle}`);
  tty.input.write(`\x1b[<0;${at.x};${at.y}M`);
  return at;
}

async function clickText(tty, needle, occurrence = 0) {
  let at = findText(tty, needle, occurrence);
  if (!at) { await until(() => Boolean(findText(tty, needle, occurrence)), { tries: 200 }); at = findText(tty, needle, occurrence); }
  if (!at) throw new Error(`text not found: ${needle}`);
  tty.input.write(`\x1b[<0;${at.x};${at.y}M`);
  return at;
}

module.exports = { terminal, tick, until, plain, findText, findAnsiText, clickText, clickAnsiText };
