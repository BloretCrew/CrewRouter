'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createRequestLifecycle } = require('../utils/request-lifecycle');

function testAbortEvents() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const lifecycle = createRequestLifecycle(req, res);

  assert.strictEqual(lifecycle.aborted, false);
  req.emit('aborted');
  assert.strictEqual(lifecycle.signal.aborted, true);
  const completedReq = new EventEmitter();
  completedReq.complete = true;
  const completedRes = new EventEmitter();
  completedRes.writableFinished = true;
  const completed = createRequestLifecycle(completedReq, completedRes);
  completedReq.emit('close');
  completedRes.emit('close');
  assert.strictEqual(completed.signal.aborted, false);
  completed.dispose();
  res.emit('close');
  lifecycle.dispose();
}

function testDisposeRemovesListeners() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const lifecycle = createRequestLifecycle(req, res);
  lifecycle.dispose();

  req.emit('aborted');
  req.emit('close');
  res.emit('close');
  assert.strictEqual(lifecycle.signal.aborted, false);
  lifecycle.dispose();
}

testAbortEvents();
testDisposeRemovesListeners();
console.log('request lifecycle tests passed');
