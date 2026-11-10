'use strict';

/**
 * Short-lived cache for Gemini thought signatures attached to function calls.
 *
 * Gemini 3+ requires `thoughtSignature` to be echoed back on the functionCall
 * part in multi-turn tool use. OpenAI Chat and Anthropic Messages have no
 * reliable place to carry it, so the gateway remembers it by tool-call id and
 * re-attaches it when the client sends the tool result back.
 *
 * This is not a substitute for a client that echoes the signature itself; it
 * only bridges the stateless conversion through CrewRouter.
 */

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

const store = new Map();

function prune(now = Date.now()) {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function keyFor(block) {
  if (!block) return '';
  if (block.id) return String(block.id);
  if (block.toolCallId) return String(block.toolCallId);
  if (block.name) return String(block.name);
  return '';
}

function remember(toolCallId, signature) {
  if (!toolCallId || !signature) return;
  prune();
  store.set(String(toolCallId), {
    signature: String(signature),
    expiresAt: Date.now() + TTL_MS
  });
}

function get(toolCallId) {
  if (!toolCallId) return undefined;
  const entry = store.get(String(toolCallId));
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(String(toolCallId));
    return undefined;
  }
  return entry.signature;
}

/** Remember signatures from decoded Gemini response/stream blocks. */
function rememberBlocks(blocks) {
  for (const block of blocks || []) {
    if (block?.type === 'tool_call' && block.signature) remember(keyFor(block), block.signature);
  }
}

/** Fill missing functionCall signatures in an IR request from the cache. */
function attachToRequest(ir) {
  for (const message of ir?.messages || []) {
    for (const block of message.blocks || []) {
      if (block?.type !== 'tool_call' || block.signature) continue;
      const signature = get(keyFor(block));
      if (signature) block.signature = signature;
    }
  }
  return ir;
}

function clear() {
  store.clear();
}

module.exports = { remember, get, rememberBlocks, attachToRequest, clear, TTL_MS, MAX_ENTRIES };
