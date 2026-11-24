'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const { Buffer } = require('node:buffer');

const MAX_RESULT_BYTES = 65536;
const request = JSON.parse(fs.readFileSync('/tmp/request.json', 'utf8'));
if (!request || request.protocol !== 1 || typeof request.pluginId !== 'string' || typeof request.taskName !== 'string' || !['task-entry.js', 'hook-entry.js', 'route-entry.js'].includes(request.entryName)) {
  process.stdout.write(JSON.stringify({ protocol: 1, taskId: request?.taskId, error: 'invalid request frame' }) + '\n');
  process.exit(2);
}
const source = fs.readFileSync('/tmp/plugin-entry.js', 'utf8');
const context = vm.createContext(Object.create(null), {
  name: `plugin:${request.pluginId}`,
  codeGeneration: { strings: false, wasm: false },
  microtaskMode: 'afterEvaluate',
});
const requestLiteral = JSON.stringify(JSON.stringify(request));
const taskNameLiteral = JSON.stringify(request.taskName);
const taskIdLiteral = JSON.stringify(request.taskId);
const execute = new vm.Script(`
  (async () => {
    const factory = (${source});
    if (typeof factory !== 'function') throw new Error('task-entry.js must evaluate to a factory function');
    const handlers = factory();
    if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) throw new Error('task factory must return a handler map');
    const handler = handlers[${taskNameLiteral}];
    if (typeof handler !== 'function') throw new Error('task handler is not registered');
    const request = JSON.parse(${requestLiteral});
    const safeMeta = request.meta && typeof request.meta === 'object' && !Array.isArray(request.meta) ? request.meta : {};
    const result = await handler(request.payload || {}, Object.freeze({ ...safeMeta, taskId: request.taskId, attempt: request.attempt }));
    if (result !== null && result !== undefined && (!result || typeof result !== 'object' || Array.isArray(result))) throw new Error('task result must be a JSON object');
    const output = JSON.stringify({ protocol: 1, taskId: request.taskId, result: result == null ? null : result });
    if (output.length > ${MAX_RESULT_BYTES}) throw new Error('task result exceeds 64 KiB');
    this.__output = output;
  })().catch(error => {
    this.__output = JSON.stringify({ protocol: 1, taskId: ${taskIdLiteral}, error: String(error && error.message || error).slice(0, 2000) });
  });
`);
execute.runInContext(context, { timeout: 1000 });
const readOutput = new vm.Script(`typeof this.__output === 'string' ? this.__output : null`);
const deadline = Date.now() + 25000;
async function main() {
  let output = null;
  while (Date.now() < deadline) {
    output = readOutput.runInContext(context, { timeout: Math.max(1, deadline - Date.now()) });
    if (typeof output === 'string') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (typeof output !== 'string') throw new Error('task execution timed out');
  const frame = JSON.parse(output);
  if (frame.error) {
    process.stdout.write(JSON.stringify(frame) + '\n');
    process.exitCode = 1;
  } else {
    if (Buffer.byteLength(output, 'utf8') > MAX_RESULT_BYTES) throw new Error('task result exceeds 64 KiB');
    process.stdout.write(output + '\n');
  }
}
main().catch(error => {
  process.stdout.write(JSON.stringify({ protocol: 1, taskId: request.taskId, error: String(error?.message || error).slice(0, 2000) }) + '\n');
  process.exitCode = 1;
});
