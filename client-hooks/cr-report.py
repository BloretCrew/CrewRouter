#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cr-report —— CrewRouter 客户端事件统一上报器

所有 AI 客户端共用这一个程序，四种用法：

  1) hook 模式（Claude Code / Qwen Code / Codex 原生 hooks）：
       读 stdin 的 Claude 风格 hook JSON，映射后上报
       cr-report.py hook --harness claude_code
  2) emit 模式（Hermes / OpenClaw 等可直接执行命令的环境）：
       cr-report.py emit --harness hermes --event session_start --session <id>
  3) watch 模式（Grok 等无 hook 的客户端）：
       常驻 tail ~/.grok/sessions/**/updates.jsonl，增量解析为事件
       cr-report.py watch --harness grok
  4) test：发一条假事件验证链路
       cr-report.py test

配置文件：~/.config/cr-report.json（或环境变量 CR_REPORT_CONFIG 指定路径）
    { "url": "http://127.0.0.1:20003", "key": "cr-sk-..." }

铁律：任何失败都静默退出 0，绝不阻塞客户端工具执行。
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

CONFIG_PATH = os.environ.get(
    "CR_REPORT_CONFIG", os.path.expanduser("~/.config/cr-report.json")
)
GROK_SESSIONS_DIR = os.path.expanduser("~/.grok/sessions")
STATE_PATH = os.path.expanduser("~/.cache/cr-report-grok-state.json")

# stdin JSON 的 hook_event_name -> 上报事件
EVENT_MAP = {
    "SessionStart": "session_start",
    "SessionEnd": "session_end",
    "PreToolUse": "tool_use",
    "PostToolUse": "tool_use",
}


def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        return str(cfg["url"]).rstrip("/"), str(cfg["key"])
    except Exception:
        return None, None


def post_event(cfg_url, cfg_key, payload):
    """静默上报；3 秒超时；任何异常吞掉。"""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        cfg_url + "/api/client-events",
        data=data,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + cfg_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3):
            pass
    except Exception:
        pass


def cmd_hook(args):
    url, key = load_config()
    raw = ""
    try:
        raw = sys.stdin.read()
    except Exception:
        pass
    detail = {}
    try:
        detail = json.loads(raw) if raw.strip() else {}
    except Exception:
        detail = {"raw": raw[:512]}

    event = args.event
    if not event:
        hen = detail.get("hook_event_name") or detail.get("hookEventName") or ""
        event = EVENT_MAP.get(hen)
    if not event:
        # 无法判定事件类型时按工具调用处理（hook 场景下最常见）
        event = "tool_use" if (detail.get("tool_name") or detail.get("toolName")) else None
    if args.event == "session_start" or (not event and args.event is None):
        event = event or "session_start"

    payload = {
        "harness": args.harness,
        "event": event or "session_start",
        "session_id": detail.get("session_id") or detail.get("sessionId"),
        "tool_name": detail.get("tool_name") or detail.get("toolName"),
        "cwd": detail.get("cwd") or os.getcwd(),
        "ts": int(time.time()),
        "detail": {k: v for k, v in detail.items()
                   if k in ("hook_event_name", "source", "reason",
                            "tool_input", "message")},
    }
    if url and key:
        post_event(url, key, payload)
    return 0


def cmd_emit(args):
    url, key = load_config()
    payload = {
        "harness": args.harness,
        "event": args.event,
        "session_id": args.session,
        "tool_name": args.tool,
        "cwd": args.cwd or os.getcwd(),
        "ts": int(time.time()),
    }
    if url and key:
        post_event(url, key, payload)
    return 0


def _load_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_state(state):
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except Exception:
        pass


def scan_grok_files():
    """返回 {updates.jsonl 绝对路径: 文件大小}"""
    out = {}
    if not os.path.isdir(GROK_SESSIONS_DIR):
        return out
    for root, _dirs, files in os.walk(GROK_SESSIONS_DIR):
        if "updates.jsonl" in files:
            p = os.path.join(root, "updates.jsonl")
            try:
                out[p] = os.path.getsize(p)
            except OSError:
                pass
    return out


