'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'crewrouter-modeltrace-package-'));
  try {
    const production = await esbuild.build({ entryPoints: [path.join(root, 'server/index.js')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', packages: 'external', write: false, logLevel: 'silent' });
    assert.ok(production.outputFiles[0].contents.length > 0, 'release server compiles');
    await fs.cp(path.join(root, 'public/vendor/modeltrace'), path.join(temp, 'public/vendor/modeltrace'), { recursive: true });
    await esbuild.build({ entryPoints: [path.join(root, 'server/utils/model-trace-core.js')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', packages: 'external', outfile: path.join(temp, 'core.js'), logLevel: 'silent' });
    const { validateModelTrace } = require('../deploy/build/validate-model-trace');
    validateModelTrace(path.join(temp, 'public'));
    const licensePath = path.join(temp, 'public/vendor/modeltrace/LICENSE');
    const license = await fs.readFile(licensePath);
    await fs.appendFile(licensePath, 'tampered');
    assert.throws(() => validateModelTrace(path.join(temp, 'public')), /Invalid ModelTrace release asset/);
    await fs.writeFile(licensePath, license);
    const result = execFileSync(process.execPath, ['-e', `const core=require(${JSON.stringify(path.join(temp, 'core.js'))});Promise.all([core.loadCore(),core.loadBank()]).then(([api,{bank,metadata}])=>{if(api.generateChallenges(3).length!==3||!bank.models.length||!metadata.bank_hash)throw Error('missing resources');console.log(bank.models.length);}).catch(e=>{console.error(e);process.exitCode=1;});`], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.ok(Number(result.trim()) > 0, 'bundled core loads all offline resources independently of cwd');
    await esbuild.build({ entryPoints: [path.join(root, 'server/utils/model-trace-worker.js')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: path.join(temp, 'model-trace-worker.js'), logLevel: 'silent' });
    await esbuild.build({ entryPoints: [path.join(root, 'server/utils/model-trace-runner.js')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', packages: 'external', outfile: path.join(temp, 'runner.js'), logLevel: 'silent' });
    const workerResult = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(temp, 'runner.js'))}).analyze([{text:Array(300).fill('123').join(' '),expected_count:300}]).then(r=>{if(r.decision!=='not_model')throw Error('missing worker result');console.log('worker-ok');}).catch(e=>{console.error(e);process.exitCode=1;});`], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.match(workerResult, /worker-ok/, 'bundled scoring worker loads offline assets');
    const build = await fs.readFile(path.join(root, 'deploy/build/build-release.js'), 'utf8');
    const stage = await fs.readFile(path.join(root, 'CrewRouter-Desktop/scripts/stage-server.js'), 'utf8');
    assert.ok(build.includes('copyDir(publicSrc, publicDest)'), 'release includes vendored assets');
    assert.ok(stage.includes("const directories = ['public', 'lang']"), 'Desktop includes vendored assets');
    console.log('PASS ModelTrace release compile, isolated bundled runtime, license/library assets and Desktop copy contract');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
