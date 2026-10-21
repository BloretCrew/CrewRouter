#!/usr/bin/env node
const fs = require('fs');
const source = fs.readFileSync(require.resolve('../routes/api'), 'utf8');
const calls = [...source.matchAll(/const usageResult = await recordUsageAndDeduct\(\{([\s\S]*?)\n\s*\}\);/g)];
if (calls.length !== 8) throw new Error(`expected 8 usage calls, got ${calls.length}`);
if ((source.match(/if \(err\.billingFailure\)/g) || []).length < 8) {
  throw new Error('not all usage catches handle billingFailure');
}
for (const [index, match] of calls.entries()) {
  const block = match[1];
  if (!/userId:\s*req\.apiUser\.userId/.test(block)) throw new Error(`call ${index + 1} missing userId`);
  if (!/pointsToDeduct\s*:/.test(block)) throw new Error(`call ${index + 1} missing pointsToDeduct`);
  const expanded = block.replace(/\$\{usageMetricPlaceholders\((\d+)\)\}/g, (_, start) => {
    const base = Number(start);
    return Array.from({ length: 10 }, (_, i) => `$${base + i}`).join(', ');
  });
  const placeholders = [...expanded.matchAll(/\$([0-9]+)/g)].map(m => Number(m[1]));
  const values = block.match(/usageValues:\s*\[([\s\S]*?)\],\s*userId:/);
  if (!values) throw new Error(`call ${index + 1} missing usageValues`);
  const rawValues = values[1];
  const identitySpreads = (rawValues.match(/\.\.\.modelIdentityValues\(/g) || []).length;
  const metricSpreads = (rawValues.match(/\.\.\.usageMetricValues\(/g) || []).length;
  const withoutSpreads = rawValues
    .replace(/\.\.\.modelIdentityValues\([^)]*\)/g, 'spread')
    .replace(/\.\.\.usageMetricValues\([^)]*\)/g, 'spread');
  const valueCount = withoutSpreads.split(',').length + identitySpreads * 2 + metricSpreads * 9;
  if (Math.max(...placeholders) !== valueCount) throw new Error(`call ${index + 1} SQL/value count mismatch`);
  const next = calls[index + 1]?.index ?? source.length;
  const region = source.slice(match.index, next);
  if (!/if \(!usageResult\.ok\)[\s\S]*?throw new Error/.test(region)) throw new Error(`call ${index + 1} does not stop on usage failure`);
  if (!/if \(err\.billingFailure\)[\s\S]*?(?:res\.status\(500\)|res\.destroy\(err\))/.test(region)) throw new Error(`call ${index + 1} catch swallows billing failure`);
}
console.log('Financial usage static assertions passed (8 calls, parameter counts, failure propagation).');
