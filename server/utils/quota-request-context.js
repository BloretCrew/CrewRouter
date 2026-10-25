'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID, createHash } = require('node:crypto');
const { combineAbortSignals, releaseCombinedAbortSignal } = require('./request-lifecycle');
const { validateUrl } = require('./url-validator');
const storage = new AsyncLocalStorage();

function recordSkip(state, reason, metadata = {}) {
  const fact = { reason, ...metadata };
  state?.skips.push(fact);
  void safely(() => require('../logger').info(`[QuotaRequestSkip] request=${state?.id || 'unknown'} reason=${reason} status=${metadata.status ?? 'none'}`));
}

function capture() { return require('./request-quota-capture'); }
const ASYNC_DEADLINE_MS = 250;
const STRICT_DEADLINE_MS = 25000;
const MAX_PENDING = 1000;
const persistenceHealth = { pending: 0, timedOut: 0, rejected: 0, failed: 0 };

function degraded(operation, reason) {
  try { require('../logger').warn(`[QuotaRequestDegraded] operation=${operation} reason=${reason}`); } catch (_) { /* Forwarding must remain available. */ }
}

function tracked(fn, operation) {
  if (persistenceHealth.pending >= MAX_PENDING) {
    persistenceHealth.rejected++;
    degraded(operation, 'inflight_limit');
    return Promise.resolve(null);
  }
  persistenceHealth.pending++;
  return Promise.resolve().then(fn).catch(() => {
    persistenceHealth.failed++;
    degraded(operation, 'persistence_unavailable');
    return null;
  }).finally(() => { persistenceHealth.pending--; });
}

async function bounded(promise, operation, deadline = ASYNC_DEADLINE_MS) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => {
      timer = setTimeout(() => {
        persistenceHealth.timedOut++;
        degraded(operation, 'deadline_exceeded');
        resolve(null);
      }, deadline);
    })]);
  } finally { clearTimeout(timer); }
}

function safely(fn, operation = 'capture', deadline = ASYNC_DEADLINE_MS) {
  return bounded(tracked(fn, operation), operation, deadline);
}

function safeText(value, max = 512) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/sk-[a-z0-9_-]+|bearer\s+\S+|(?:api[_-]?key|authorization|token|secret)\s*[=:]/i.test(text)) {
    return `redacted:${createHash('sha256').update(text).digest('hex')}`;
  }
  return text.slice(0, max);
}

async function ensureLogicalRequestSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS quota_logical_requests (
    id UUID PRIMARY KEY, user_id INTEGER, team_id INTEGER, api_key_id INTEGER,
    project_id TEXT, session_id TEXT, source TEXT, started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL,
    skip_reason TEXT, http_status INTEGER
  ); CREATE INDEX IF NOT EXISTS idx_quota_logical_requests_user_started
    ON quota_logical_requests(user_id, started_at DESC)`);
}

async function persistLogicalRequest(state, res, db = require('./quota-capture-database').getQuotaCapturePool()) {
  const context = contextFor(state, {});
  const disconnected = state.signal?.aborted;
  const status = disconnected ? 'cancelled' : (res.statusCode >= 400 ? 'rejected' : 'success');
  await db.query(`INSERT INTO quota_logical_requests
    (id,user_id,team_id,api_key_id,project_id,session_id,source,started_at,ended_at,status,skip_reason,http_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
  [state.id, context.user_id, context.team_id, context.api_key_id, context.project_id,
    context.session_id, context.source, state.startedAt, new Date(), status,
    state.skips[0]?.reason || null, res.statusCode]);
}

function requestMiddleware(req, res, next) {
  const controller = new AbortController();
  const state = { req, id: randomUUID(), startedAt: new Date(), attempts: [], skips: [], signal: controller.signal };
  const aborted = () => controller.abort();
  req.once?.('aborted', aborted);
  req._quotaRequestContext = state;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    req.removeListener?.('aborted', aborted);
    if (!state.attempts.length && !state.skips.length) {
      recordSkip(state, res.statusCode >= 400 ? 'rejected_before_upstream' : 'no_upstream', { status: res.statusCode });
    }
    state.persisted = safely(() => persistLogicalRequest(state, res), 'logical_request');
  };
  res.once('finish', finish);
  res.once('close', () => {
    if (!res.writableFinished && !finished) aborted();
    finish();
  });
  storage.run(state, next);
}

