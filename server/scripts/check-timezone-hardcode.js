'use strict';

/**
 * 扫描前端时间展示硬编码。
 * 用法：node server/scripts/check-timezone-hardcode.js [--warn]
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const targets = [
  path.join(root, 'public', 'js'),
  path.join(root, 'public', 'pages'),
];
const allowlist = new Set([
  path.join(root, 'public', 'js', 'time-format.js'),
]);
const patterns = [
  { name: "timeZone: 'Asia/Shanghai'", re: /timeZone:\s*['"]Asia\/Shanghai['"]/g },
  { name: 'toLocaleString', re: /\.toLocaleString\s*\(/g },
  { name: 'toLocaleDateString', re: /\.toLocaleDateString\s*\(/g },
  { name: 'toLocaleTimeString', re: /\.toLocaleTimeString\s*\(/g },
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(js|html)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = targets.flatMap(dir => walk(dir));
const findings = [];
for (const file of files) {
  if (allowlist.has(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes('// cr-time-exempt')) continue;
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      if (!pattern.re.test(line)) continue;
      if (pattern.name !== "timeZone: 'Asia/Shanghai'") {
        if (line.includes('CRTime')) continue;
        const numeric = /Number\(|parseFloat|parseInt|maximumFractionDigits|minimumFractionDigits|currency|percent|\.toFixed\(/.test(line);
        if (numeric) continue;
        const looksLikeTime = /new Date|Date\(|created_at|updated_at|expires_at|starts_at|ends_at|observedAt|last_seen|first_seen|checkedAt|getTime|dateStyle|timeStyle|month:|day:|hour:|minute:|\biso\b|\btime\b|\bdate\b/i.test(line);
        if (!looksLikeTime) continue;
      } else if (line.includes('Intl.DateTimeFormat') || line.includes('year:') || line.includes('month:')) {
        // 业务自然日分桶（图表轴）仍使用业务时区，允许保留但需在 UI 中标注。
        continue;
      }
      findings.push({ file: path.relative(root, file), line: index + 1, pattern: pattern.name, text: line.trim().slice(0, 160) });
    }
  });
}

const warnOnly = process.argv.includes('--warn');
console.log(`时间展示硬编码：${findings.length} 处，扫描 ${files.length} 个文件`);
for (const finding of findings.slice(0, 100)) {
  console.log(`${finding.file}:${finding.line} [${finding.pattern}] ${finding.text}`);
}
if (findings.length > 100) console.log(`... 其余 ${findings.length - 100} 处省略`);
if (findings.length && !warnOnly) process.exitCode = 1;
