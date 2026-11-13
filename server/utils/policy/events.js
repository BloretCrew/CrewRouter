'use strict';

const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

function emitPolicyEvent(event) {
  try {
    emitter.emit('policy', event);
  } catch (_) { /* ignore */ }
}

function subscribe(listener) {
  emitter.on('policy', listener);
  return () => emitter.off('policy', listener);
}

function subscriberCount() {
  return emitter.listenerCount('policy');
}

module.exports = { emitPolicyEvent, subscribe, subscriberCount };
