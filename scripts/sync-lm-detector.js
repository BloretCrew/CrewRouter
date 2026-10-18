'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');

const SOURCE_COMMIT = '654c8334bb53951aaf04cbd61252d163649e1369';

async function main() {
  const source = path.resolve(process.argv[2] || '');
  if (!process.argv[2] || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== SOURCE_COMMIT) throw new Error('请提供固定版本的 lm-detector 源码目录');
  const root = path.resolve(__dirname, '../public/vendor/modeltrace');
  const adapter = await fs.readFile(path.join(__dirname, 'vendor/lm-detector-adapter.mjs'), 'utf8');
  await esbuild.build({ stdin: { contents: adapter, resolveDir: path.join(source, 'shared'), loader: 'js' }, bundle: true, format: 'esm', platform: 'neutral', target: 'es2020', legalComments: 'none', outfile: path.join(root, 'fingerprint-core.mjs') });
  await esbuild.build({ stdin: { contents: `import {generateChallenges as generate} from './challenge-browser.js';\nexport function generateChallenges(count = 3) { if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('挑战数量必须为 1–3'); return generate(count); }`, resolveDir: path.join(source, 'shared') }, bundle: true, format: 'esm', platform: 'neutral', target: 'es2020', outfile: path.join(root, 'challenge-browser.mjs') });
  const upstream = JSON.parse(await fs.readFile(path.join(source, 'data/unified_bank.json'), 'utf8'));
  const bank = { schema: 'crewrouter-lm-detector-bank-v1', built_at: upstream.built_at, models: upstream.models.map(({ id, display_name, family, family_name, response_count }) => ({ id, display_name, family, family_name, response_count })) };
  await fs.writeFile(path.join(root, 'data/unified_bank.json'), JSON.stringify(bank, null, 2) + '\n');
  await fs.copyFile(path.join(source, 'data/shared_detector.bin'), path.join(root, 'data/shared_detector.bin'));
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(root, 'LICENSE'));
  const files = {};
  for (const file of ['fingerprint-core.mjs', 'challenge-browser.mjs', 'data/unified_bank.json', 'data/shared_detector.bin', 'LICENSE']) {
    const bytes = await fs.readFile(path.join(root, file));
    files[file] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }
  const metadata = { schema: 'crewrouter-modeltrace-metadata-v1', source_repository: 'https://github.com/Ikaleio/lm-detector', source_commit: SOURCE_COMMIT, algorithm_version: 'lm-detector-shared-v2-crewrouter.1', bank_hash: files['data/unified_bank.json'].sha256, detector_hash: files['data/shared_detector.bin'].sha256, license: 'MIT', files, adaptations: ['Browser/Node shared offline bundle; bounded inputs; public candidate metadata only.', 'Upstream shared detector and bound calibration; no tokenizer probes or external proxy.', 'Three valid answers required for confidence; partial ranking is explicitly uncalibrated.'] };
  await fs.writeFile(path.join(root, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
