'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  METRIC_COLUMNS,
  USAGE_METRIC_COLUMNS,
  getRequestMetrics,
  parseRateLimitHeaders,
  usageMetricPlaceholders,
  usageMetricValues,
  forwardUpstreamHeaders,
} = require('../utils/request-metrics');

function withClock(fn) {
  const original = Date.now;
  let current = 1_000;
  Date.now = () => current;
  try {
    return fn({
      set(value) { current = value; },
      advance(value) { current += value; },
    });
  } finally {
    Date.now = original;
  }
}

test('parseRateLimitHeaders captures OpenAI, Anthropic and fast headers', () => {
  const headers = new Headers({
    'x-ratelimit-limit-requests': '10000',
    'x-ratelimit-remaining-requests': '9990',
    'x-ratelimit-reset-requests': '6m0s',
    'x-ratelimit-limit-tokens': '30000000',
    'x-ratelimit-remaining-tokens': '29990000',
    'anthropic-ratelimit-input-tokens-remaining': '1234',
    'anthropic-fast-requests-remaining': '7',
    'openai-processing-ms': '842',
    'x-request-id': 'req_abc',
    'retry-after': '30',
    'content-type': 'application/json',
  });
  const parsed = parseRateLimitHeaders(headers);
  assert.equal(parsed.vendor, 'mixed');
  assert.equal(parsed.processing_ms, 842);
  assert.equal(parsed.request_id, 'req_abc');
  assert.equal(parsed.retry_after, '30');
  assert.equal(parsed.headers['x-ratelimit-remaining-requests'], '9990');
  assert.equal(parsed.headers['anthropic-ratelimit-input-tokens-remaining'], '1234');
  assert.equal(parsed.headers['anthropic-fast-requests-remaining'], '7');
  assert.equal(parsed.headers['content-type'], undefined);
});

test('parseRateLimitHeaders rejects invalid processing time and sanitizes CRLF', () => {
  const parsed = parseRateLimitHeaders({
    'openai-processing-ms': 'not-a-number',
    'x-ratelimit-remaining-requests': '12\r\nInjected: 1',
  });
  assert.equal(parsed.processing_ms, null);
  assert.equal(parsed.headers['x-ratelimit-remaining-requests'], '12  Injected: 1');
  assert.equal(parseRateLimitHeaders({}), null);
});

test('streaming metrics compute TTFT, generation, TPOT, TPS and E2E', () => {
  withClock((clock) => {
    const req = { _requestStartedAt: 1_000 };
    const metrics = getRequestMetrics(req);
    const attempt = metrics.beginAttempt({ stream: true, model: 'm1', providerId: 'p1' });
    clock.set(1_050);
    attempt.captureHeaders({ 'openai-processing-ms': '90', 'x-ratelimit-remaining-requests': '9' });
    clock.set(1_300);
    attempt.markFirstByte();
    clock.set(1_500);
    attempt.markToken('content');
    clock.set(2_500);
    attempt.markToken('content');
    clock.set(2_700);
    const snapshot = attempt.finish({ promptTokens: 100, completionTokens: 11 });

    assert.equal(snapshot.isStream, true);
    assert.equal(snapshot.ttftMs, 500);
    assert.equal(snapshot.upstreamFirstByteMs, 300);
    assert.equal(snapshot.generationMs, 1000);
    assert.equal(snapshot.tpotMs, 100);
    assert.equal(snapshot.outputTps, 11);
    assert.equal(snapshot.e2eMs, 1700);
    assert.equal(snapshot.upstreamProcessingMs, 90);
    assert.equal(snapshot.rateLimit.headers['x-ratelimit-remaining-requests'], '9');
  });
});

test('non-stream metrics keep TTFT/TPOT/TPS null', () => {
  withClock((clock) => {
    const req = { _requestStartedAt: 2_000 };
    clock.set(2_000);
    const attempt = getRequestMetrics(req).beginAttempt({ stream: false });
    clock.set(2_200);
    attempt.captureHeaders({ 'anthropic-ratelimit-requests-remaining': '5' });
    clock.set(3_200);
    const snapshot = attempt.finish({ promptTokens: 10, completionTokens: 20 });
    assert.equal(snapshot.ttftMs, null);
    assert.equal(snapshot.generationMs, null);
    assert.equal(snapshot.tpotMs, null);
    assert.equal(snapshot.outputTps, null);
    assert.equal(snapshot.e2eMs, 1200);
    assert.equal(snapshot.upstreamFirstByteMs, 200);
  });
});

