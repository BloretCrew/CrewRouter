'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sandbox = require('../plugins/task-sandbox');

(async () => {
  const previousFlag = process.env.CR_ENABLE_PLUGIN_BWRAP;
  const previousNodePath = process.env.CR_PLUGIN_NODE_PATH;
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-plugin-sandbox-test-'));
  try {
    assert.throws(() => sandbox.assertRuntimeAvailable({ ...process.env, CR_ENABLE_PLUGIN_BWRAP: undefined }), /显式设置/);
    const pluginDir = path.join(fixtureDir, 'fixture');
    fs.chmodSync(fixtureDir, 0o755);
    fs.mkdirSync(pluginDir, { mode: 0o755 });
    const entry = path.join(pluginDir, 'task-entry.js');
    fs.writeFileSync(entry, '() => ({ sum: payload => ({ value: payload.values.reduce((a,b) => a + b, 0) }) })', { mode: 0o444 });
    process.env.CR_ENABLE_PLUGIN_BWRAP = '1';
    process.env.CR_PLUGIN_NODE_PATH = fs.existsSync('/usr/bin/node-22') ? '/usr/bin/node-22' : process.execPath;
    const env = process.env;
    const bwrap = sandbox.selectBwrap(env);
    if (!bwrap) {
      assert.throws(() => sandbox.probeRuntime({ env }), /bubblewrap/);
      console.log('PASS isolated task fails closed when bubblewrap is unavailable');
      return;
    }
    assert.equal(sandbox.probeRuntime({ env }).uid, 65534);
    const { command, args } = sandbox.buildBwrapArgs({ bwrap, nodePath: process.execPath, workerPath: path.resolve(__dirname, '../plugins/task-worker.js'), pluginEntry: entry, frameFile: entry, scratchDir: fixtureDir });
    assert.equal(command, bwrap);
    for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-net', '--ro-bind', '--uid', '--gid', '--cap-drop', '--clearenv', '--disable-userns']) assert.ok(args.includes(flag), `missing isolation flag ${flag}`);
    sandbox.assertModeSupported({ executionMode: 'isolated-task', permissions: ['tasks:register'], taskHandlers: ['sum'] });
    assert.throws(() => sandbox.assertModeSupported({ executionMode: 'isolated-task', permissions: ['tasks:register', 'network'], taskHandlers: ['sum'] }), /不支持/);
    assert.throws(() => sandbox.assertModeSupported({ executionMode: 'isolated-task', permissions: ['tasks:register'], routes: [{ path: '/x' }], taskHandlers: ['sum'] }), /不支持/);
    assert.throws(() => sandbox.assertModeSupported({ executionMode: 'trusted-in-process', permissions: ['tasks:register'], taskHandlers: ['sum'] }), /isolated-task/);
    assert.throws(() => sandbox.assertModeSupported({ executionMode: 'isolated-task', permissions: ['tasks:register'], taskHandlers: ['../escape'] }), /taskHandlers/);
    const result = await sandbox.runTaskInBwrap({ pluginId: 'fixture', pluginDir, taskName: 'sum', payload: { values: [2, 3, 7] }, taskId: 17, attempt: 1 });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { value: 12 });
    assert.match(fs.readFileSync(entry, 'utf8'), /payload/);

    fs.writeFileSync(entry, '() => ({ loop: () => { while (true) {} } })');
    await assert.rejects(sandbox.runTaskInBwrap({ pluginId: 'fixture', pluginDir, taskName: 'loop', payload: {}, taskId: 18, attempt: 1, timeoutMs: 250 }), /终止|失败/);
    fs.writeFileSync(entry, '() => ({ escape: () => process, requireCheck: () => typeof require, fetchCheck: () => typeof fetch })');
    await assert.rejects(sandbox.runTaskInBwrap({ pluginId: 'fixture', pluginDir, taskName: 'escape', payload: {}, taskId: 19, attempt: 1 }), /task result|ReferenceError|not defined|失败/);
    fs.writeFileSync(entry, '() => ({ escape: () => ({}).constructor.constructor("return process")() })');
    await assert.rejects(sandbox.runTaskInBwrap({ pluginId: 'fixture', pluginDir, taskName: 'escape', payload: {}, taskId: 20, attempt: 1 }), /Code generation from strings disallowed|task result|失败/);
    console.log('PASS bwrap isolated task process: unprivileged UID, network/PID namespaces, capability deny, bounded frame and hard-timeout termination');
  } finally {
    if (previousFlag === undefined) delete process.env.CR_ENABLE_PLUGIN_BWRAP;
    else process.env.CR_ENABLE_PLUGIN_BWRAP = previousFlag;
    if (previousNodePath === undefined) delete process.env.CR_PLUGIN_NODE_PATH;
    else process.env.CR_PLUGIN_NODE_PATH = previousNodePath;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
