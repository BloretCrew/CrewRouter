'use strict';

const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';

function filterResponsesLiteHeader(headers, targetProtocol, body) {
  const compatible = targetProtocol === 'responses' && (!body || body.reasoning?.context === 'all_turns');
  if (!compatible) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === RESPONSES_LITE_HEADER) delete headers[key];
    }
  }
  return headers;
}

function normalizeResponsesError(body) {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
  }
  const source = parsed?.error || parsed;
  return {
    type: typeof source?.type === 'string' ? source.type : 'upstream_error',
    code: typeof source?.code === 'string' ? source.code : 'upstream_error',
    message: typeof source?.message === 'string' ? source.message : (typeof body === 'string' && body ? body : 'Upstream request failed'),
    ...(source?.param !== undefined ? { param: source.param } : {}),
  };
}

function sendResponsesFailure(res, responseId, status, body) {
  if (res.writableEnded || res.destroyed) return;
  const error = normalizeResponsesError(body);
  if (!res.headersSent) {
    res.removeHeader('Content-Type');
    res.status(status).json({ error });
    return;
  }
  const event = {
    type: 'response.failed',
    response: { id: responseId, object: 'response', status: 'failed', error },
  };
  res.write(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

module.exports = { filterResponsesLiteHeader, normalizeResponsesError, sendResponsesFailure };
