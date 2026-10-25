'use strict';

const crypto = require('node:crypto');

const STATE_TTL_MS = 5 * 60 * 1000;
const MAX_CONSUMED_STATES = 10_000;
// Session storage remains authoritative so that callbacks can reach another
// application instance. This cache also rejects concurrent stale session copies
// within this process; it is not a distributed compare-and-delete operation.
const consumedStates = new Map();

function stateError() {
  return Object.assign(new Error('PassPort 登录状态无效或已过期，请重新发起登录。'), { code: 'PASSPORT_STATE_INVALID' });
}

function prune(now) {
  for (const [key, expiresAt] of consumedStates) {
    if (expiresAt <= now) consumedStates.delete(key);
  }
}

function keyFor(req, state) {
  return crypto.createHash('sha256').update(`${req.sessionID}\0${state}`).digest('hex');
}

function issueState(req, origin, context, invite = '', now = Date.now()) {
  if (!req.session || typeof req.sessionID !== 'string' || !req.sessionID) throw stateError();
  const state = crypto.randomBytes(32).toString('hex');
  req.session.passportLogin = { state, sessionId: req.sessionID, origin, context, invite, expiresAt: now + STATE_TTL_MS };
  // Do not keep old, unbounded state values that older callbacks accepted.
  delete req.session.passportState;
  delete req.session.passportInvite;
  return state;
}

function consumeState(req, origin, context, now = Date.now()) {
  const state = req.query?.state;
  const code = req.query?.code;
  const pending = req.session?.passportLogin;
  if (typeof req.sessionID !== 'string' || !req.sessionID
      || typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)
      || typeof code !== 'string' || !code.trim() || code.length > 4096
      || !pending || pending.state !== state || pending.sessionId !== req.sessionID
      || pending.origin !== origin || pending.context !== context
      || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= now
      || pending.expiresAt > now + STATE_TTL_MS) throw stateError();
  prune(now);
  const key = keyFor(req, state);
  if (consumedStates.has(key) || consumedStates.size >= MAX_CONSUMED_STATES) throw stateError();
  consumedStates.set(key, pending.expiresAt);
  delete req.session.passportLogin;
  delete req.session.passportState;
  delete req.session.passportInvite;
  return { code, invite: typeof pending.invite === 'string' ? pending.invite : '' };
}

module.exports = { STATE_TTL_MS, issueState, consumeState };
