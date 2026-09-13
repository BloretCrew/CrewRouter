'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const files = [
  ...fs.readdirSync(path.join(root, 'public/pages')).filter(n => n.endsWith('.html')).map(n => path.join(root, 'public/pages', n)),
  ...fs.readdirSync(path.join(root, 'public/js')).filter(n => n.endsWith('.js')).map(n => path.join(root, 'public/js', n))
];
const violations = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const svg = source.match(/<svg\b[\s\S]*?<\/svg>/gi) || [];
  for (const icon of svg) {
    const context = source.slice(Math.max(0, source.indexOf(icon) - 220), source.indexOf(icon) + icon.length + 220);
    const data = icon + context;
    const isChart = /chart|canvas|sparkline|axis|series|legend|bar-chart|line-chart/i.test(data);
    const isTheme = /icon-(sun|moon|system)/.test(data);
    const isIllustration = /showcase|hero|arch-|timeline|visual|mockup/i.test(data);
    if (!isChart && !isTheme && !isIllustration) violations.push(`${path.relative(root, file)}: inline SVG may be an operation/status icon`);
  }
}
console.log(`Blora SVG icon audit completed; ${violations.length} remaining SVG candidates require manual classification.`);