function contextFor(state, options) {
  const req = state?.req || {};
  const user = req.apiUser || req.session?.user || {};
  const { clientMetaFromReq } = require('./request-source');
  const source = clientMetaFromReq(req).requestSource;
  const identity = require('./session-identity').extractRequestIdentity(req, { requestSource: source });
  let body;
  try { body = JSON.parse(options.body); } catch (_) { body = {}; }
  return {
    logical_request_id: state?.id || options.requestContext?.requestId || randomUUID(),
    user_id: user.userId ?? user.id ?? null,
    team_id: user.teamId ?? user.team_id ?? null,
    api_key_id: user.keyId ?? null,
    project_id: safeText(identity?.project || identity?.cwd),
    session_id: safeText(identity?.sessionId, 128),
    source: safeText(source, 64) || 'unknown',
    platform: safeText(req.headers?.['x-crewrouter-platform'], 64),
    requested_model: safeText(req._requestedModel || req.body?.model, 256),
    model: safeText(body?.model, 256),
    streaming: body?.stream === true,
    started_at: new Date()
  };
}

function usageMetadata(usage) {
  if (!usage || typeof usage !== 'object') return { usage_quality: 'unknown' };
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (input == null && output == null) return { usage_quality: 'unknown' };
  return {
    input_tokens: input ?? null,
    output_tokens: output ?? null,
    cache_read_tokens: usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? null,
    cache_creation_tokens: usage.cache_creation_input_tokens ?? null,
    total_tokens: usage.total_tokens ?? (Number(input || 0) + Number(output || 0)),
    usage_quality: 'actual'
  };
}

function failureStatus(error, signal) {
  if (error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || signal?.reason?.name === 'TimeoutError') return 'timeout';
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') return 'cancelled';
  return 'failed';
}

