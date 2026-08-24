'use strict';

/**
 * 事件上报：hook stdin JSON → 载荷构造、静默 POST、Grok 会话目录 watch。
 * 与 Python 版 cr-report.py 的解析/轮询语义逐条对齐。
 */

const fs = require('fs');
const path = require('path');
const { GROK_SESSIONS_DIR, STATE_PATH } = require('./config');
const { postJson } = require('./http');

// stdin JSON 的 hook_event_name -> 上报事件
const EVENT_MAP = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  PreToolUse: 'tool_use',
  PostToolUse: 'tool_use',
};

// detail 只保留这些键，控制上报体积（对齐 Python 版）
const HOOK_DETAIL_KEYS = ['hook_event_name', 'source', 'reason', 'tool_input', 'message'];

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 把 hook JSON 映射为上报载荷；无法判定事件类型时回落 session_start */
function buildHookPayload(harness, forcedEvent, detail) {
  const hen = String(detail.hook_event_name || detail.hookEventName || '');
  const event =
    forcedEvent ||
    EVENT_MAP[hen] ||
    ((detail.tool_name || detail.toolName) ? 'tool_use' : null) ||
    'session_start';
  const filteredDetail = {};
  for (const k of HOOK_DETAIL_KEYS) if (k in detail) filteredDetail[k] = detail[k];
  return {
    harness,
    event,
    session_id: detail.session_id || detail.sessionId || null,
    tool_name: detail.tool_name || detail.toolName || null,
    cwd: detail.cwd || process.cwd(),
    ts: nowSec(),
    detail: filteredDetail,
  };
}

/** 静默上报；3 秒超时；任何异常吞掉 */
async function postEvent(cred, payload) {
  try {
    await postJson(cred.url + '/api/client-events', payload, { token: cred.token });
  } catch (_) {}
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch (_) {}
}

/** 返回 { updates.jsonl 绝对路径: 文件大小 } */
function scanGrokFiles() {
  const out = {};
  try {
    if (!fs.statSync(GROK_SESSIONS_DIR).isDirectory()) return out;
  } catch (_) {
    return out;
  }
  const stack = [GROK_SESSIONS_DIR];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'updates.jsonl') {
        try { out[p] = fs.statSync(p).size; } catch (_) {}
      }
    }
  }
  return out;
}

/** 把一行 updates.jsonl 解析为 [event, tool_name] 或 null */
function parseUpdatesLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (_) {
    return null;
  }
  const t = obj.type || obj.update_type || '';
  if (t === 'agent_thought_chunk') return null; // 思维碎片太密，不产生事件
  if (t === 'tool_call') {
    const name = (obj.payload && obj.payload.name) || obj.name || 'tool';
    return ['tool_use', String(name).slice(0, 128)];
  }
  if (t === 'agent_message_chunk') return null;
  return null;
}

/**
 * 常驻 tail ~/.grok/sessions/**\/updates.jsonl：
 * 新会话目录 -> session_start，tool_call 行 -> tool_use；
 * 增量偏移存 STATE_PATH，半行保护与 Python 版一致。永不返回。
 */
async function cmdWatch({ harness = 'grok', interval = 5 }, getCredential) {
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const sleepMs = Math.max(Number(interval) || 5, 2) * 1000;
  let cred = await getCredential();
  if (!cred) return 0;

  const state = loadState(); // path -> 已读取的字节偏移
  let known = new Set(Object.keys(state));
  for (;;) {
    try {
      cred = await getCredential(); // 长驻进程每轮重取：临期自动刷新、掉线自愈
      if (!cred) {
        known = new Set(Object.keys(scanGrokFiles()));
        saveState(state);
      } else {
        const files = scanGrokFiles();
        for (const p of Object.keys(files)) {
          const dir = path.dirname(p);
          if (!known.has(p)) {
            await postEvent(cred, {
              harness,
              event: 'session_start',
              session_id: path.basename(dir).slice(0, 128),
              cwd: dir,
              ts: nowSec(),
            });
          }
          const offset = Number(state[p]) || 0;
          const size = files[p];
          if (size > offset) {
            try {
              const fd = fs.openSync(p, 'r');
              const buf = Buffer.alloc(size - offset);
              fs.readSync(fd, buf, 0, buf.length, offset);
              fs.closeSync(fd);
              const text = buf.toString('utf8');
              let lines = text.split('\n').filter((l) => l.trim());
              if (!text.endsWith('\n')) {
                // 半行保护：末尾不是完整行则回退偏移，下次再读
                const keep = lines.length
                  ? Buffer.byteLength(lines[lines.length - 1], 'utf8')
                  : 0;
                state[p] = size > keep ? size - keep - 1 : offset;
                lines = lines.slice(0, -1);
              } else {
                state[p] = size;
              }
              for (const ln of lines) {
                const parsed = parseUpdatesLine(ln);
                if (!parsed) continue;
                await postEvent(cred, {
                  harness,
                  event: parsed[0],
                  session_id: path.basename(dir).slice(0, 128),
                  tool_name: parsed[1],
                  ts: nowSec(),
                });
              }
            } catch (_) {}
          }
        }
        known = new Set(Object.keys(files));
        saveState(state);
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

module.exports = {
  EVENT_MAP,
  buildHookPayload,
  postEvent,
  loadState,
  saveState,
  scanGrokFiles,
  parseUpdatesLine,
  cmdWatch,
};
