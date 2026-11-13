'use strict';

/**
 * 将常见的前端时间展示硬编码迁移到 window.CRTime。
 * 用法：node server/scripts/migrate-time-format.js [--write] [files...]
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const defaultFiles = [
  'public/js/admin.js',
  'public/js/app.js',
  'public/js/usage.js',
  'public/js/playground.js',
  'public/js/provider-quota-stats.js',
  'public/js/quota-cycle-report.js',
  'public/js/multi-dimension-chart.js',
];

const replacements = [
  {
    name: 'datetime + Asia/Shanghai option',
    re: /new Date\(([^()]+)\)\.toLocaleString\(\s*['"]zh-CN['"]\s*,\s*\{[^{}]*timeZone:\s*['"]Asia\/Shanghai['"][^{}]*\}\s*\)/g,
    to: 'CRTime.formatTime($1)',
  },
  {
    name: 'date + Asia/Shanghai option',
    re: /new Date\(([^()]+)\)\.toLocaleDateString\(\s*['"]zh-CN['"]\s*,\s*\{[^{}]*timeZone:\s*['"]Asia\/Shanghai['"][^{}]*\}\s*\)/g,
    to: 'CRTime.formatDate($1)',
  },
  {
    name: 'time + Asia/Shanghai option',
    re: /new Date\(([^()]+)\)\.toLocaleTimeString\(\s*['"]zh-CN['"]\s*,\s*\{[^{}]*timeZone:\s*['"]Asia\/Shanghai['"][^{}]*\}\s*\)/g,
    to: 'CRTime.formatTime($1, { mode: \'time\' })',
  },
  {
    name: 'datetime default locale',
    re: /new Date\(([^()]+)\)\.toLocaleString\(\s*['"]zh-CN['"]\s*\)/g,
    to: 'CRTime.formatTime($1)',
  },
  {
    name: 'date default locale',
    re: /new Date\(([^()]+)\)\.toLocaleDateString\(\s*['"]zh-CN['"]\s*\)/g,
    to: 'CRTime.formatDate($1)',
  },
  {
    name: 'time default locale',
    re: /new Date\(([^()]+)\)\.toLocaleTimeString\(\s*['"]zh-CN['"]\s*\)/g,
    to: 'CRTime.formatTime($1, { mode: \'time\' })',
  },
  {
    name: 'locale ternary with Shanghai',
    re: /new Date\(([^()]+)\)\.toLocaleString\([^()]*timeZone:\s*['"]Asia\/Shanghai['"][^()]*\)/g,
    to: 'CRTime.formatTime($1)',
  },
  {
    name: 'datetime no options',
    re: /new Date\(([^()]+)\)\.toLocaleString\(\s*\)/g,
    to: 'CRTime.formatTime($1)',
  },
  {
    name: 'date no options',
    re: /new Date\(([^()]+)\)\.toLocaleDateString\(\s*\)/g,
    to: 'CRTime.formatDate($1)',
  },
  {
    name: 'time no options',
    re: /new Date\(([^()]+)\)\.toLocaleTimeString\(\s*\)/g,
    to: 'CRTime.formatTime($1, { mode: \'time\' })',
  },
  {
    name: 'date with non-timezone options',
    re: /new Date\(([^()]+)\)\.toLocaleDateString\([^()]*\)/g,
    to: 'CRTime.formatDate($1)',
  },
  {
    name: 'datetime with non-timezone options',
    re: /new Date\(([^()]+)\)\.toLocaleString\([^()]*\)/g,
    to: 'CRTime.formatTime($1)',
  },
];

const args = process.argv.slice(2);
const write = args.includes('--write');
const files = args.filter(arg => !arg.startsWith('--'));
const targets = files.length ? files : defaultFiles;

let total = 0;
for (const relative of targets) {
  const full = path.resolve(root, relative);
  if (!fs.existsSync(full)) {
    console.warn(`skip missing: ${relative}`);
    continue;
  }
  let source = fs.readFileSync(full, 'utf8');
  let count = 0;
  for (const replacement of replacements) {
    source = source.replace(replacement.re, (...match) => {
      count += 1;
      return replacement.to.replace('$1', match[1]);
    });
  }
  if (count) {
    total += count;
    console.log(`${relative}: ${count} replacements${write ? ' (written)' : ' (dry-run)'}`);
    if (write) fs.writeFileSync(full, source);
  } else {
    console.log(`${relative}: no changes`);
  }
}
console.log(`total: ${total}`);
