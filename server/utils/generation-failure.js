'use strict';

function sendGenerationFailure(res, responseId, status, body) {
  if (res.writableEnded || res.destroyed) return;
  let parsed = body;
  if (typeof body === 'string') { try { parsed = JSON.parse(body); } catch { parsed = null; } }
  const source = parsed?.error || parsed;
  const error = {
    type: typeof source?.type === 'string' ? source.type : 'upstream_error',
    code: typeof source?.code === 'string' ? source.code : 'upstream_error',
    message: typeof source?.message === 'string' ? source.message : (typeof body === 'string' && body ? body : 'Upstream request failed'),
    ...(source?.param !== undefined ? { param: source.param } : {})
  };
  if (!res.headersSent) {
    res.removeHeader('Content-Type');
    return res.status(status).json({ error });
  }
  const event = { type: 'response.failed', response: { id: responseId, object: 'response', status: 'failed', error } };
  res.write(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

module.exports = { sendGenerationFailure };
