'use strict';

const express = require('express');
const zlib = require('zlib');
const { Transform } = require('stream');

const BODY_LIMIT = 50 * 1024 * 1024;

function isGatewayRequest(req) {
  return req.path.startsWith('/v1/')
    || /^\/api\/(chat|messages|responses|models)(\/|$)/.test(req.path);
}

function createGatewayBodyParser({ limit = BODY_LIMIT, createDecompress = zlib.createZstdDecompress } = {}) {
  const json = express.json({ limit });
  return (req, res, next) => {
    if (!isGatewayRequest(req)) return next();
    if (String(req.headers['content-encoding'] || '').toLowerCase() !== 'zstd') {
      return json(req, res, next);
    }
    if (typeof createDecompress !== 'function') {
      return next(Object.assign(new Error('Zstd requests require Node.js 22.15+ or 23.8+. Disable client request compression or upgrade Node.js.'), {
        status: 415, type: 'encoding.unsupported'
      }));
    }
    if (!req.is('application/json')) {
      return next(Object.assign(new Error('Zstd gateway requests must use application/json'), {
        status: 415, type: 'encoding.unsupported'
      }));
    }

    let compressedBytes = 0;
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        compressedBytes += chunk.length;
        if (compressedBytes > limit) {
          return callback(Object.assign(new Error('Request body too large'), { status: 413, type: 'entity.too.large' }));
        }
        callback(null, chunk);
      }
    });
    const decoded = createDecompress();
    // Reuse Express JSON validation and its decoded-byte limit without changing the original request headers.
    decoded.headers = { ...req.headers, 'content-encoding': 'identity', 'transfer-encoding': 'chunked' };
    delete decoded.headers['content-length'];
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      req.unpipe(counter);
      counter.unpipe(decoded);
      req.removeListener('aborted', aborted);
      req.removeListener('error', finish);
      counter.destroy();
      decoded.destroy();
      if (err) {
        req.resume();
        if (!err.status) {
          err.status = 400;
          err.type = 'entity.parse.failed';
        }
      } else {
        req.body = decoded.body;
        // Express 4's subsequent global parsers must not read the consumed socket again.
        req._body = true;
      }
      next(err);
    };
    const aborted = () => finish(Object.assign(new Error('Request aborted'), { status: 400, type: 'request.aborted' }));
    req.once('aborted', aborted);
    req.once('error', finish);
    counter.once('error', finish);
    decoded.once('error', finish);
    json(decoded, res, finish);
    if (!finished) req.pipe(counter).pipe(decoded);
  };
}

function gatewayBodyError(err, req, res, next) {
  if (!isGatewayRequest(req)) return next(err);
  const errors = {
    'entity.too.large': [413, 'request_too_large', 'Request body exceeds the 50MB limit'],
    'encoding.unsupported': [415, 'unsupported_content_encoding', err.message],
    'charset.unsupported': [415, 'unsupported_charset', err.message],
    'entity.parse.failed': [400, 'invalid_json', 'Invalid JSON or compressed request body'],
    'request.aborted': [400, 'request_aborted', 'Request aborted']
  };
  const error = errors[err.type];
  if (!error) return next(err);
  return res.status(error[0]).json({ error: { message: error[2], type: 'invalid_request_error', code: error[1] } });
}

module.exports = { createGatewayBodyParser, gatewayBodyError };
