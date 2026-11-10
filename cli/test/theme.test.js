'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTheme, detect } = require('../tui/theme');

test('CR_THEME selects palette and scheme from Blora Design tokens', () => {
  const theme = createTheme({ CR_THEME: 'indigo-light', TERM: 'xterm-256color' });
  assert.equal(theme.palette, 'indigo');
  assert.equal(theme.scheme, 'light');
  assert.equal(theme.colors.bg, 'F4F5F8');
  assert.equal(theme.colors.rose, '405D87');
});

test('CR_PALETTE and CR_COLOR_SCHEME override independently', () => {
  const theme = createTheme({ CR_PALETTE: 'dusk', CR_COLOR_SCHEME: 'dark', TERM: 'xterm-256color' });
  assert.equal(theme.palette, 'dusk');
  assert.equal(theme.scheme, 'dark');
  assert.equal(theme.colors.bg, '151317');
});

test('NO_COLOR and plain scheme disable ANSI styling', () => {
  const plain = createTheme({ NO_COLOR: '1' });
  assert.equal(plain.plain, true);
  assert.equal(plain.paint('hello', 'rose', 'bg', true), 'hello');
  const auto = detect({ NO_COLOR: '1' });
  assert.equal(auto.scheme, 'plain');
});

test('truecolor paint carries the selected palette', () => {
  const theme = createTheme({ CR_THEME: 'coral-dark', COLORTERM: 'truecolor', TERM: 'xterm-256color' });
  const painted = theme.paint('x', 'rose', 'bg');
  assert.match(painted, /38;2;209;138;148/);
  assert.match(painted, /48;2;23;22;28/);
});
