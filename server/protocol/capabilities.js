'use strict';

const Capability = Object.freeze({
  SUPPORTED: 'supported',
  DEGRADE: 'degrade',
  REJECT: 'reject'
});

const Degrade = Object.freeze({
  MAX_COMPLETION_TOKENS: 'max_completion_tokens_to_max_tokens',
  DEVELOPER_TO_SYSTEM: 'developer_to_system',
  STREAM_USAGE: 'stream_usage_shape',
  REASONING_EFFORT: 'reasoning_effort_to_thinking_budget'
});

const Reject = Object.freeze({
  DIALECT_NOT_IMPLEMENTED: 'dialect_not_implemented',
  UNKNOWN_DIALECT: 'unknown_dialect',
  UNSUPPORTED_TRANSFORM: 'unsupported_transform'
});

const ProviderQuirks = Object.freeze({
  openai: Object.freeze({
    max_completion_tokens: Capability.SUPPORTED,
    temperature: Capability.SUPPORTED,
    system: Capability.SUPPORTED,
    developer: Capability.SUPPORTED,
    stream_usage: Capability.SUPPORTED,
    reasoning_effort: Capability.SUPPORTED
  }),
  anthropic: Object.freeze({
    max_completion_tokens: Capability.DEGRADE,
    temperature: Capability.SUPPORTED,
    system: Capability.SUPPORTED,
    developer: Capability.DEGRADE,
    stream_usage: Capability.DEGRADE,
    reasoning_effort: Capability.DEGRADE
  }),
  responses: Object.freeze({
    max_completion_tokens: Capability.REJECT,
    temperature: Capability.REJECT,
    system: Capability.REJECT,
    developer: Capability.REJECT,
    stream_usage: Capability.REJECT,
    reasoning_effort: Capability.REJECT
  }),
  gemini: Object.freeze({
    max_completion_tokens: Capability.REJECT,
    temperature: Capability.REJECT,
    system: Capability.REJECT,
    developer: Capability.REJECT,
    stream_usage: Capability.REJECT,
    reasoning_effort: Capability.REJECT
  })
});

class ProtocolCapabilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProtocolCapabilityError';
    this.code = details.code || Reject.UNSUPPORTED_TRANSFORM;
    this.sourceDialect = details.sourceDialect;
    this.targetDialect = details.targetDialect;
    this.capability = details.capability || Capability.REJECT;
  }
}

function getDialectCapability(dialect) {
  const quirks = ProviderQuirks[dialect];
  if (!quirks) {
    return { dialect, status: Capability.REJECT, reason: Reject.UNKNOWN_DIALECT, quirks: null };
  }
  if (dialect === 'responses' || dialect === 'gemini') {
    return { dialect, status: Capability.REJECT, reason: Reject.DIALECT_NOT_IMPLEMENTED, quirks };
  }
  return { dialect, status: Capability.SUPPORTED, reason: null, quirks };
}

function getBridgeCapability(sourceDialect, targetDialect) {
  const source = getDialectCapability(sourceDialect);
  const target = getDialectCapability(targetDialect);
  if (source.status === Capability.REJECT || target.status === Capability.REJECT) {
    return {
      sourceDialect,
      targetDialect,
      status: Capability.REJECT,
      reason: source.reason || target.reason,
      source,
      target
    };
  }
  return {
    sourceDialect,
    targetDialect,
    status: sourceDialect === targetDialect ? Capability.SUPPORTED : Capability.DEGRADE,
    reason: null,
    source,
    target
  };
}

function rejectUnsupported(sourceDialect, targetDialect, reason) {
  throw new ProtocolCapabilityError(
    `Protocol transform is not available: ${sourceDialect} → ${targetDialect} (${reason})`,
    { sourceDialect, targetDialect, code: reason }
  );
}

module.exports = {
  ProviderQuirks,
  Capability,
  Degrade,
  Reject,
  ProtocolCapabilityError,
  getDialectCapability,
  getBridgeCapability,
  rejectUnsupported
};
