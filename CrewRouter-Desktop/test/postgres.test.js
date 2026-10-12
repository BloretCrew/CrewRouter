'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadEmbeddedPostgres, isEmbeddedPostgresAvailable } = require('../src/postgres/embedded');
const { resolvePostgresProvider } = require('../src/postgres');

test('embedded loader imports platform binaries before the ESM constructor', async () => {
  const imports = [];
  class Embedded {}
  const Constructor = await loadEmbeddedPostgres(async (specifier) => {
    imports.push(specifier);
    return specifier === 'embedded-postgres' ? { default: Embedded } : {};
  });
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  assert.equal(Constructor, Embedded);
  assert.deepEqual(imports, [`@embedded-postgres/${platform}-${process.arch}`, 'embedded-postgres']);
});

test('embedded loader preserves missing binary errors and rejects invalid exports', async () => {
  const missing = Object.assign(new Error('missing platform binary'), { code: 'ERR_MODULE_NOT_FOUND' });
  await assert.rejects(loadEmbeddedPostgres(async () => { throw missing; }), (error) => error === missing);
  await assert.rejects(loadEmbeddedPostgres(async () => ({})), /未导出数据库构造函数/);
});

test('explicit embedded selection loads the installed ESM dependency', async () => {
  assert.equal(await isEmbeddedPostgresAvailable(), true);
  assert.equal((await resolvePostgresProvider({ prefer: 'embedded' })).name, 'embedded');
});

test('Electron bundled Node loads embedded PostgreSQL without require(ESM)', () => {
  const root = path.resolve(__dirname, '..');
  const result = spawnSync(require('electron'), ['-e', `
    require('./src/postgres').resolvePostgresProvider({ prefer: 'embedded' }).then((provider) => {
      if (provider.name !== 'embedded') throw new Error('Unexpected provider');
      console.log('embedded loaded in Electron ' + process.versions.electron);
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  `], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /embedded loaded in Electron/);
});
