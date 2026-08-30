'use strict';

const protocol = require('../../protocol');

const transforms = {
  'anthropic->openai': require('./anthropic-to-openai'),
  'openai->anthropic': require('./openai-to-anthropic')
};

const detectedDialects = new Set(['openai', 'anthropic', 'responses', 'gemini']);

function getTransform(sourceFormat, targetFormat) {
  const key = `${sourceFormat}->${targetFormat}`;
  if (transforms[key]) return transforms[key];
  if (detectedDialects.has(sourceFormat) || detectedDialects.has(targetFormat)) {
    return protocol.createBridge(sourceFormat, targetFormat);
  }
  return null;
}

function registerTransform(sourceFormat, targetFormat, transform) {
  transforms[`${sourceFormat}->${targetFormat}`] = transform;
}

function hasTransform(sourceFormat, targetFormat) {
  const transform = getTransform(sourceFormat, targetFormat);
  return !!transform && transform.capability?.status !== protocol.Capability.REJECT;
}

function getRegisteredTransforms() {
  return Object.keys(transforms);
}

function detectResponseFormat(body) {
  if (!body) return 'unknown';
  if (body.candidates || body.promptFeedback || body.usageMetadata) return 'gemini';
  if (body.output && Array.isArray(body.output)) return 'responses';
  if (body.choices && Array.isArray(body.choices)) return 'openai';
  if (body.type === 'message' || body.content || body.stop_reason) return 'anthropic';
  return 'unknown';
}

module.exports = {
  getTransform,
  registerTransform,
  hasTransform,
  getRegisteredTransforms,
  detectResponseFormat,
  getBridgeCapability: protocol.getBridgeCapability
};
