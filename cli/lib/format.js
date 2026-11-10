'use strict';

const path = require('node:path');

function codePointWidth(ch) {
  const cp = ch.codePointAt(0);
  if (/\p{Mark}/u.test(ch) || cp === 0x200d || cp === 0xfe0f) return 0;
  return cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) ? 2 : 1;
}

function width(value) {
  let result = 0;
  for (const ch of String(value ?? '')) result += codePointWidth(ch);
  return result;
}

function cut(value, max) {
  let result = '';
  let used = 0;
  for (const ch of String(value ?? '')) {
    const w = codePointWidth(ch);
    if (used + w > max) break;
    result += ch;
    used += w;
  }
  return result;
}

function pad(value, max) {
  const text = cut(value, Math.max(0, max));
  return text + ' '.repeat(Math.max(0, max - width(text)));
}

function wrap(value, max) {
  max = Math.max(1, max);
  const lines = [];
  let line = '';
  let used = 0;
  for (const ch of String(value ?? '')) {
    if (ch === '\n') { lines.push(line); line = ''; used = 0; continue; }
    const w = codePointWidth(ch);
    if (used + w > max && line) { lines.push(line); line = ''; used = 0; }
    if (w <= max) { line += ch; used += w; }
  }
  lines.push(line);
  return lines;
}

function clean(value) {
  return String(value ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[^\n]?/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g, '');
}

function colorEnabled(env = process.env) {
  return !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb';
}

function color(text, code, env = process.env) {
  if (!colorEnabled(env) || !code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function bold(text, env = process.env) { return color(text, '1', env); }
function dim(text, env = process.env) { return color(text, '2', env); }
function green(text, env = process.env) { return color(text, '32', env); }
function yellow(text, env = process.env) { return color(text, '33', env); }
function red(text, env = process.env) { return color(text, '31', env); }
function cyan(text, env = process.env) { return color(text, '36', env); }

function formatBigNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`;
  return String(Math.round(number));
}

function formatCost(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return number.toFixed(4);
}

function formatTime(value) {
  if (!value) return '未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '未知';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function maskSecret(value, visible = 4) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= visible) return '••••';
  return `${text.slice(0, Math.min(visible, text.length))}••••${text.slice(-2)}`;
}

function relativePath(file) {
  const home = require('node:os').homedir();
  const absolute = path.resolve(file);
  return absolute.startsWith(home) ? `~${absolute.slice(home.length)}` : absolute;
}

function table(rows, columns, { env = process.env, maxWidth = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const cols = columns.map(column => ({
    label: column.label,
    key: column.key,
    align: column.align || 'left',
    width: column.width || 0,
  }));
  for (const row of rows) {
    for (const column of cols) {
      const value = typeof column.key === 'function' ? column.key(row) : row[column.key];
      const raw = value === null || value === undefined ? '' : String(value);
      column.width = Math.min(Math.max(column.width, width(raw)), column.max || 48);
    }
  }
  if (maxWidth) {
    const gaps = Math.max(0, cols.length - 1) * 2;
    const total = cols.reduce((sum, column) => sum + column.width, 0) + gaps;
    if (total > maxWidth) {
      let excess = total - maxWidth;
      for (const column of cols.slice().sort((a, b) => b.width - a.width)) {
        const reduce = Math.min(excess, Math.max(6, column.width - 6));
        column.width -= reduce;
        excess -= reduce;
        if (excess <= 0) break;
      }
    }
  }
  const line = (values) => values.map((value, index) => {
    const column = cols[index];
    const text = cut(String(value ?? ''), column.width);
    if (column.align === 'right') return ' '.repeat(Math.max(0, column.width - width(text))) + text;
    return pad(text, column.width);
  }).join('  ');
  const header = line(cols.map(column => column.label), null);
  const body = rows.map(row => line(cols.map(column => {
    const value = typeof column.key === 'function' ? column.key(row) : row[column.key];
    return value === null || value === undefined ? '' : String(value);
  }), null));
  return [bold(header, env), ...body].join('\n');
}

function section(title, lines = [], { env = process.env } = {}) {
  const output = [bold(title, env)];
  for (const line of lines) output.push(`  ${line}`);
  return output.join('\n');
}

function statusIcon(ok) {
  return ok === true ? '✓' : ok === false ? '✕' : '•';
}

module.exports = {
  width, cut, pad, wrap, clean,
  colorEnabled, color, bold, dim, green, yellow, red, cyan,
  formatBigNumber, formatCost, formatTime, formatDuration, maskSecret, relativePath,
  table, section, statusIcon,
};