test('single token and missing usage avoid misleading TPOT/TPS', () => {
  withClock((clock) => {
    const req = {};
    const metrics = getRequestMetrics(req);
    const first = metrics.beginAttempt({ stream: true });
    clock.set(1_500);
    first.markToken('content');
    clock.set(1_600);
    const oneToken = first.finish({ completionTokens: 1 });
    assert.equal(oneToken.tpotMs, null);
    assert.equal(oneToken.outputTps, null);

    const second = metrics.beginAttempt({ stream: true });
    clock.set(2_000);
    second.markToken('reasoning');
    clock.set(2_400);
    const unknown = second.finish({});
    assert.equal(unknown.tpotMs, null);
    assert.equal(unknown.outputTps, null);
  });
});

test('a new attempt resets timings but keeps the request start', () => {
  withClock((clock) => {
    const req = { _requestStartedAt: 1_000, _upstreamAttemptContext: {} };
    const metrics = getRequestMetrics(req);
    const first = metrics.beginAttempt({ stream: true });
    clock.set(1_100);
    first.markToken();
    const firstSnapshot = first.finish({ completionTokens: 5 });
    assert.equal(firstSnapshot.ttftMs, 100);

    clock.set(2_000);
    const second = metrics.beginAttempt({ stream: true });
    assert.equal(req._upstreamAttemptContext.metrics, second);
    clock.set(2_300);
    second.markToken();
    clock.set(2_800);
    second.markToken();
    const secondSnapshot = second.finish({ completionTokens: 4 });
    assert.equal(secondSnapshot.ttftMs, 1300);
    assert.equal(secondSnapshot.generationMs, 500);
    assert.equal(metrics.lastSnapshot, secondSnapshot);
  });
});

test('usage metric helpers produce matching columns, placeholders and values', () => {
  assert.equal(METRIC_COLUMNS.length, 10);
  assert.equal(USAGE_METRIC_COLUMNS, METRIC_COLUMNS.join(', '));
  assert.equal(usageMetricPlaceholders(22), '$22, $23, $24, $25, $26, $27, $28, $29, $30, $31');
  const values = usageMetricValues({
    isStream: true,
    ttftMs: 123.4,
    upstreamFirstByteMs: 80,
    generationMs: 900,
    tpotMs: 12.3456,
    outputTps: 88.8888,
    e2eMs: 1200,
    upstreamProcessingMs: 70,
    serviceTier: 'PRIORITY',
    rateLimit: { vendor: 'openai', headers: {} },
  });
  assert.equal(values.length, 10);
  assert.equal(values[0], true);
  assert.equal(values[1], 123);
  assert.equal(values[4], 12.346);
  assert.equal(values[5], 88.889);
  assert.equal(values[8], 'priority');
  assert.deepEqual(values[9], { vendor: 'openai', headers: {} });
});

test('forwardUpstreamHeaders only forwards whitelisted observability headers', () => {
  const set = new Map();
  const res = {
    headersSent: false,
    setHeader(name, value) { set.set(name, value); },
  };
  forwardUpstreamHeaders(res, {
    'x-ratelimit-remaining-requests': '9',
    'anthropic-ratelimit-tokens-remaining': '100',
    'openai-processing-ms': '321',
    'set-cookie': 'a=b',
    'x-ratelimit-bad': 'x\r\ny',
    'content-type': 'application/json',
  });
  assert.equal(set.get('x-ratelimit-remaining-requests'), '9');
  assert.equal(set.get('anthropic-ratelimit-tokens-remaining'), '100');
  assert.equal(set.get('openai-processing-ms'), '321');
  assert.equal(set.has('set-cookie'), false);
  assert.equal(set.has('content-type'), false);
  assert.equal(set.get('x-ratelimit-bad'), 'x  y');

  const sent = { headersSent: true, setHeader() { throw new Error('must not set'); } };
  forwardUpstreamHeaders(sent, { 'openai-processing-ms': '1' });
});
