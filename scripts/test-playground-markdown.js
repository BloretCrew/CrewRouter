#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cases = [
  ['https', 'https://example.invalid/path?q=1&x=2', true],
  ['http', 'http://example.invalid/path', true],
  ['mail', 'mailto:test@example.invalid', true],
  ['local', '/fixture/path', true],
  ['fragment', '#fixture', true],
  ['quote', '/fixture/"onmouseover="window.__markdownExecuted=1', true],
  ['single', "/fixture/'onclick='window.__markdownExecuted=1", true],
  ['event', '/fixture/" onmouseover="window.__markdownExecuted=1', false],
  ['javascript', 'javascript:window.__markdownExecuted=1', false],
  ['mixed', 'JaVaScRiPt:window.__markdownExecuted=1', false],
  ['data', 'data:text/html,<svg/onload=window.__markdownExecuted=1>', false],
  ['entity', 'jav&#x61;script:window.__markdownExecuted=1', false],
  ['percent', '%6aavascript%3awindow.__markdownExecuted=1', false],
  ['tab', 'java\tscript:window.__markdownExecuted=1', false],
  ['newline', 'java\nscript:window.__markdownExecuted=1', false],
  ['protocol-relative', '//example.invalid/path', false],
  ['space', 'https://example.invalid/a b', false],
  ['angle', 'https://example.invalid/<probe>', false],
  ['backslash', '/\\example.invalid/path', false],
  ['relative', 'plain/path', false]
].map(([label, url, allowed]) => ({ label, url, allowed, markdown: `[${label}](${url})` }));
const inline = '`[inline-code](https://example.invalid/code)`';
const fenced = '```txt\n[fenced-code](https://example.invalid/code)\n<svg onload="window.__markdownExecuted=1">\n```';
const corpus = cases.map(item => item.markdown).concat(inline, fenced).join('\n\n');
function main() {
  const context = vm.createContext({ document: { addEventListener() {} }, t: value => value });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/playground.js'), 'utf8') + '\nthis.app = Object.create(PlaygroundApp.prototype);', context);
  const app = context.app, failures = [];
  let checks = 0;
  const check = (name, fn) => {
    checks++;
    try { fn(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  };
  for (const item of cases) check(item.label, () => {
    const html = app.renderMarkdown(item.markdown);
    assert.equal(html.includes('<a '), item.allowed, html);
    if (item.allowed) {
      assert.ok(html.includes('target="_blank" rel="noopener noreferrer"'));
      const href = html.match(/href="([^"]*)"/)[1];
      assert.ok(!href.includes('"') && !href.includes("'"), 'quotes escaped inside href');
    }
  });
  check('inline code stays literal', () => assert.ok(!app.renderMarkdown(inline).includes('<a ')));
  check('fenced code stays literal', () => assert.ok(!app.renderMarkdown(fenced).includes('<a ')));
  check('raw HTML escaped', () => assert.ok(!app.renderMarkdown('<svg onload="window.__markdownExecuted=1">').includes('<svg')));
  check('rich copy shares renderer', () => {
    let copied;
    app.messages = [{ content: corpus }]; app.contextMenuTarget = { index: 0 };
    app.hideContextMenu = () => {};
    app.copyToClipboard = (text, type) => { copied = { text, type }; };
    app.handleContextAction('copy-rich');
    assert.equal(copied.type, 'html'); assert.equal(copied.text, app.renderMarkdown(corpus));
  });
  console.log(`VM: ${checks - failures.length}/${checks} passed; failures: ${failures.join(', ') || 'none'}`);
  if (failures.length) process.exitCode = 1;
}
module.exports = { cases, corpus };
if (require.main === module) main();
