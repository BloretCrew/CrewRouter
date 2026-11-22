'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const esbuild = require('esbuild');
const { REAL_MOUNTS } = require('../routes/mounts');
const root = path.resolve(__dirname, '../..');
const mounts = REAL_MOUNTS.filter(entry => entry.runtime === 'index');
const routePackageFiles = ['server/routes/github-actions-oidc.js', 'server/utils/github-oidc.js'];

async function mockLoader() {
  const calls = [];
  let traceCalls = 0;
  let pluginCalls = 0;
  const plugins = { adminRouter: {}, publicRouter: {} };
  const module = { exports: {} };
  const source = await fs.readFile(path.join(root, 'server/routes/mount-loader.js'), 'utf8');
  vm.runInNewContext(source, {
    module,
    require(id) {
      calls.push(id);
      if (id === './model-trace') return { getRouter: () => ({ traceCall: ++traceCalls }) };
      if (id === './plugins') return { createPluginsRoutes: () => { pluginCalls++; return plugins; } };
      return { id };
    },
  });
  return { create: module.exports.createMountRouterLoader, calls, plugins, pluginCalls: () => pluginCalls };
}

test('loader is lazy and preserves same-instance caches and factories', async () => {
  const mock = await mockLoader();
  const load = mock.create();
  assert.deepEqual(mock.calls, []);
  const routers = new Map();
  for (const entry of mounts) {
    const router = load(entry);
    if (!entry.factory) {
      assert.equal(router.id, entry.module);
      if (routers.has(entry.module)) assert.equal(router, routers.get(entry.module));
      routers.set(entry.module, router);
    }
  }
  for (const module of routers.keys()) assert.equal(mock.calls.filter(id => id === module).length, 1, module);
  const trace = mounts.find(entry => entry.factory === 'getRouter');
  assert.notEqual(load(trace), load(trace), 'getRouter is called on each load');
  const admin = mounts.find(entry => entry.id === 'admin-plugins');
  const publicEntry = mounts.find(entry => entry.id === 'public-plugins');
  assert.equal(load(admin), mock.plugins.adminRouter);
  assert.equal(load(publicEntry), mock.plugins.publicRouter);
  assert.equal(mock.pluginCalls(), 1);
  const second = mock.create();
  assert.notEqual(second(mounts[0]), load(mounts[0]));
  second(publicEntry);
  second(admin);
  assert.equal(mock.pluginCalls(), 2, 'plugin factory cache belongs to each loader');
  assert.throws(() => load({ module: './missing' }), /Unknown route module/);
  assert.throws(() => load({ module: 'constructor' }), /Unknown route module/);
});

test('index feature gates precede lazy loading and preserve mount-table order', async () => {
  const source = await fs.readFile(path.join(root, 'server/index.js'), 'utf8');
  const start = source.indexOf('  for (const entry of REAL_MOUNTS)');
  const end = source.indexOf('\n  // 插件系统', start);
  assert.ok(start >= 0 && end > start);
  for (const features of [[], ['gateway'], ['console'], ['plugins'], null]) {
    for (const consoleEnabled of [false, true]) {
      const mock = await mockLoader();
      const loaded = [];
      const mounted = [];
      const load = mock.create();
      const featureEnabled = name => !features || features.includes(name);
      vm.runInNewContext(source.slice(start, end), {
        REAL_MOUNTS, featureEnabled, consoleEnabled,
        loadMountRouter: entry => { loaded.push(entry.id); return load(entry); },
        app: { use: mount => mounted.push(mount) },
      });
      const expected = mounts.filter(entry => (entry.feature === 'public' || featureEnabled(entry.feature))
        && (entry.feature !== 'console' || consoleEnabled));
      assert.deepEqual(loaded, expected.map(entry => entry.id));
      assert.deepEqual(mounted, expected.map(entry => entry.mount));
      assert.deepEqual(new Set(mock.calls), new Set(expected.map(entry => entry.module)));
    }
  }
});

test('esbuild includes all index routes and isolated non-demo bundle loads', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'crewrouter-route-package-'));
  try {
    const result = await esbuild.build({
      absWorkingDir: root, entryPoints: ['server/index.js'],
      bundle: true, platform: 'node', target: 'node22', format: 'cjs',
      packages: 'external', external: ['../public/*', '../../public/*'],
      write: false, metafile: true, logLevel: 'silent',
    });
    for (const file of [...mounts.map(entry => `server/routes/${entry.module.slice(2)}.js`), ...routePackageFiles]) {
      assert.ok(result.metafile.inputs[file], `${file} is included`);
      assert.ok(Object.values(result.metafile.outputs).some(output => output.inputs[file]?.bytesInOutput > 0), `${file} contributes runtime code`);
    }
    const bundle = result.outputFiles[0].text;
    assert.doesNotMatch(bundle, /require\([^\n]*path(?:\d+)?\.join\(__dirname,\s*["']routes["']/);
    assert.doesNotMatch(bundle, /require\([^\n]*entry\.module/);
    const file = path.join(temp, 'app/server.cjs');
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, bundle);
    await fs.mkdir(path.join(temp, 'public/js'), { recursive: true });
    await fs.copyFile(path.join(root, 'public/js/api-key-permissions.json'), path.join(temp, 'public/js/api-key-permissions.json'));
    const config = path.join(temp, 'config.json');
    await fs.writeFile(config, JSON.stringify({
      demo: false, runtime: 'server', edition: 'personal',
      app: { sessionSecret: 'isolated-route-package-test' },
      loginReport: { enabled: false }, statsReport: { enabled: false },
    }));
    const shared = ['./api', './gemini'].map(module => mounts.map((entry, index) => entry.module === module ? index : -1).filter(index => index >= 0));
    const output = execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const original = Module._load;
      Module._load = function(id, ...args) {
        if (id === 'pg') return { Pool: class {
          on() {}
          query() { throw new Error('Database access forbidden in bundle smoke test'); }
          connect() { throw new Error('Database access forbidden in bundle smoke test'); }
          end() { return Promise.resolve(); }
        } };
        return original.call(this, id, ...args);
      };
      const app = require(${JSON.stringify(file)});
      const allRouters = app._router.stack.filter(layer => layer.name === 'router');
      assert.ok(allRouters.length >= ${mounts.length});
      const routers = allRouters.slice(-${mounts.length});
      for (const [index, mount] of ${JSON.stringify(mounts.map(entry => entry.mount))}.entries()) {
        assert.ok(routers[index].regexp.test(mount), 'mount order: ' + mount);
      }
      for (const group of ${JSON.stringify(shared)}) assert.equal(routers[group[0]].handle, routers[group[1]].handle);
      console.log('isolated-non-demo-routes-ok');
      process.exit(0);
    `], {
      cwd: temp, encoding: 'utf8', timeout: 30000,
      env: {
        PATH: process.env.PATH, NODE_PATH: path.join(root, 'node_modules'),
        NODE_ENV: 'test', CR_CONFIG_PATH: config, CR_SKIP_AUTOSTART: '1',
      },
    });
    assert.match(output, /isolated-non-demo-routes-ok/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
