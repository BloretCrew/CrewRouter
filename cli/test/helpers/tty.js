'use strict';

const { PassThrough, Writable } = require('node:stream');

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

module.exports = { terminal, tick, until };
