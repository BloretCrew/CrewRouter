'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages, WEB_PAGE_MAP, navGroups } = require('../tui/pages');

function runtime(isAdmin = true) {
  return { client: { isAdmin }, cfg: { tui: { days: 30 } }, profileName: 'test', baseUrl: 'http://localhost' };
}

test('TUI pages map every console and admin navigation entry', () => {
  const pages = buildPages(runtime());
  const ids = new Set(pages.map(page => page.id));
  assert.equal(new Set(pages.map(page => page.id)).size, pages.length);
  for (const mapping of WEB_PAGE_MAP) assert.ok(ids.has(mapping.cli), `${mapping.area}.${mapping.web} maps to ${mapping.cli}`);
  assert.ok(ids.has('service'), 'CLI retains its local service/profile page');
  assert.ok(ids.has('overview'), 'CLI retains its overview page');
  assert.deepEqual(navGroups.map(group => group.id), ['console', 'admin', 'cli']);
  for (const page of pages) assert.ok(navGroups.some(group => group.pages.includes(page.id)), `${page.id} belongs to a navigation group`);
});

test('admin-only collection pages explain access for non-admin sessions without calling APIs', async () => {
  const pages = buildPages(runtime(false));
  const ids = ['admin-users', 'admin-error-logs', 'admin-prompts', 'admin-plugins', 'admin-model-library', 'admin-teams'];
  for (const id of ids) {
    const page = pages.find(item => item.id === id);
    assert.ok(page, `${id} exists`);
    let requested = false;
    const data = await page.load(async () => { requested = true; throw new Error('unexpected request'); });
    assert.equal(requested, false, `${id} must not request admin API as a non-admin`);
    assert.match(data.sections[0].rows[0].label, /管理员/);
  }
});
