'use strict';

const { parentPort, workerData } = require('worker_threads');
const { loadCore, loadBank } = require('./model-trace-core');

(async () => {
  const core = await loadCore();
  const { bank } = await loadBank();
  const result = core.analyzeGlobalOutputs(workerData.outputs, bank);
  parentPort.postMessage({ result });
})().catch(() => parentPort.postMessage({ error: '归因计算失败' }));
