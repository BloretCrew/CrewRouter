#!/usr/bin/env node
'use strict';
const fs = require('fs'); const path = require('path'); const readline = require('readline');
const api = require('../src');
function help() { console.log('用法: cr-report <hook|emit|status|login|logout|test|tui>'); }
function parse(args) { const out = {}; for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) out[args[i].slice(2)] = args[i + 1]?.startsWith('--') ? true : args[++i]; else out._ = [...(out._ || []), args[i]]; } return out; }
async function hook(opts) { let detail = {}; try { const raw = fs.readFileSync(0, 'utf8'); detail = raw.trim() ? JSON.parse(raw) : {}; } catch {} const payload = api.normalizeHook(detail, opts.harness || 'grok', opts.event); if (payload.event) await api.report(payload); }
async function emit(opts) { const payload = { harness: opts.harness, event: opts.event, session_id: opts.session || null, tool_name: opts.tool || null, cwd: opts.cwd || process.cwd(), ts: Math.floor(Date.now() / 1000) }; await api.report(payload); }
async function login(opts) {
  const base = String(opts.url || process.env.CR_ROUTER_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('需要 --url 或 CR_ROUTER_URL');
  const crypto = require('crypto'); const http = require('http'); const { execFile } = require('child_process');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; const redirect = `http://127.0.0.1:${port}/callback`;
  const auth = new URL(`${base}/oauth/authorize`); for (const [key, value] of Object.entries({ client_id: 'crewrouter-helper', response_type: 'code', scope: 'events:report', redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256' })) auth.searchParams.set(key, value);
  console.log(`请在浏览器打开：\\n${auth}`);
  if (process.env.CR_REPORT_NO_BROWSER !== '1') { const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'; execFile(opener, [String(auth)], () => {}); }
  const result = await new Promise((resolve) => { const timer = setTimeout(() => resolve({ error: 'timeout' }), 300000); server.on('request', (req, res) => { const u = new URL(req.url, 'http://127.0.0.1'); const value = { code: u.searchParams.get('code') || '', state: u.searchParams.get('state') || '', error: u.searchParams.get('error') || '' }; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(value.code && value.state === state ? '登录成功，请回到终端。' : '授权失败，请回到终端。'); clearTimeout(timer); resolve(value); }); });
  server.close(); if (result.error || !result.code || result.state !== state) throw new Error('授权失败或超时');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: result.code, client_id: 'crewrouter-helper', redirect_uri: redirect, code_verifier: verifier });
  const response = await new Promise((resolve, reject) => {
    const target = new URL(`${base}/oauth/token`); const transport = target.protocol === 'https:' ? require('https') : require('http');
    const req = transport.request(target, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => { try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, json: JSON.parse(text) }); } catch { reject(new Error('服务端返回非法 JSON')); } }); });
    req.on('error', reject); req.end(body.toString());
  });
  if (!response.ok) throw new Error('换取 token 失败'); const token = response.json;
  if (!token.access_token || !token.refresh_token) throw new Error('服务端返回的凭证不完整');
  api.saveConfig({ url: base, client_id: 'crewrouter-helper', access_token: String(token.access_token), refresh_token: String(token.refresh_token), expires_at: Date.now() / 1000 + Number(token.expires_in || 86400), scope: String(token.scope || 'events:report') });
  console.log(`登录成功，凭证已写入 ${api.configPath()}（权限 600）`);
}
function logout() { const p = api.configPath(); try { fs.unlinkSync(p); console.log(`已删除 ${p}`); } catch (err) { if (err.code === 'ENOENT') console.log(`未找到本地凭证（${p}）`); else throw err; } }
async function test(opts) { const { url, token } = api.getCredential(); if (!url || !token) { console.error(`配置缺失：${api.configPath()}`); return 1; } const ok = await api.postEvent(url, token, { harness: opts.harness || 'grok', event: 'session_start', session_id: `cr-report-test-${Date.now()}`, cwd: process.cwd(), ts: Math.floor(Date.now() / 1000), detail: { source: 'cr-report test' } }, 5000); console.log(ok ? 'HTTP 上报成功' : 'HTTP 上报失败'); return ok ? 0 : 1; }
async function main() { const opts = parse(process.argv.slice(2)); const cmd = opts._?.[0]; if (!cmd || cmd === 'help' || opts.help) { help(); return 0; } if (cmd === 'hook') return hook(opts); if (cmd === 'emit') return emit(opts); if (cmd === 'status') { console.log(api.formatStatus(api.scanStatus(process.argv[1]))); return 0; } if (cmd === 'tui') { console.clear(); console.log(api.formatStatus(api.scanStatus(process.argv[1]))); console.log('\n按 Ctrl+C 退出；状态为只读扫描。'); readline.createInterface({ input: process.stdin, output: process.stdout }).on('close', () => {}); return 0; } if (cmd === 'login') return login(opts); if (cmd === 'logout') return logout(); if (cmd === 'test') return test(opts); if (cmd === 'hooks') { const action = opts._?.[1]; if (action === 'install') { console.log(`已安装 ${api.install(`${process.argv[1]} hook --harness grok`)}`); return 0; } if (action === 'uninstall') { console.log(api.uninstall() ? '已卸载 CrewRouter Hook' : '未找到 CrewRouter Hook'); return 0; } } help(); return 1; }
main().then((code) => { if (Number.isInteger(code)) process.exitCode = code; }).catch(() => { process.exitCode = 0; });
