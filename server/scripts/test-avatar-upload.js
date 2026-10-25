'use strict';

// Offline regression checks: multipart streams and injected HTTPS/DB stand-ins only.
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay, setImmediate: tick } = require('node:timers/promises');
const { readAvatarUpload, uploadAvatarImage, createAvatarUploadHandler } = require('../utils/avatar-upload');

const image = { data: Buffer.from('avatar-bytes'), filename: 'avatar.png', mimetype: 'image/png' };
const result = { success: true, data: { url: '/img/avatar.png' } };
const validated = () => ({
  ok: true,
  url: new URL('https://img.bloret.net/api/upload'),
  addresses: [{ address: '93.184.216.34', family: 4 }],
});

function multipartRequest(parts) {
  const boundary = 'test-avatar-boundary';
  const pieces = [];
  for (const part of parts) {
    pieces.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="'
      + (part.name || 'image') + '"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n'));
    pieces.push(part.data || image.data, Buffer.from('\r\n'));
  }
  pieces.push(Buffer.from('--' + boundary + '--\r\n'));
  const body = Buffer.concat(pieces);
  const req = new PassThrough();
  req.headers = { 'content-type': 'multipart/form-data; boundary=' + boundary, 'content-length': String(body.length) };
  return { req, body };
}

async function tempFixture(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-avatar-test-'));
  try { await fn(tempRoot); } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
}

test('successful multipart read removes its private temporary directory', async () => tempFixture(async tempRoot => {
  const { req, body } = multipartRequest([{}]);
  const pending = readAvatarUpload(req, { tempRoot });
  req.end(body);
  const parsed = await pending;
  assert.deepEqual(parsed.data, image.data);
  assert.equal(parsed.mimetype, 'image/png');
  assert.deepEqual(await fs.readdir(tempRoot), []);
}));

test('missing image, multiple files and oversize image leave no temporary files', async t => {
  for (const [name, parts, status] of [
    ['wrong field', [{ name: 'other' }], 400],
    ['multiple files', [{}, {}], 413],
    ['oversize image', [{ data: Buffer.alloc(5 * 1024 * 1024 + 1) }], 413],
  ]) {
    await t.test(name, async () => tempFixture(async tempRoot => {
      const { req, body } = multipartRequest(parts);
      const pending = readAvatarUpload(req, { tempRoot });
      req.end(body);
      await assert.rejects(pending, error => error.status === status);
      await tick();
      assert.deepEqual(await fs.readdir(tempRoot), []);
    }));
  }
});

test('partial upload abort removes already-created files and keeps them private', async () => tempFixture(async tempRoot => {
  const { req, body } = multipartRequest([{}]);
  const controller = new AbortController();
  // IncomingMessage emits aborted when destroyed before its request body ends.
  const destroy = req.destroy;
  req.destroy = function (error) {
    if (!this.destroyed && !this.readableEnded) this.emit('aborted');
    return destroy.call(this, error);
  };
  const pending = readAvatarUpload(req, { tempRoot, signal: controller.signal });
  req.write(body.subarray(0, body.length - 40));
  let directory;
  for (let i = 0; i < 100; i += 1) {
    const dirs = await fs.readdir(tempRoot);
    if (dirs.length && (await fs.readdir(path.join(tempRoot, dirs[0]))).length) {
      directory = path.join(tempRoot, dirs[0]);
      break;
    }
    await delay(5);
  }
  assert(directory, 'partial upload should create a file before cancellation');
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  controller.abort(new Error('cancelled by caller'));
  await assert.rejects(pending, /cancelled by caller/);
  assert(req.destroyed);
  assert.deepEqual(await fs.readdir(tempRoot), []);
}));

test('parser deadline terminates a stalled request and cleans its directory', async () => tempFixture(async tempRoot => {
  const { req } = multipartRequest([{}]);
  const pending = readAvatarUpload(req, { tempRoot, timeoutMs: 30 });
  await assert.rejects(pending, error => error.status === 504);
  assert(req.destroyed);
  assert.deepEqual(await fs.readdir(tempRoot), []);
}));

