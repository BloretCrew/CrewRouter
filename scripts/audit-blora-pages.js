#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pagesDir = path.join(root, 'public/pages');
const jsDir = path.join(root, 'public/js');
const files = fs.readdirSync(pagesDir).filter((n) => n.endsWith('.html') && !n.endsWith('.bak'));
const elementRe = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<([a-z][\w:-]*)(\s[^<>]*?)?\/?>/gi;
const attr = (s) => (s || '').toLowerCase();
const rel = (f) => path.relative(root, f).split(path.sep).join('/');
function scan(html) {
  const counts = { controls: 0, dialogs: 0, forms: 0, tables: 0, states: 0 };
  let match;
  while ((match = elementRe.exec(html))) {
    const tag = match[1]?.toLowerCase(); const attrs = attr(match[2]);
    if (!tag) continue;
    if (/^(button|input|select|textarea)$/.test(tag)) counts.controls++;
    if (tag === 'dialog' || /(?:^|[-_])dialog(?:$|[-_])/.test(attrs.match(/class=["'][^"']*["']/)?.[0] || '')) counts.dialogs++;
    if (tag === 'form') counts.forms++;
    if (tag === 'table') counts.tables++;
    if (/(?:class|id|role|aria-busy|aria-label)=["'][^"']*(?:loading|error|empty|success|status|disabled)[^"']*["']/.test(attrs)) counts.states++;
  }
  return counts;
}
function scriptsAndInit(html) {
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const inline = [...html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  return { scripts, initialization: (inline.match(/(?:DOMContentLoaded|window\.onload|window\.addEventListener\s*\(\s*["']load)/g) || []).length };
}
const pages = files.map((name) => { const file = path.join(pagesDir, name); const html = fs.readFileSync(file, 'utf8'); const loaded = scriptsAndInit(html); return { page: rel(file), blora: { css: html.includes('/blora/blora.css'), darkTokens: html.includes('/blora/tokens.dark.css'), auto: html.includes('/blora/auto.js'), foundation: html.includes('/js/blora-foundation.js'), scope: /<body\b[^>]*class=["'][^"']*\bblora-page\b/.test(html) }, dom: scan(html), initialization: loaded.initialization, scripts: loaded.scripts }; });
const initialization = fs.readdirSync(jsDir).filter((n) => n.endsWith('.js') && !n.endsWith('.bak')).map((n) => { const source = fs.readFileSync(path.join(jsDir, n), 'utf8'); return { file: rel(path.join(jsDir, n)), matches: (source.match(/(?:DOMContentLoaded|window\.onload|window\.addEventListener\s*\(\s*["']load)/g) || []).length }; });
const result = { schema: 'crewrouter.blora-page-audit/v2', scope: 'public/pages and explicit page initialization entry points', pages, initialization, migration: { officialFoundation: 'loaded on all public pages', nativeEnhancement: 'blora-button/blora-input classes only; no custom elements claimed', dialog: 'not migrated; legacy dialog.js and modal markup remain', complexPages: 'admin, console, playground not broadly rewritten' }, summary: { pages: pages.length, pagesWithFoundation: pages.filter((p) => Object.values(p.blora).every(Boolean)).length, ...Object.fromEntries(Object.keys(pages[0].dom).map((k) => [k, pages.reduce((n, p) => n + p.dom[k], 0)])) } };
if (process.argv.includes('--release')) result.generatedAt = new Date().toISOString();
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2)); else console.log(`Blora page audit: ${result.summary.pages} pages\nFoundation loaded: ${result.summary.pagesWithFoundation}/${result.summary.pages}\nControls/forms/dialogs/tables/states: ${result.summary.controls}/${result.summary.forms}/${result.summary.dialogs}/${result.summary.tables}/${result.summary.states}`);
if (process.argv.includes('--write')) { const dir = path.join(root, 'audit'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'blora-pages.json'), `${JSON.stringify(result, null, 2)}\n`); const escaped = JSON.stringify(result, null, 2).replace(/[&<>]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c])); fs.writeFileSync(path.join(dir, 'blora-pages.html'), `<!doctype html><meta charset="utf-8"><title>Blora page audit</title><pre>${escaped}</pre>\n`); }