def parse_updates_line(line):
    """把一行 updates.jsonl 解析为 (event, tool_name) 或 None"""
    try:
        obj = json.loads(line)
    except Exception:
        return None
    t = obj.get("type") or obj.get("update_type") or ""
    if t == "agent_thought_chunk":
        return None  # 思维碎片不产生事件，太密
    if t == "tool_call":
        name = ((obj.get("payload") or {}).get("name")
                or obj.get("name") or "tool")
        return ("tool_use", str(name)[:128])
    if t == "agent_message_chunk":
        return None
    return None


def cmd_watch(args):
    url, key = load_config()
    if not url or not key:
        return 0
    state = _load_state()          # path -> 已读取的字节偏移
    known_sessions = set(state.keys())
    while True:
        try:
            files = scan_grok_files()
            # 新出现的会话目录 -> session_start
            for path in files:
                if path not in known_sessions:
                    sid = os.path.basename(os.path.dirname(path))
                    post_event(url, key, {
                        "harness": args.harness, "event": "session_start",
                        "session_id": sid[:128], "cwd": os.path.dirname(path),
                        "ts": int(time.time())})
                offset = state.get(path, 0)
                size = files[path]
                if size > offset:
                    try:
                        with open(path, "rb") as f:
                            f.seek(offset)
                            chunk = f.read(size - offset)
                        text = chunk.decode("utf-8", errors="replace")
                        lines = [ln for ln in text.splitlines() if ln.strip()]
                        # 半行保护：若文件未以换行结尾则回退偏移
                        if not text.endswith("\n"):
                            keep = len(lines[-1].encode("utf-8")) if lines else 0
                            state[path] = size - keep - 1 if size > keep else offset
                            lines = lines[:-1]
                        else:
                            state[path] = size
                        for ln in lines:
                            parsed = parse_updates_line(ln)
                            if parsed:
                                ev, tool = parsed
                                sid = os.path.basename(os.path.dirname(path))
                                post_event(url, key, {
                                    "harness": args.harness, "event": ev,
                                    "session_id": sid[:128], "tool_name": tool,
                                    "ts": int(time.time())})
                    except OSError:
                        pass
            known_sessions = set(files.keys())
            _save_state(state)
        except Exception:
            pass
        time.sleep(max(args.interval, 2))
    return 0


def cmd_test(args):
    url, key = load_config()
    if not url or not key:
        print(f"[cr-report] 配置缺失：{CONFIG_PATH}", file=sys.stderr)
        return 1
    payload = {
        "harness": args.harness or "hermes",
        "event": "session_start",
        "session_id": f"cr-report-test-{int(time.time())}",
        "cwd": os.getcwd(),
        "ts": int(time.time()),
        "detail": {"source": "cr-report test"},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url + "/api/client-events", data=data,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + key},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            print(f"[cr-report] HTTP {resp.status} -> {resp.read().decode()}")
            return 0
    except Exception as e:
        print(f"[cr-report] 失败：{e}", file=sys.stderr)
        return 1


def main():
    ap = argparse.ArgumentParser(prog="cr-report")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_hook = sub.add_parser("hook", help="读 stdin hook JSON 并上报")
    p_hook.add_argument("--harness", required=True)
    p_hook.add_argument("--event", default=None,
                        help="强制指定事件；缺省从 stdin JSON 推断")
    p_hook.set_defaults(fn=cmd_hook)

    p_emit = sub.add_parser("emit", help="直接发一条事件")
    p_emit.add_argument("--harness", required=True)
    p_emit.add_argument("--event", required=True,
                        choices=["session_start", "session_end", "tool_use"])
    p_emit.add_argument("--session", default=None)
    p_emit.add_argument("--tool", default=None)
    p_emit.add_argument("--cwd", default=None)
    p_emit.set_defaults(fn=cmd_emit)

    p_watch = sub.add_parser("watch", help="常驻 tail Grok 会话目录")
    p_watch.add_argument("--harness", default="grok")
    p_watch.add_argument("--interval", type=int, default=5,
                         help="轮询秒数，默认 5")
    p_watch.set_defaults(fn=cmd_watch)

    p_test = sub.add_parser("test", help="发测试事件验证配置与链路")
    p_test.add_argument("--harness", default="hermes")
    p_test.set_defaults(fn=cmd_test)

    args = ap.parse_args()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # 兜底：绝不让上报器把宿主客户端搞挂
        sys.exit(0)
