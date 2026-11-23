'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const handlers = new Map();
let enabled = false;
let enableCalls = 0;
const pool = { async query(sql) {
  if (sql.startsWith('SELECT enabled FROM plugins')) return { rows: [{ enabled }] };
  throw new Error(`Unexpected SQL: ${sql}`);
} };
const registry = {
  PLUGINS_DIR: path.resolve(__dirname, '../../plugins'),
  getKnownManifest(id) {
    if (id === 'trusted') return { executionMode: 'trusted-in-process', permissions: ['tasks:register'] };
    if (id === 'isolated') return { executionMode: 'isolated-task', permissions: ['tasks:register'] };
    if (id === 'frontend') return { permissions: ['pages:register'] };
    return null;
  },
  async enable() { enableCalls++; enabled = true; },
  async disable() { enabled = false; },
};
const express = { Router() { return { use() {}, get() {}, post(route, handler) { handlers.set(route, handler); }, put() {}, delete() {}, all() {} }; } };
const moduleFixture = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../routes/plugins.js'), 'utf8'), {
  module: moduleFixture, __dirname: path.resolve(__dirname, '../routes'), path, fs, os: require('node:os'),
  require(id) {
    if (id === 'express') return express;
    if (id === 'path') return path;
    if (id === 'fs') return fs;
    if (id === 'os') return require('node:os');
    if (id === '../models/database') return { pool };
    if (id === '../middleware/auth') return { requireAuth() {}, requireAdmin(req, res, next) { return next(); } };
    if (id === '../utils/audit-log') return { logAction: async () => {} };
    if (id === '../plugins/zip') return {};
    if (id === '../plugins/store-client') return {};
    if (id === '../proxy-pool') return {};
    if (id === '../logger') return { error() {}, info() {}, warn() {} };
    if (id === '../plugins/registry') return registry;
    throw new Error(`Unexpected dependency: ${id}`);
  },
});
moduleFixture.exports.createPluginsRoutes();
async function toggle(id, trustInProcess) {
  const req = { params: { id }, body: trustInProcess === undefined ? {} : { trustInProcess }, authUser: { id: 1, username: 'admin' }, ip: '127.0.0.1', headers: {} };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; this.headersSent = true; } };
  await handlers.get('/:id/toggle')(req, res);
  return res;
}
(async () => {
  enabled = false;
  const refused = await toggle('trusted');
  assert.equal(refused.statusCode, 400);
  assert.equal(enableCalls, 0);
  const accepted = await toggle('trusted', true);
  assert.equal(accepted.statusCode, 200);
  assert.equal(enableCalls, 1);
  enabled = false;
  const isolated = await toggle('isolated');
  assert.equal(isolated.statusCode, 200);
  assert.equal(enableCalls, 2);
  enabled = false;
  const frontend = await toggle('frontend');
  assert.equal(frontend.statusCode, 200);
  assert.equal(enableCalls, 3);
  console.log('PASS admin enable trust gate: trusted backend confirm required; isolated-task and frontend stay distinct');
})().catch(error => { console.error(error); process.exitCode = 1; });
