'use strict';

const openai = require('./openai-chat');
const anthropic = require('./anthropic');
const responses = require('./responses');
const gemini = require('./gemini');
const capabilities = require('./capabilities');

const codecs = { openai, anthropic, responses, gemini };

const featureCompat = Object.freeze({
  phase: 2,
  scope: 'server/providers/transforms',
  apiHotPath: false,
  dialects: Object.freeze({ openai: 'full', anthropic: 'full', responses: 'reject', gemini: 'reject' }),
  compatibility: Object.freeze({ getTransform: true, registerTransform: true })
});

function getCodec(dialect) {
  const codec = codecs[dialect];
  if (!codec) {
    const capability = capabilities.getDialectCapability(dialect);
    capabilities.rejectUnsupported(dialect, dialect, capability.reason);
  }
  return codec;
}

function convert(kind, sourceDialect, targetDialect, value) {
  const capability = capabilities.getBridgeCapability(sourceDialect, targetDialect);
  if (capability.status === capabilities.Capability.REJECT) {
    capabilities.rejectUnsupported(sourceDialect, targetDialect, capability.reason);
  }
  if (sourceDialect === targetDialect) return value;
  const source = getCodec(sourceDialect);
  const target = getCodec(targetDialect);
  const suffix = kind === 'request' ? 'Request' : kind === 'response' ? 'Response' : 'StreamEvent';
  return target[`encode${suffix}`](source[`decode${suffix}`](value));
}

function createBridge(sourceDialect, targetDialect) {
  const capability = capabilities.getBridgeCapability(sourceDialect, targetDialect);
  if (capability.status === capabilities.Capability.REJECT) {
    return {
      capability,
      request: value => capabilities.rejectUnsupported(sourceDialect, targetDialect, capability.reason),
      response: value => capabilities.rejectUnsupported(targetDialect, sourceDialect, capability.reason),
      stream: value => capabilities.rejectUnsupported(targetDialect, sourceDialect, capability.reason)
    };
  }
  return {
    capability,
    request: value => convert('request', sourceDialect, targetDialect, value),
    response: value => convert('response', targetDialect, sourceDialect, value),
    stream: value => convert('stream', targetDialect, sourceDialect, value)
  };
}

module.exports = {
  codecs,
  convertRequest: (source, target, value) => convert('request', source, target, value),
  convertResponse: (source, target, value) => convert('response', source, target, value),
  convertStreamEvent: (source, target, value) => convert('stream', source, target, value),
  createBridge,
  featureCompat,
  ...capabilities
};
