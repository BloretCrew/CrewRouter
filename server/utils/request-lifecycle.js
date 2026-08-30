'use strict';

function combineAbortSignals(...signals) {
  const valid = signals.filter(Boolean);
  if (valid.length < 2) return valid[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid);
  const controller = new AbortController();
  const abort = () => controller.abort();
  valid.forEach(signal => {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  return controller.signal;
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

module.exports = { createRequestLifecycle, combineAbortSignals };