test('whole multipart limit also covers headers for declared and chunked requests', async t => {
  for (const chunked of [false, true]) {
    await t.test(chunked ? 'chunked oversized header' : 'declared oversized header', async () => tempFixture(async tempRoot => {
      const req = new PassThrough();
      const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="image"; filename="'
        + 'a'.repeat(5 * 1024 * 1024 + 32 * 1024) + '"\r\nContent-Type: image/png\r\n\r\nx\r\n--b--\r\n');
      req.headers = {
        'content-type': 'multipart/form-data; boundary=b',
        ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(body.length) }),
      };
      const pending = readAvatarUpload(req, { tempRoot });
      if (chunked) {
        for (let offset = 0; offset < body.length; offset += 65536) req.write(body.subarray(offset, offset + 65536));
        req.end();
      }
      await assert.rejects(pending, error => error.status === 413);
      assert.deepEqual(await fs.readdir(tempRoot), []);
      req.destroy();
    }));
  }
});

function transportFixture(behavior, overrides = {}) {
  const state = { requests: [], agentDestroys: 0, validateCalls: 0 };
  const agent = {};
  const options = {
    validateTarget: async url => { state.validateCalls += 1; assert.equal(url, 'https://img.bloret.net/api/upload'); return validated(); },
    createAgents: check => {
      assert.equal(check.url.origin, 'https://img.bloret.net');
      return { httpsAgent: agent, destroy() { state.agentDestroys += 1; } };
    },
    request(url, opts, callback) {
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = () => { req.destroyed = true; };
      req.end = body => {
        state.requests.push({ url: url.toString(), opts, body });
        queueMicrotask(() => {
          const response = new PassThrough();
          response.headers = {};
          response.statusCode = 200;
          state.response = response;
          state.request = req;
          behavior({ response, req, callback });
        });
      };
      assert.equal(opts.agent, agent);
      return req;
    },
    ...overrides,
  };
  return { state, options };
}

function replyFixture(value = result) {
  return transportFixture(({ response, callback }) => {
    callback(response);
    response.end(JSON.stringify(value));
  });
}

test('HTTPS upload pins agents, encodes multipart safely and accepts same-origin result', async () => {
  const { state, options } = replyFixture();
  const url = await uploadAvatarImage({
    ...image,
    filename: 'avatar"\r\nInjected: value\u0000.png',
    mimetype: 'image/png\r\nInjected: value',
  }, options);
  assert.equal(url, 'https://img.bloret.net/img/avatar.png');
  assert.equal(state.agentDestroys, 1);
  assert.equal(state.requests.length, 1);
  const request = state.requests[0];
  assert.equal(request.url, 'https://img.bloret.net/api/upload');
  assert.equal(request.opts.method, 'POST');
  assert.equal(request.opts.headers['Content-Length'], request.body.length);
  const wire = request.body.toString();
  assert(!wire.includes('\r\nInjected:'));
  assert(!wire.includes('\u0000'));
  assert(wire.includes('Content-Type: application/octet-stream\r\n'));
  assert.match(request.opts.headers['Content-Type'], /boundary=----FormBoundary[0-9a-f]{32}$/);
});

test('upstream redirects are rejected without making a second request', async () => {
  const { state, options } = transportFixture(({ response, callback }) => {
    response.statusCode = 302;
    response.headers.location = 'http://127.0.0.1/private';
    callback(response);
  });
  await assert.rejects(uploadAvatarImage(image, options), /HTTP 302/);
  assert.equal(state.requests.length, 1);
  assert(state.request.destroyed && state.response.destroyed);
  assert.equal(state.agentDestroys, 1);
});

test('response limit rejects both declared and streamed oversized bodies', async t => {
  for (const declared of [false, true]) {
    await t.test(declared ? 'declared size' : 'streamed size', async () => {
      const { state, options } = transportFixture(({ response, callback }) => {
        if (declared) response.headers['content-length'] = String(64 * 1024 + 1);
        callback(response);
        if (!declared) response.end(Buffer.alloc(64 * 1024 + 1));
      });
      await assert.rejects(uploadAvatarImage(image, options), /64 KiB/);
      assert(state.request.destroyed && state.response.destroyed);
      assert.equal(state.agentDestroys, 1);
    });
  }
});

test('truncated and invalid JSON responses fail promptly and release agents', async t => {
  for (const truncated of [false, true]) {
    await t.test(truncated ? 'truncated stream' : 'invalid JSON', async () => {
      const { state, options } = transportFixture(({ response, callback }) => {
        callback(response);
        response.write('{"success":');
        if (truncated) response.destroy();
        else response.end();
      });
      await assert.rejects(uploadAvatarImage(image, options), /响应中断|有效 JSON/);
      assert.equal(state.agentDestroys, 1);
    });
  }
});

