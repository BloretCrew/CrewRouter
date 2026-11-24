import { CrewRouterAbortError, CrewRouterTimeoutError } from './errors.js';
import type { StreamEvent } from './types.js';

function tryParse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) return Promise.reject(new CrewRouterAbortError());

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => finish(() => {
      reader.cancel().catch(() => {});
      reject(new CrewRouterAbortError('Request aborted', { cause: signal?.reason }));
    });

    if (idleTimeoutMs && idleTimeoutMs > 0) {
      timer = setTimeout(() => finish(() => {
        reader.cancel().catch(() => {});
        reject(new CrewRouterTimeoutError(`Stream idle timeout after ${idleTimeoutMs}ms`));
      }), idleTimeoutMs);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * Parse a Server-Sent Events stream into structured events.
 *
 * Handles CRLF, multi-line data, comments, event: fields and the OpenAI
 * [DONE] sentinel. The parser is deliberately protocol-agnostic; callers
 * interpret `event` / `parsed` according to OpenAI, Anthropic or Responses
 * semantics.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal; idleTimeoutMs?: number } = {},
): AsyncGenerator<StreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | null = null;
  let dataLines: string[] = [];
  let terminated = false;

  try {
    while (!terminated) {
      const result = await readWithTimeout(reader, options.idleTimeoutMs, options.signal);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          if (dataLines.length > 0) {
            const data = dataLines.join('\n');
            const event: StreamEvent = {
              event: eventName,
              data,
              parsed: tryParse(data),
              done: data === '[DONE]',
            };
            eventName = null;
            dataLines = [];
            yield event;
            if (event.done) {
              terminated = true;
              break;
            }
          } else {
            eventName = null;
          }
          continue;
        }

        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventName = value;
        else if (field === 'data') dataLines.push(value);
      }
    }

    if (!terminated && dataLines.length > 0) {
      const data = dataLines.join('\n');
      yield {
        event: eventName,
        data,
        parsed: tryParse(data),
        done: data === '[DONE]',
      };
    }
  } finally {
    if (!terminated) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
