'use strict';

const { codecs, getBridgeCapability, getDialectCapability, Capability, ProtocolCapabilityError } = require('./index');

function codecFor(dialect) {
  const codec = codecs[dialect];
  if (!codec) {
    const capability = getDialectCapability(dialect);
    throw new ProtocolCapabilityError(`Unsupported protocol dialect: ${dialect}`, {
      code: 'unsupported_protocol_bridge',
      sourceDialect: dialect,
      targetDialect: dialect,
      capability: capability.status
    });
  }
  return codec;
}

function assertBridge(sourceDialect, targetDialect) {
  const capability = getBridgeCapability(sourceDialect, targetDialect);
  if (capability.status === Capability.REJECT) {
    throw new ProtocolCapabilityError(
      `Unsupported protocol bridge: ${sourceDialect} → ${targetDialect}`,
      { code: 'unsupported_protocol_bridge', sourceDialect, targetDialect }
    );
  }
  return capability;
}

function decodeRequest(sourceDialect, body) {
  return codecFor(sourceDialect).decodeRequest(body || {});
}

function encodeRequest(targetDialect, ir, options = {}) {
  const sourceDialect = ir?.sourceDialect || targetDialect;
  const capability = assertBridge(sourceDialect, targetDialect);
  const target = codecFor(targetDialect);
  const encoded = target.encodeRequest(ir || {});
  return applyRequestQuirks(encoded, targetDialect, ir || {}, options, capability);
}

function decodeResponse(sourceDialect, body) {
  return codecFor(sourceDialect).decodeResponse(body || {});
}

function encodeResponse(targetDialect, ir, options = {}) {
  const sourceDialect = ir?.sourceDialect || targetDialect;
  assertBridge(sourceDialect, targetDialect);
  return codecFor(targetDialect).encodeResponse(ir || {}, options);
}

function decodeStreamEvent(sourceDialect, event) {
  return codecFor(sourceDialect).decodeStreamEvent(event || {});
}

function encodeStreamEvent(targetDialect, ir, options = {}) {
  const sourceDialect = ir?.sourceDialect || targetDialect;
  assertBridge(sourceDialect, targetDialect);
  return codecFor(targetDialect).encodeStreamEvent(ir || {}, options);
}

function applyRequestQuirks(body, targetDialect, ir, options, capability) {
  const quirks = options.quirks || capability.target?.quirks || {};
  const parameters = ir.parameters || {};
  if (parameters.maxTokens !== undefined && quirks.max_completion_tokens === Capability.DEGRADE && targetDialect === 'anthropic') {
    if (body.max_completion_tokens !== undefined) {
      body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
    }
  }
  if (parameters.stream && quirks.stream_usage === Capability.DEGRADE && targetDialect === 'anthropic') {
    delete body.stream_options;
  }
  if (parameters.reasoningEffort && quirks.reasoning_effort === Capability.REJECT) {
    throw new ProtocolCapabilityError(`Reasoning effort is unsupported by ${targetDialect}`, {
      code: 'unsupported_provider_format', sourceDialect: ir.sourceDialect, targetDialect
    });
  }
  return body;
}

module.exports = {
  decodeRequest,
  encodeRequest,
  decodeResponse,
  encodeResponse,
  decodeStreamEvent,
  encodeStreamEvent,
  getBridgeCapability,
  getDialectCapability,
  Capability
};
