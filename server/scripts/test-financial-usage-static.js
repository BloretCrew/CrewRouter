#!/usr/bin/env node
const fs = require('fs');
const source = fs.readFileSync(require.resolve('../routes/api'), 'utf8');
const calls = [...source.matchAll(/const usageResult = await recordUsageAndDeduct\(\{([\s\S]*?)\n\s*\}\);/g)];
if (calls.length !== 8) throw new Error(`expected 8 usage calls, got ${calls.length}`);
for (const [index, match] of calls.entries()) {
  const block = match[1];
  if (!/userId:\s*req\.apiUser\.userId/.test(block)) throw new Error(`call ${index + 1} missing userId`);
  if (!/pointsToDeduct\s*\}/.test(block)) throw new Error(`call ${index + 1} missing pointsToDeduct`);
  const placeholders = [...block.matchAll(/\$([0-9]+)/g)].map(m => Number(m[1]));
  const values = block.match(/usageValues:\s*\[([\s\S]*?)\],\s*userId:/);
  if (!values || Math.max(...placeholders) !== values[1].split(',').length) {
    throw new Error(`call ${index + 1} SQL/value count mismatch`);
  }
  const end = source.indexOf('recordQuotaData', match.index);
  const failure = source.indexOf('if (!usageResult.ok)', match.index);
  if (failure < 0 || failure > end) throw new Error(`call ${index + 1} does not stop on usage failure`);
}
console.log('Financial usage static assertions passed (8 calls, parameter counts, failure propagation).');