// Wrap only explicit LLM calls; never tee or pre-read the upstream body.
async function quotaFetch(url, options = {}, transport = globalThis.fetch) {
  // Central SSRF boundary for every provider request, including fusion and
  // proxy-pool callers that do not pass through a provider adapter.
  const urlCheck = await validateUrl(String(url), { allowPrivate: false });
  if (!urlCheck.ok) {
    throw new Error(`上游 URL 未通过 SSRF 校验: ${urlCheck.error}`);
  }
  url = urlCheck.url.toString();
  options = { ...options, pinnedTarget: urlCheck };
  const dispatch = (targetUrl, requestOptions) => transport === globalThis.fetch
    ? require('../proxy-pool').pinnedFetchValidated(urlCheck, requestOptions)
    : transport(targetUrl, requestOptions);
  const provider = options.quotaProvider;
  const state = options.quotaState || storage.getStore();
  if (!provider) return dispatch(url, options);
  const signal = combineAbortSignals(options.signal, options.requestContext?.signal, state?.signal);
  options = { ...options, signal };
  if (signal?.aborted) {
    recordSkip(state, 'aborted_before_upstream');
    releaseCombinedAbortSignal(signal);
    return dispatch(url, options);
  }
  const attempt = { id: null, providerId: provider.id, modelConfig: options.quotaModel, metadata: { usage_quality: 'unknown' }, ended: false, persistence: Promise.resolve(), persistedMetadata: null };
  state?.attempts.push(attempt);
  const config = await safely(() => capture().getCaptureConfig?.(), 'read_config');
  attempt.deadline = config?.mode === 'strict' ? STRICT_DEADLINE_MS : ASYNC_DEADLINE_MS;
  attempt.persistence = tracked(async () => {
    attempt.id = await capture().beginAttempt(contextFor(state, options), provider, options.quotaKey ?? provider.api_key ?? '');
    return attempt.id;
  }, 'begin_attempt');
  await bounded(attempt.persistence, 'begin_attempt', attempt.deadline);
  attempt.update = async metadata => {
    Object.assign(attempt.metadata, metadata);
    const snapshot = { ...attempt.metadata };
    const signature = JSON.stringify(snapshot);
    if (signature !== attempt.persistedMetadata) {
      if (persistenceHealth.pending >= MAX_PENDING) {
        persistenceHealth.rejected++;
        degraded('end_attempt', 'inflight_limit');
        return bounded(attempt.persistence, 'end_attempt', attempt.deadline);
      }
      attempt.persistedMetadata = signature;
      const previous = attempt.persistence;
      attempt.persistence = tracked(async () => {
        await previous;
        if (attempt.id) await capture().endAttempt(attempt.id, snapshot);
      }, 'end_attempt');
    }
    await bounded(attempt.persistence, 'end_attempt', attempt.deadline);
  };
  const update = attempt.update;
  const end = async (status, error) => {
    if (attempt.ended) { await update({}); return; }
    attempt.ended = true;
    signal?.removeEventListener('abort', aborted);
    releaseCombinedAbortSignal(signal);
    await update({ status, ended_at: new Date(), error_class: ['cancelled', 'timeout'].includes(status) ? status : (error ? 'network_error' : (attempt.protocolFailed ? 'protocol_error' : null)) });
  };
  const aborted = () => { void end(failureStatus(null, signal)); };
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) {
    recordSkip(state, 'aborted_before_send');
    await end(failureStatus(null, signal));
    throw signal.reason || Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  }
  let response;
  try { response = await dispatch(url, { ...options, quotaOnTerminal: (status, error) => { void end(attempt.cancelling ? 'cancelled' : status, error); } }); }
  catch (error) { await end(failureStatus(error, signal), error); throw error; }
  attempt.responseOk = response.ok;
  const terminal = () => end(response.ok ? 'success' : 'rejected');
  const observe = value => {
    const usage = value?.usage || value?.response?.usage || value?.message?.usage;
    if (usage) {
      const metadata = usageMetadata(usage);
      for (const [key, value] of Object.entries(metadata)) {
        if (value != null) attempt.metadata[key] = value;
      }
      if (usage.total_tokens == null) {
        attempt.metadata.total_tokens = Number(attempt.metadata.input_tokens || 0) + Number(attempt.metadata.output_tokens || 0);
      }
    }
    if (value?.type === 'response.incomplete' || value?.type === 'error' || value?.type === 'response.failed' || value?.error) {
      attempt.protocolFailed = true;
    }
  };
  const decoder = new TextDecoder();
  let buffer = '';
  let dropping = false;
  let frameData = [];
  let frameSize = 0;
  const push = chunk => {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) {
        if (!dropping && frameData.length) {
          try { observe(JSON.parse(frameData.join('\n'))); } catch (_) { /* Non-JSON SSE markers. */ }
        }
        frameData = [];
        frameSize = 0;
        dropping = false;
      } else if (!dropping && line.startsWith('data:')) {
        frameSize += line.length;
        if (frameSize <= 262144) frameData.push(line.slice(5).trim());
        else { frameData = []; dropping = true; }
      }
    }
    if (buffer.length > 262144) { buffer = ''; dropping = true; }
  };
  const finish = () => end(attempt.protocolFailed ? 'failed' : (response.ok ? 'success' : 'rejected'));
  const wrapReader = reader => new Proxy(reader, {
    get(target, property) {
      if (property === 'read') return async (...args) => {
        try {
          const result = await target.read(...args);
          if (result.done) { push(new TextEncoder().encode('\n\n')); await finish(); }
          else push(result.value);
          return result;
        } catch (error) { await end(failureStatus(error, signal), error); throw error; }
      };
      if (property === 'cancel') return async (...args) => {
        attempt.cancelling = true;
        try { return await target.cancel(...args); } finally { await end('cancelled'); }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  let adaptedBody;
  const lazyBody = () => {
    if (adaptedBody) return adaptedBody;
    let reader;
    adaptedBody = new ReadableStream({
      async pull(controller) {
        reader ||= wrapReader(response.body.getReader());
        try {
          const result = await reader.read();
          if (result.done) { controller.close(); reader.releaseLock(); }
          else controller.enqueue(result.value);
        } catch (error) { controller.error(error); reader.releaseLock(); }
      },
      async cancel(reason) {
        reader ||= wrapReader(response.body.getReader());
        try { await reader.cancel(reason); } finally { reader.releaseLock(); }
      }
    }, { highWaterMark: 0 });
    return adaptedBody;
  };
  const body = response.body && new Proxy(response.body, {
    get(target, property) {
      if (['pipeTo', 'pipeThrough', 'values', 'tee'].includes(property) || property === Symbol.asyncIterator) {
        const stream = lazyBody();
        return stream[property].bind(stream);
      }
      if (property === 'getReader') return (...args) => adaptedBody ? adaptedBody.getReader(...args) : wrapReader(target.getReader(...args));
      if (property === 'cancel') return async (...args) => {
        attempt.cancelling = true;
        try { return await (adaptedBody || target).cancel(...args); } finally { await end('cancelled'); }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  if (!response.body) await terminal();
  return new Proxy(response, {
    get(target, property) {
      if (property === 'quotaAttempt') return attempt;
      if (property === 'body') return body;
      if (['json', 'text', 'arrayBuffer', 'bytes', 'blob', 'formData'].includes(property) && typeof target[property] === 'function') return async (...args) => {
        try {
          const value = await target[property](...args);
          if (property === 'json') observe(value);
          else {
            let text = value;
            if (property === 'arrayBuffer' || property === 'bytes') text = new TextDecoder().decode(value);
            if (property === 'blob') text = await value.text();
            try { observe(JSON.parse(text)); } catch (_) { /* Non-JSON bodies do not imply token usage. */ }
          }
          await finish();
          return value;
        } catch (error) { await end(failureStatus(error, signal), error); throw error; }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

async function linkUsage({ id, points, weightedTokens, attempt, attempts, req, modelConfig } = {}) {
  const state = req?._quotaRequestContext || storage.getStore();
  const latest = state?.attempts[state.attempts.length - 1];
  const targets = attempts || (attempt ? [attempt] : [latest?.metadata.status === 'success' ? latest : null]);
  const selected = targets.filter(Boolean);
  const weights = selected.map(target => {
    if (target.metadata.usage_quality !== 'actual') return null;
    return require('./billing').calculateCost(target.modelConfig || modelConfig || {}, {
      promptTokens: target.metadata.input_tokens || 0,
      completionTokens: target.metadata.output_tokens || 0,
      cachedTokens: target.metadata.cache_read_tokens || 0
    }).weightedTokens;
  });
  const knownWeight = weights.reduce((sum, weight) => sum + (weight || 0), 0);
  const unknownCount = weights.filter(weight => weight == null).length;
  const remainingWeight = Math.max(Number(weightedTokens || 0) - knownWeight, 0);
  const allocatedWeights = weights.map(weight => weight ?? (unknownCount ? remainingWeight / unknownCount : 0));
  const totalWeight = allocatedWeights.reduce((sum, weight) => sum + weight, 0);
  const { toMoneyMicros, moneyMicrosToString } = require('./money');
  const pointMicros = points == null ? null : toMoneyMicros(points);
  const shares = allocatedWeights.map(weight => BigInt(Math.round(weight * 1000000)));
  const totalShares = shares.reduce((sum, share) => sum + share, 0n);
  let assignedPoints = 0n;
  const updates = [];
  for (const [index, target] of selected.entries()) {
    const metadata = { ...target.metadata, usage_record_id: id };
    if (selected.length > 1) {
      metadata.weighted_tokens = allocatedWeights[index];
      if (weights[index] == null || (pointMicros != null && totalWeight === 0)) metadata.usage_quality = 'estimated';
      if (pointMicros != null) {
        const share = index === selected.length - 1 ? pointMicros - assignedPoints
          : (totalShares > 0n ? pointMicros * shares[index] / totalShares : pointMicros / BigInt(selected.length));
        assignedPoints += share;
        metadata.points = moneyMicrosToString(share);
      }
    }
    if (targets.length === 1) {
      if (target.metadata.usage_quality !== 'actual' && (points != null || weightedTokens != null)) metadata.usage_quality = 'estimated';
      if (points != null) metadata.points = points;
      if (weightedTokens != null) metadata.weighted_tokens = weightedTokens;
    }
    if (target.update) updates.push(target.update(metadata));
    else if (target.id) updates.push(safely(() => capture().endAttempt(target.id, metadata), 'link_usage'));
  }
  await Promise.all(updates);
}

module.exports = { bounded, persistenceHealth, safeText, ensureLogicalRequestSchema, persistLogicalRequest, requestMiddleware, quotaFetch, linkUsage, usageMetadata, recordSkip, storage };
