#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pagesDir = path.join(root, 'public/pages');
const jsDir = path.join(root, 'public/js');
const files = fs.readdirSync(pagesDir).filter((n) => n.endsWith('.html') && !n.endsWith('.bak'));
const elementRe = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<([a-z][\w:-]*)(\s[^<>]*?)?\/?>(?=\s|<|$)/gi;
const rel = (f) => path.relative(root, f).split(path.sep).join('/');
function scan(html) {
  const counts = { controls: 0, nativeDialogs: 0, forms: 0, tables: 0, states: 0, legacyModalContainers: 0 };
  let match;
  while ((match = elementRe.exec(html))) {
    const tag = match[1]?.toLowerCase(); const attrs = (match[2] || '').toLowerCase();
    if (!tag) continue;
    if (/^(button|input|select|textarea)$/.test(tag)) counts.controls++;
    if (tag === 'dialog') counts.nativeDialogs++;
    if (tag === 'form') counts.forms++;
    if (tag === 'table') counts.tables++;
    const classValue = attrs.match(/\bclass\s*=\s*["']([^"']*)["']/)?.[1] || '';
    const semanticAttrs = attrs.match(/\b(?:class|id|role|aria-busy|aria-label)\s*=\s*["']([^"']*)["']/g)?.join(' ') || '';
    if (/(?:^|[\s_-])modal(?:[\s_-]|$)/i.test(classValue)) counts.legacyModalContainers++;
    if (/(?:loading|error|empty|success|status|disabled)/i.test(semanticAttrs)) counts.states++;
  }
  return counts;
}
function pageScripts(html) { return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]); }
const pages = files.map((name) => {
  const file = path.join(pagesDir, name); const html = fs.readFileSync(file, 'utf8'); const scripts = pageScripts(html);
  const dom = scan(html); const legacyDialogApiCalls = (html.match(/\b(?:showModal|closeModal|openDialog|closeDialog)\s*\(/g) || []).length;
  return { page: rel(file), blora: { css: html.includes('/blora/blora.css'), darkTokens: html.includes('/blora/tokens.dark.css'), auto: html.includes('/blora/auto.js'), foundation: html.includes('/js/blora-foundation.js'), scope: /<body\b[^>]*class=["'][^"']*\bblora-page\b/.test(html), version: [...html.matchAll(/\/blora\/(?:blora\.css|tokens\.dark\.css|auto\.js)\?v=([^"']+)/g)].map((m) => m[1]) }, dom: { ...dom, legacyDialogScript: scripts.filter((s) => /\/js\/dialog\.js/.test(s)).length, legacyDialogApiCalls, dynamicTemplates: 'conservative-unobserved', runtime: 'not-observed', observation: 'static-dom-only' }, initialization: 0, scripts };
});
const initialization = fs.readdirSync(jsDir).filter((n) => n.endsWith('.js') && !n.endsWith('.bak')).map((n) => { const source = fs.readFileSync(path.join(jsDir, n), 'utf8'); return { file: rel(path.join(jsDir, n)), domContentLoaded: (source.match(/DOMContentLoaded/g) || []).length, loadEntrypoints: (source.match(/window\.addEventListener\s*\(\s*["']load/g) || []).length }; });
const numericKeys = ['controls', 'nativeDialogs', 'forms', 'tables', 'states', 'legacyModalContainers'];
const numericSummary = Object.fromEntries(numericKeys.map((key) => [key, pages.reduce((n, p) => n + p.dom[key], 0)]));
const summary = { pages: pages.length, pagesWithFoundation: pages.filter((p) => Object.values(p.blora).every(Boolean)).length, ...numericSummary, legacyDialogScript: pages.reduce((n,p) => n+p.dom.legacyDialogScript,0), legacyDialogApiCalls: pages.reduce((n,p) => n+p.dom.legacyDialogApiCalls,0), dynamicTemplates: { value: 'conservative-unobserved', numeric: false }, runtime: { value: 'not-observed', numeric: false } };
const result = { schema: 'crewrouter.blora-page-audit/v3', generatedAt: process.argv.includes('--release') ? new Date().toISOString() : undefined, scope: 'static DOM plus explicit initialization entry points', pages, initialization, migration: { nativeEnhancement: 'CSS classes only; no custom elements claimed', dialog: 'not migrated; legacy dialog.js and modal markup remain', dynamicTemplates: 'conservative count unavailable without runtime', runtime: 'not observed' }, summary };
if (!result.generatedAt) delete result.generatedAt;
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2)); else console.log(`Blora page audit: ${summary.pages} pages\nFoundation loaded: ${summary.pagesWithFoundation}/${summary.pages}\nControls/nativeDialogs/forms/tables/states: ${summary.controls}/${summary.nativeDialogs}/${summary.forms}/${summary.tables}/${summary.states}\nLegacy modal containers/dialog script/API: ${summary.legacyModalContainers}/${summary.legacyDialogScript}/${summary.legacyDialogApiCalls}\nDynamic templates/runtime: ${summary.dynamicTemplates.value}/${summary.runtime.value}`);
if (process.argv.includes('--write')) { const dir = path.join(root, 'audit'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'blora-pages.json'), `${JSON.stringify(result, null, 2)}\n`); const escaped = JSON.stringify(result, null, 2).replace(/[&<>]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c])); fs.writeFileSync(path.join(dir, 'blora-pages.html'), `<!doctype html><meta charset="utf-8"><title>Blora page audit</title><pre>${escaped}</pre>\n`); }
