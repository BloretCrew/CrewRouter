import { parseNumbers as parse } from './fingerprint-core.js';
import { decodeDetector } from './detector-codec.ts';
import { analyzeSharedOutputs, supportsSharedDetector } from './shared-detector.ts';

export const LIMITS = Object.freeze({ maxTextChars: 65536, maxBankBytes: 262144, maxDetectorBytes: 8388608 });
const detectors = new WeakMap();

export function parseNumbers(text) {
  if (typeof text !== 'string' || text.length > LIMITS.maxTextChars) throw new TypeError('回答必须是有界字符串');
  return parse(text);
}

export function validateBank(bank) {
  if (!bank || bank.schema !== 'crewrouter-lm-detector-bank-v1' || typeof bank.built_at !== 'string' || !Array.isArray(bank.models) || !bank.models.length || bank.models.length > 512) throw new Error('无效指纹库 schema');
  const ids = new Set();
  for (const model of bank.models) {
    if (!model || typeof model.id !== 'string' || !model.id || model.id.length > 256 || ids.has(model.id) || typeof model.display_name !== 'string' || model.display_name.length > 256 || typeof model.family !== 'string' || !Number.isSafeInteger(model.response_count) || model.response_count < 1) throw new Error('无效指纹库候选');
    ids.add(model.id);
  }
  return bank;
}

export function parseBankJson(text) {
  if (typeof text !== 'string' || text.length > LIMITS.maxBankBytes) throw new Error('bank bytes 超出限制');
  return validateBank(JSON.parse(text));
}

export function attachDetector(bank, bytes) {
  validateBank(bank);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > LIMITS.maxDetectorBytes) throw new Error('无效检测器大小');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const start = Math.ceil((4 + headerLength) / 4) * 4;
  if (!headerLength || start >= bytes.length || (bytes.length - start) % 4) throw new Error('无效检测器头部');
  const detector = decodeDetector(bytes);
  if (!supportsSharedDetector(bank, detector)) throw new Error('指纹库与检测器版本不匹配');
  detectors.set(bank, detector);
  return bank;
}

export function analyzeGlobalOutputs(outputs, bank) {
  if (!detectors.has(bank) || !Array.isArray(outputs) || !outputs.length || outputs.length > 3) throw new Error('无效指纹库或输入');
  for (const output of outputs) {
    if (!output || typeof output.text !== 'string' || output.text.length > LIMITS.maxTextChars || (output.expected_count !== undefined && (!Number.isInteger(output.expected_count) || output.expected_count < 1 || output.expected_count > 4096))) throw new Error('无效指纹库或输入');
  }
  return analyzeSharedOutputs(outputs, bank, detectors.get(bank), { allowPartial: true });
}
