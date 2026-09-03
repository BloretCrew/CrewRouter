#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pagesDir = path.join(root, 'public/pages');
const jsDir = path.join(root, 'public/js');
const files = fs.readdirSync(pagesDir).filter((n) => n.endsWith('.html') && !n.endsWith('.bak'));
const patterns = { controls: /<(?:button|input|select|textarea)\b/gi, dialogs: /<(?:dialog)\b|(?:modal|dialog)/gi, forms: /<form\b/gi, tables: /<table\b/gi, states: /(?:loading|error|empty|success|status|disabled|aria-busy|role=["']status)/gi };
const count = (s, re) => (s.match(re) || []).length;
const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const pages = files.map((name) => {
  const file = path.join(pagesDir, name); const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const js = scripts.filter((s) => s.startsWith('/js/')).map((s) => { const f = path.join(root, 'public', s.slice(1)); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; }).join('\n') + '\n' + [...html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  return { page: rel(file), blora: { css: html.includes('/blora/blora.css'), tokens: html.includes('/blora/tokens.css'), darkTokens: html.includes('/blora/tokens.dark.css'), auto: html.includes('/blora/auto.js'), foundation: html.includes('/js/blora-foundation.js') }, dom: Object.fromEntries(Object.entries(patterns).map(([k, re]) => [k, count(html, re)])), initialization: count(js, /(?:DOMContentLoaded|window\.onload|new\s+[A-Z]\w+|\.init\s*\(|addEventListener\s*\()/g), scripts };
});
const initialization = fs.readdirSync(jsDir).filter((n) => n.endsWith('.js') && !n.endsWith('.bak')).map((n) => ({ file: rel(path.join(jsDir, n)), matches: count(fs.readFileSync(path.join(jsDir, n), 'utf8'), /(?:DOMContentLoaded|window\.onload|new\s+[A-Z]\w+|\.init\s*\(|addEventListener\s*\()/g) }));
const result = { schema: 'crewrouter.blora-page-audit/v1', generatedAt: new Date().toISOString(), scope: 'public/pages and public/js', pages, initialization, summary: { pages: pages.length, pagesWithFoundation: pages.filter((p) => Object.values(p.blora).every(Boolean)).length, controls: pages.reduce((n,p) => n+p.dom.controls,0), forms: pages.reduce((n,p) => n+p.dom.forms,0), dialogs: pages.reduce((n,p) => n+p.dom.dialogs,0), tables: pages.reduce((n,p) => n+p.dom.tables,0), states: pages.reduce((n,p) => n+p.dom.states,0) } };
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2)); else console.log(`Blora page audit: ${result.summary.pages} pages\nFoundation loaded: ${result.summary.pagesWithFoundation}/${result.summary.pages}\nControls/forms/dialogs/tables/states: ${result.summary.controls}/${result.summary.forms}/${result.summary.dialogs}/${result.summary.tables}/${result.summary.states}`);
if (process.argv.includes('--write')) { const dir = path.join(root, 'audit'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'blora-pages.json'), `${JSON.stringify(result, null, 2)}\n`); const escaped = JSON.stringify(result, null, 2).replace(/[&<>]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c])); fs.writeFileSync(path.join(dir, 'blora-pages.html'), `<!doctype html><meta charset="utf-8"><title>Blora page audit</title><pre>${escaped}</pre>\n`); }