test('result schema and origin must be valid before an avatar URL is accepted', async t => {
  for (const value of [
    null,
    { success: 'true', data: { url: '/img/avatar.png' } },
    { success: true, data: { url: { pathname: '/img/avatar.png' } } },
    ...['', 'https://evil.test/img.png', '//evil.test/img.png', 'http://img.bloret.net/img.png',
      'https://user@img.bloret.net/img.png', '/img/avatar.png#fragment'].map(url => ({ success: true, data: { url } })),
  ]) {
    await t.test(JSON.stringify(value), async () => {
      const { state, options } = replyFixture(value);
      await assert.rejects(uploadAvatarImage(image, options), /头像地址/);
      assert.equal(state.agentDestroys, 1);
    });
  }
});

test('DNS validation is included in total deadline and late DNS completion cannot send', async () => {
  let resolveDns;
  const { state, options } = replyFixture();
  options.timeoutMs = 20;
  options.validateTarget = () => new Promise(resolve => { resolveDns = resolve; });
  await assert.rejects(uploadAvatarImage(image, options), error => error.status === 504);
  assert.equal(state.requests.length, 0);
  resolveDns(validated());
  await tick();
  assert.equal(state.requests.length, 0);
  assert.equal(state.agentDestroys, 0);
});

test('rejected DNS validation cannot create an agent or send a request', async () => {
  const { state, options } = replyFixture();
  options.validateTarget = async () => ({ ok: false, error: 'private destination' });
  await assert.rejects(uploadAvatarImage(image, options), /安全校验失败/);
  assert.equal(state.requests.length, 0);
  assert.equal(state.agentDestroys, 0);
});

test('response trickle cannot extend total deadline', async () => {
  let interval;
  const { state, options } = transportFixture(({ response, callback }) => {
    callback(response);
    interval = setInterval(() => response.write(' '), 2);
  }, { timeoutMs: 30 });
  try {
    await assert.rejects(uploadAvatarImage(image, options), error => error.status === 504);
    assert(state.request.destroyed && state.response.destroyed);
    assert.equal(state.agentDestroys, 1);
  } finally {
    clearInterval(interval);
  }
});

test('caller cancellation destroys an in-flight request', async () => {
  const controller = new AbortController();
  const { state, options } = transportFixture(({ response, callback }) => {
    callback(response);
    controller.abort(new Error('client disconnected'));
  }, { signal: controller.signal });
  await assert.rejects(uploadAvatarImage(image, options), /client disconnected/);
  assert(state.request.destroyed && state.response.destroyed);
  assert.equal(state.agentDestroys, 1);
});

function handlerFixture(query, overrides = {}) {
  const req = new EventEmitter();
  req.session = { user: { id: 7, avatar: 'old-avatar' } };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.writableEnded = true; };
  const handler = createAvatarUploadHandler({
    pool: { query },
    logger: { error() {} },
    readImage: async () => image,
    uploadImage: async () => 'https://img.bloret.net/img/avatar.png',
    ...overrides,
  });
  return { req, res, handler };
}

test('database failure or missing user must not return success or mutate session', async t => {
  for (const missing of [false, true]) {
    await t.test(missing ? 'missing user' : 'database error', async () => {
      const { req, res, handler } = handlerFixture(async () => {
        if (missing) return { rowCount: 0 };
        throw new Error('database unavailable');
      });
      await handler(req, res);
      assert.equal(res.statusCode, missing ? 401 : 500);
      assert.equal(req.session.user.avatar, 'old-avatar');
      assert.notEqual(res.body.success, true);
    });
  }
});

test('only a successful database write updates the session and response', async () => {
  const { req, res, handler } = handlerFixture(async (sql, values) => {
    assert(sql.endsWith('RETURNING id'));
    assert.deepEqual(values, [7, 'https://img.bloret.net/img/avatar.png']);
    assert.equal(req.session.user.avatar, 'old-avatar');
    return { rowCount: 1 };
  });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(req.session.user.avatar, res.body.url);
  assert.equal(res.body.success, true);
});

test('client disconnect during upload cancels forwarding before any database mutation', async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const { req, res, handler } = handlerFixture(async () => assert.fail('unexpected database write'), {
    uploadImage: async (_, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started();
    }),
  });
  const pending = handler(req, res);
  await entered;
  res.destroyed = true;
  res.emit('close');
  await pending;
  assert.equal(res.body, undefined);
  assert.equal(req.session.user.avatar, 'old-avatar');
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
});
