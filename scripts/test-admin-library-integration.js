'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function fixture() {
  const calls = [];
  class AdminApp {
    _adminPageIds() { return new Set(['adminTeams', 'adminSettings']); }
    _parseAdminHash(hash) { const [page, id] = hash.replace(/^#/, '').split('/'); return { page, teamId: id ? Number(id) : null }; }
    _buildAdminHash(page) { return `#${page}`; }
    _writeAdminHash(page, options) { calls.push(['hash', page, options]); }
    async navigateTo(page) { calls.push(['legacyNavigate', page]); }
    async loadPage(page) { calls.push(['legacyLoad', page]); }
    async showTeamDetail() {}
    async loadTeams() {}
    async loadTeamModels() {}
    _notifyModelsCatalogChanged() {}
    _syncAdminModelsStickyVisibility() {}
    _syncAdminProvidersStickyVisibility() {}
    _syncAdminTeamsStickyVisibility() {}
    _syncAdminTeamModelsStickyVisibility() {}
  }
  const document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener() {}, documentElement: { classList: { contains: () => false } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/admin-library-integration.js'), 'utf8'), { AdminApp, document, window: {}, location: { hash: '', pathname: '/admin', search: '' }, history: { pushState(_state, _title, url) { calls.push(['push', url]); } }, t: value => value, confirm: async () => true, alert() {}, clearInterval });
  const app = new AdminApp();
  app._instance = { capabilities: { teamAdmin: true } };
  app.closeLibraryManager = () => {};
  app.loadPage = async (page, options) => { calls.push(['load', page, options]); };
  app.openLibraryManager = async (kind, id) => { calls.push(['manager', kind, id]); };
  return { app, calls };
}
test('personal settings, error logs, prompts and plugins retain existing navigation', async () => {
  const { app, calls } = fixture();
  app._unifiedProviders = true;
  for (const page of ['adminSettings', 'adminErrorLogs', 'adminPrompts', 'adminPlugins']) await app.navigateTo(page);
  assert.deepEqual(calls.map(call => call.slice(0, 2)), ['adminSettings', 'adminErrorLogs', 'adminPrompts', 'adminPlugins'].map(page => ['legacyNavigate', page]));
});
test('old provider and model links open management inside the unified library', async () => {
  const { app, calls } = fixture();
  await app.navigateTo('adminProviders');
  await app.navigateTo('adminModels');
  assert.equal(app.currentPage, 'adminModelLibrary');
  assert.deepEqual(calls.filter(call => call[0] === 'manager').map(call => call[1]), ['providers', 'models']);
});
test('old TEAM detail link selects its scope and new hash parses/round trips', async () => {
  const { app, calls } = fixture();
  await app.navigateTo('adminTeams', { teamId: 12 });
  assert.equal(calls.find(call => call[0] === 'load')[2].teamId, 12);
  assert.equal(app._buildAdminHash('adminModelLibrary', { teamId: 12 }), '#adminModelLibrary/team/12');
  const parsed = app._parseAdminHash('#adminModelLibrary/team/12');
  assert.equal(parsed.page, 'adminModelLibrary');
  assert.equal(parsed.teamId, 12);
  assert.equal(app._parseAdminHash('#adminModelLibrary/team/bad').teamId, null);
});
