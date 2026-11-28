'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { oauthBearer } = require('../middleware/oauth-bearer');
const { policyGate } = require('../middleware/policy-gate');
const api = require('./api');
const googleError = require('../utils/google-error');
const { requestMiddleware: quotaRequestMiddleware } = require('../utils/quota-request-context');
const { recordEvent } = require('../utils/trace-session');
const { createRequestLifecycle } = require('../utils/request-lifecycle');
const { clientMetaFromReq } = require('../utils/request-source');

const router = express.Router();
router.use(quotaRequestMiddleware);
router.use((req, res, next) => {
  res.once('finish', () => {
    if (!req.apiUser?.keyId) return;
    recordEvent(req, {
      ok: res.statusCode < 400,
      httpStatus: res.statusCode,
      requestType: String(req.path || '').includes('interactions') ? 'interactions' : 'gemini',
      usageRecordId: req._usageRecordId || null,
      requestParams: { model_identity: req._upstreamAttemptContext?.modelIdentity?.snapshot() || { requested_model: require('../utils/model-identity').normalizeModel(req._requestedModel), resolved_model: null, response_model: null } },
      requestSource: req._clientMetaSnapshot?.requestSource,
      userAgent: req._clientMetaSnapshot?.userAgent,
      messages: req.body?.contents || req.body?.input || req.body,
      response: null,
      latencyMs: req._traceStartedAt ? Date.now() - req._traceStartedAt : null,
      error: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null,
    }).catch(() => {});
  });
  req._traceStartedAt = Date.now();
  req._clientMetaSnapshot = clientMetaFromReq(req);
  req._requestLifecycle = createRequestLifecycle(req, res);
  req._requestedModel = req.body?.model;
  const purpose = ['session_summary', 'provider_parse'].includes(req.headers?.['x-crewrouter-call-purpose'])
    ? req.headers['x-crewrouter-call-purpose'] : 'user_request';
  req._skipRequestModelMapping = purpose !== 'user_request';
  req._upstreamAttemptContext = {
    upstreamAttempts: 0,
    signal: req._requestLifecycle.signal,
    requestedModel: req._requestedModel,
    requestId: crypto.randomUUID(),
    purpose
  };
  const disposeLifecycle = () => req._requestLifecycle.dispose();
  res.once('finish', disposeLifecycle);
  res.once('close', disposeLifecycle);
  next();
});

// Gemini generateContent family. Express 4 wildcard keeps `models/...` and
// `tunedModels/...` model names (including their `:` method suffix) intact.
router.get('/models', oauthBearer, policyGate, api.handleGeminiModels);
router.get('/models/*', oauthBearer, policyGate, api.handleGeminiModelGet);
router.post('/models/*', oauthBearer, policyGate, async (req, res) => {
  const rawTarget = String(req.params[0] || '');
  let target = rawTarget;
  try { target = decodeURIComponent(rawTarget); } catch { /* keep raw */ }
  const colon = target.lastIndexOf(':');
  const action = colon === -1 ? '' : target.slice(colon + 1);
  if (action === 'generateContent' || action === 'streamGenerateContent') {
    return api.handleGeminiGenerateContent(req, res, action);
  }
  if (action === 'countTokens') {
    return api.handleGeminiCountTokens(req, res);
  }
  return googleError.sendGoogleError(res, 400, `Unsupported model method: ${action || '(missing)'}`, {
    reason: 'INVALID_ARGUMENT'
  });
});

// Interactions API (v1beta and the stable v1 alias both mount this router).
router.post('/interactions', oauthBearer, policyGate, api.handleInteractionsCreate);
router.get('/interactions/:id', oauthBearer, policyGate, api.handleInteractionsGet);
router.delete('/interactions/:id', oauthBearer, policyGate, api.handleInteractionsDelete);
router.post('/interactions/:id/cancel', oauthBearer, policyGate, api.handleInteractionsCancel);

module.exports = router;
