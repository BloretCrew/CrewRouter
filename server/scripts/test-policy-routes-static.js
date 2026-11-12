'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function check(description, fn) {
  fn();
  console.log(`ok - ${description}`);
}

check('admin policies route mounted', () => {
  assert.match(read('server/routes/mounts.js'), /admin-policies/);
  assert.match(read('server/routes/mount-loader.js'), /'\.\/admin-policies'/);
});

check('gateway routes use policyGate', () => {
  const api = read('server/routes/api.js');
  for (const route of ['/chat/completions', '/messages', '/responses']) {
    const pattern = new RegExp(`router\\.post\\('${route.replace('/', '\\/')}',[^\\n]*policyGate`);
    assert.match(api, pattern, `${route} missing policyGate`);
  }
  assert.match(api, /router\.get\('\/models',[^\n]*policyGate/);
  assert.match(read('server/routes/gemini.js'), /policyGate/);
});

check('edition capabilities include teamPolicies', () => {
  const edition = read('server/utils/instance-edition.js');
  assert.match(edition, /teamPolicies: true/);
  assert.match(edition, /teamPolicies: false/);
});

check('suspension gate mounted before routes', () => {
  const index = read('server/index.js');
  assert.match(index, /suspension-gate/);
  assert.match(index, /ensurePolicyPlatformSchema/);
});

check('auth/me exposes suspension state', () => {
  const auth = read('server/routes/auth.js');
  assert.match(auth, /suspended_until/);
  assert.match(auth, /suspensionState/);
});

check('admin UI registers policies page', () => {
  const html = read('public/pages/admin.html');
  assert.match(html, /data-page="adminPolicies"/);
  assert.match(html, /id="adminPoliciesPage"/);
  assert.match(html, /admin-policies\.js/);
  assert.match(html, /time-format\.js/);
  assert.match(html, /suspension-banner\.js/);
  const admin = read('public/js/admin.js');
  assert.match(admin, /case 'adminPolicies'/);
  assert.match(admin, /'adminPolicies'/);
});

check('policy schema defines core tables', () => {
  const schema = read('server/utils/policy/schema.js');
  for (const table of ['access_policies', 'policy_hits', 'policy_settings', 'policy_exemptions', 'policy_versions']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});

check('admin policies API exposes CRUD and members', () => {
  const route = read('server/routes/admin-policies.js');
  for (const endpoint of ['/policies/overview', '/policy-hits', '/policy-members', '/policy-settings', '/policies/preview', '/policies/from-template']) {
    assert.ok(route.includes(endpoint), `${endpoint} missing`);
  }
});

check('console loads suspension banner and time tool', () => {
  const html = read('public/pages/console.html');
  assert.match(html, /suspension-banner\.js/);
  assert.match(html, /time-format\.js/);
});

check('i18n contains policy keys', () => {
  const zh = JSON.parse(read('lang/zh.json'));
  const en = JSON.parse(read('lang/en.json'));
  for (const key of ['策略', '新建策略', '从模板创建', '命中记录']) {
    assert.ok(zh[key] !== undefined, `zh missing ${key}`);
    assert.ok(en[key] !== undefined, `en missing ${key}`);
  }
});

console.log('all static policy checks passed');
