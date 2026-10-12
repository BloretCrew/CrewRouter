'use strict';

const combinedSignalCleanup = new WeakMap();

function combineAbortSignals(...signals) {
  const valid = [...new Set(signals.filter(Boolean))];
  if (valid.length < 2) return valid[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid);
  const controller = new AbortController();
  const listeners = [];
  const cleanup = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.length = 0;
    combinedSignalCleanup.delete(controller.signal);
  };
  for (const signal of valid) {
    const abort = () => {
      controller.abort(signal.reason);
      cleanup();
    };
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
    listeners.push([signal, abort]);
  }
  if (!controller.signal.aborted) combinedSignalCleanup.set(controller.signal, cleanup);
  return controller.signal;
}

function releaseCombinedAbortSignal(signal) {
  combinedSignalCleanup.get(signal)?.();
}

function waitForResponseDrain(res, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => {
      const error = new Error('Response closed before drain');
      error.code = 'ERR_STREAM_PREMATURE_CLOSE';
      finish(error);
    };
    const onError = error => finish(error);
    const onAbort = () => {
      const error = new Error('The operation was aborted');
      error.name = signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
      error.code = error.name === 'TimeoutError' ? 'ETIMEDOUT' : 'ERR_CANCELED';
      finish(error);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (res.destroyed || res.writableEnded || res.writableFinished) onClose();
    else if (res.writableNeedDrain === false) onDrain();
  });
}

function createRequestLifecycle(req, res) {
  const controller = new AbortController();
  let disposed = false;
  const abort = () => {
    if (!disposed && !controller.signal.aborted) controller.abort();
  };
  const onRequestClose = () => {
    if (req?.aborted || !req?.complete) abort();
  };
  const onResponseClose = () => {
    if (!res?.writableFinished && !res?.writableEnded) abort();
  };

  req?.once?.('aborted', abort);
  req?.once?.('close', onRequestClose);
  res?.once?.('close', onResponseClose);
  res?.once?.('aborted', abort);

  return {
    signal: controller.signal,
    get aborted() {
      return controller.signal.aborted;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      req?.removeListener?.('aborted', abort);
      req?.removeListener?.('close', onRequestClose);
      res?.removeListener?.('close', onResponseClose);
      res?.removeListener?.('aborted', abort);
    }
  };
}

module.exports = { createRequestLifecycle, combineAbortSignals, releaseCombinedAbortSignal, waitForResponseDrain };
