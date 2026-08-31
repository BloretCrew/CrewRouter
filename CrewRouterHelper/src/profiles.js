'use strict';
const fs = require('fs');
const { loadConfig, saveConfig, configPath } = require('./config');
function validUrl(value) { let u; try { u = new URL(String(value)); } catch { throw new Error('URL 无效'); } if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('URL 必须使用 http/https 且不能包含用户凭证'); return u.toString().replace(/\/$/, ''); }
function safeName(name) { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(String(name))) throw new Error('profile 名称无效'); return String(name); }
function data() { const cfg = loadConfig() || {}; const profiles = cfg.profiles && typeof cfg.profiles === 'object' ? cfg.profiles : {}; const current = cfg.current_profile || 'default'; if (!profiles.default && cfg.url) profiles.default = { url: String(cfg.url).replace(/\/$/, ''), key: cfg.key, access_token: cfg.access_token, refresh_token: cfg.refresh_token, expires_at: cfg.expires_at, client_id: cfg.client_id, scope: cfg.scope }; return { cfg, profiles, current }; }
function saveProfiles(profiles, current, base) { const next = { ...base, profiles, current_profile: current }; const selected = profiles[current]; if (selected) { for (const key of ['url','key','access_token','refresh_token','expires_at','client_id','scope']) delete next[key]; Object.assign(next, selected); } saveConfig(next); }
function list() { const { profiles, current } = data(); return Object.entries(profiles).map(([name, p]) => ({ name, current: name === current, url: maskUrl(p.url) })); }
function maskUrl(value) { try { const u = new URL(value); return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname === '/' ? '' : u.pathname}`; } catch { return '(无效 URL)'; } }
function add(name, url) { name = safeName(name); url = validUrl(url); const d = data(); if (d.profiles[name]) throw new Error(`profile 已存在: ${name}`); d.profiles[name] = { url }; saveProfiles(d.profiles, d.current, d.cfg); return list(); }
function use(name) { name = safeName(name); const d = data(); if (!d.profiles[name]) throw new Error(`profile 不存在: ${name}`); saveProfiles(d.profiles, name, d.cfg); return name; }
function remove(name, yes) { name = safeName(name); const d = data(); if (!d.profiles[name]) throw new Error(`profile 不存在: ${name}`); if (name === d.current) throw new Error('不能删除当前 profile，请先切换'); if (!yes) throw new Error('删除 profile 需要 --yes 确认'); delete d.profiles[name]; saveProfiles(d.profiles, d.current, d.cfg); }
function selected() { const d = data(); return d.profiles[d.current] || null; }
module.exports = { validUrl, maskUrl, list, add, use, remove, selected, safeName, profilesData: data, configPath };
