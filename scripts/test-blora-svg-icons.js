'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const violations = [];

for (const name of fs.readdirSync(path.join(root, 'public/pages')).filter(n => n.endsWith('.html'))) {
  const file = path.join(root, 'public/pages', name);
  const html = fs.readFileSync(file, 'utf8');
  const parsed = execFileSync('python3', ['-c', `from bs4 import BeautifulSoup; import sys
s=BeautifulSoup(sys.stdin.read(),'html.parser')
for x in s.find_all('svg'):
 p=x.find_parent(['button','a','blora-tab'])
 if p and not any(c in (x.get('class') or []) for c in ['icon-sun','icon-moon','icon-system']): print('interactive')`,], { input: html, encoding: 'utf8' });
  if (parsed.trim()) violations.push(`${path.relative(root, file)}: inline SVG inside interactive element`);
}
for (const dir of ['public/js']) {
  for (const name of fs.readdirSync(path.join(root, dir)).filter(n => n.endsWith('.js'))) {
    const file = path.join(root, dir, name), source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
      const before = source.slice(Math.max(0, match.index - 600), match.index);
      const after = source.slice(match.index + match[0].length, match.index + match[0].length + 600);
      if (/data:image\/svg\+xml/.test(before.slice(-180))) continue; if (/<button[^>]*>[\s\S]*$/.test(before) && /<\/button>/.test(after)) {
        if (!/empty-state|stat-card|pg-thinking-icon|collapse-icon|avatar|chart/i.test(before + after)) violations.push(`${path.relative(root, file)}: inline SVG in dynamic interactive context`);
      }
    }
  }
}
if (violations.length) { console.error(violations.join('\n')); process.exit(1); }
console.log('Blora SVG icon audit passed; no unclassified interactive SVGs remain.');
