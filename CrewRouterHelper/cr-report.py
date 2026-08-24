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
    OAuth 凭证（推荐）：{ "url": "...", "access_token": "...", "refresh_token": "...",
                          "expires_at": 1234567890.0 }
    旧版静态 Key（仍兼容）：{ "url": "http://127.0.0.1:20003", "key": "cr-sk-..." }

登录与登出：
       cr-report.py login --url http://127.0.0.1:20003   （浏览器 PKCE 授权）
       cr-report.py logout                               （删除本地凭证）

铁律：任何失败都静默退出 0，绝不阻塞客户端工具执行。
"""

import argparse
import base64
import hashlib
import json
import os
import secrets
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

try:
    import fcntl  # POSIX 文件锁，防多 hook 并发刷新踩踏轮换链
except ImportError:  # pragma: no cover
    fcntl = None

try:
    import http.server
    import threading
    import webbrowser
except ImportError:  # pragma: no cover
    http.server = None
    webbrowser = None

CONFIG_PATH = os.environ.get(
    "CR_REPORT_CONFIG", os.path.expanduser("~/.config/cr-report.json")
)
GROK_SESSIONS_DIR = os.path.expanduser("~/.grok/sessions")
STATE_PATH = os.path.expanduser("~/.cache/cr-report-grok-state.json")
# 刷新必须串行的锁文件：并发 hook 同时刷会导致旧 refresh 重放被服务端全链吊销
TOKEN_LOCK_PATH = os.path.expanduser("~/.cache/cr-report-token.lock")

OAUTH_CLIENT_ID = "crewrouter-helper"
OAUTH_SCOPE = "events:report"
REFRESH_AHEAD_SEC = 60  # 过期前 60s 触发自动刷新

# stdin JSON 的 hook_event_name -> 上报事件
EVENT_MAP = {
    "SessionStart": "session_start",
    "SessionEnd": "session_end",
    "PreToolUse": "tool_use",
    "PostToolUse": "tool_use",
}


def _load_cfg():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else None
    except Exception:
        return None


def _save_cfg(cfg):
    """写回配置并收紧权限为 600（含长期 refresh_token，不能组/其他人可读）"""
    d = os.path.dirname(CONFIG_PATH)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG_PATH)


def _token_request(url, form):
    """POST /oauth/token；成功返回 dict，失败返回 None（静默）"""
    if not url:
        return None
    data = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(
        url + "/oauth/token", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _refresh_access(url, refresh_token, client_id):
    """用 refresh_token 换新对；返回 {access_token,refresh_token,expires_at} 或 None"""
    out = _token_request(url, {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    })
    if not out or not out.get("access_token") or not out.get("refresh_token"):
        return None
    return {
        "access_token": str(out["access_token"]),
        "refresh_token": str(out["refresh_token"]),
        "expires_at": time.time() + float(out.get("expires_in", 86400)),
    }


def oauth_access_token(cfg):
    """取有效 OAuth access token；临期自动刷新。

    刷新必须持 ~/.cache/cr-report-token.lock 独占锁：
    服务端对旧 refresh 的第二次使用按重放处理并吊销整条链，
    多 hook 并发无锁刷新会互踩导致全员掉线。
    """
    now = time.time()
    try:
        exp = float(cfg.get("expires_at") or 0)
    except (TypeError, ValueError):
        exp = 0
    if cfg.get("access_token") and exp > now + REFRESH_AHEAD_SEC:
        return str(cfg["access_token"])
    if not cfg.get("refresh_token"):
        return None

    url = str(cfg.get("url") or "").rstrip("/")
    client_id = str(cfg.get("client_id") or OAUTH_CLIENT_ID)
    lock_dir = os.path.dirname(TOKEN_LOCK_PATH)
    if lock_dir:
        try:
            os.makedirs(lock_dir, exist_ok=True)
        except Exception:
            pass
    with open(TOKEN_LOCK_PATH, "a+") as lockf:
        if fcntl is not None:
            try:
                fcntl.flock(lockf.fileno(), fcntl.LOCK_EX)
            except Exception:
                pass
        # 拿到锁后重读配置：可能已被其他并发进程刷新过
        fresh = _load_cfg() or {}
        try:
            fresh_exp = float(fresh.get("expires_at") or 0)
        except (TypeError, ValueError):
            fresh_exp = 0
        if (fresh.get("access_token") and fresh_exp > time.time() + REFRESH_AHEAD_SEC
                and fresh.get("refresh_token")):
            return str(fresh["access_token"])
        current_rt = str(fresh.get("refresh_token") or cfg["refresh_token"])
        new_pair = _refresh_access(url, current_rt, client_id)
        if not new_pair:
            return None
        merged = dict(cfg)
        merged.update(new_pair)
        merged.setdefault("client_id", client_id)
        try:
            _save_cfg(merged)
        except Exception:
            pass
        return new_pair["access_token"]


def get_credential():
    """返回 (url, bearer_token)。优先 OAuth access，回落旧 key 字段。"""
    cfg = _load_cfg()
    if not cfg:
        return None, None
    url = str(cfg.get("url") or "").rstrip("/")
    token = None
    if cfg.get("refresh_token"):
        token = oauth_access_token(cfg)
    if not token and cfg.get("key"):
        token = str(cfg["key"])
    if not token:
        return None, None
    return url, token


def load_config():
    """兼容保留：返回 (url, key_or_oauth_token)"""
    return get_credential()


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
            url, key = get_credential()  # 长驻进程每轮重取：临期自动刷新、掉线自愈
            if not url or not key:
                known_sessions = set(scan_grok_files().keys())
                _save_state(state)
                time.sleep(max(args.interval, 2))
                continue
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


def cmd_login(args):
    """浏览器 PKCE 授权：本机随机端口收回调 -> 换 token -> 写配置（chmod 600）"""
    if http.server is None or webbrowser is None:
        print("[cr-report] 当前 Python 缺少 http.server/webbrowser，无法浏览器授权", file=sys.stderr)
        return 1
    url = str(args.url or "").rstrip("/")
    if not url:
        print("[cr-report] 需要 --url，例如：cr-report.py login --url http://127.0.0.1:20003",
              file=sys.stderr)
        return 1

    # PKCE S256：verifier 仅存内存，challenge 进授权链接
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()
    ).rstrip(b"=").decode("ascii")
    state = secrets.token_urlsafe(16)

    result = {}
    done = threading.Event()

    class Callback(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(u.query)
            result["code"] = (params.get("code") or [""])[0]
            result["state"] = (params.get("state") or [""])[0]
            result["error"] = (params.get("error") or [""])[0]
            ok = bool(result["code"]) and result["state"] == state
            body = (
                "<meta charset='utf-8'><body style=\"font-family:system-ui;"
                "display:flex;align-items:center;justify-content:center;min-height:80vh;\">"
                + ("登录成功，请回到终端。" if ok else "授权失败，请回终端重试。")
                + "</body>"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            done.set()

        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Callback)
    port = server.server_address[1]
    redirect_uri = f"http://127.0.0.1:{port}/callback"
    auth_url = url + "/oauth/authorize?" + urllib.parse.urlencode({
        "client_id": OAUTH_CLIENT_ID,
        "response_type": "code",
        "scope": OAUTH_SCOPE,
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    print(f"[cr-report] 正在打开浏览器进行授权（本机回调端口 {port}）...")
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass
    if os.environ.get("CR_REPORT_NO_BROWSER") != "1":
        print(f"[cr-report] 若浏览器未自动打开，请手动访问：\n{auth_url}")
    else:
        print(auth_url)

    deadline = time.time() + 300
    server.timeout = 1
    while not done.is_set() and time.time() < deadline:
        server.handle_request()
    server.server_close()

    if not done.is_set():
        print("[cr-report] 等待授权超时（5 分钟）", file=sys.stderr)
        return 1
    if result.get("error") or not result.get("code"):
        print(f"[cr-report] 授权被拒绝或失败：{result.get('error') or '缺少 code'}", file=sys.stderr)
        return 1
    if result.get("state") != state:
        print("[cr-report] state 校验失败，放弃换取 token", file=sys.stderr)
        return 1

    out = _token_request(url, {
        "grant_type": "authorization_code",
        "code": result["code"],
        "client_id": OAUTH_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    })
    if not out or not out.get("access_token") or not out.get("refresh_token"):
        print("[cr-report] 授权码换取 token 失败", file=sys.stderr)
        return 1

    _save_cfg({
        "url": url,
        "client_id": OAUTH_CLIENT_ID,
        "access_token": str(out["access_token"]),
        "refresh_token": str(out["refresh_token"]),
        "expires_at": time.time() + float(out.get("expires_in", 86400)),
        "scope": str(out.get("scope") or OAUTH_SCOPE),
    })
    print(f"[cr-report] 登录成功，凭证已写入 {CONFIG_PATH}（权限 600）")
    return 0


def cmd_logout(args):
    """登出：删除本地凭证文件"""
    try:
        if os.path.exists(CONFIG_PATH):
            os.remove(CONFIG_PATH)
            print(f"[cr-report] 已删除 {CONFIG_PATH}")
        else:
            print(f"[cr-report] 未找到本地凭证（{CONFIG_PATH}）")
    except Exception as e:
        print(f"[cr-report] 删除配置失败：{e}", file=sys.stderr)
        return 1
    return 0


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

    p_login = sub.add_parser("login", help="浏览器 OAuth 授权并写入本地凭证")
    p_login.add_argument("--url", default=os.environ.get("CR_ROUTER_URL"),
                         help="CrewRouter 地址，如 http://127.0.0.1:20003")
    p_login.set_defaults(fn=cmd_login)

    p_logout = sub.add_parser("logout", help="删除本地 OAuth 凭证文件")
    p_logout.set_defaults(fn=cmd_logout)

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
