#!/usr/bin/env python3
"""
OpenAI OAuth 登录脚本
在本地启动一个临时 HTTP 服务器，完成 OAuth 回调后将授权码发送到服务器。

用法:
    python openai_login.py --server URL --token TOKEN

示例:
    python openai_login.py --server http://100.64.0.7:3000 --token xxxx
"""

import argparse
import json
import sys
import threading
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs


class OAuthCallbackHandler(BaseHTTPRequestHandler):
    code = None
    state = None
    error = None
    error_description = None
    auth_complete = threading.Event()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        print(f"\n[回调] 收到请求: {self.path}")

        if parsed.path == "/auth/callback":
            if "code" in params:
                OAuthCallbackHandler.code = params["code"][0]
                OAuthCallbackHandler.state = params.get("state", [None])[0]
                print(f"[回调] 授权成功! state={OAuthCallbackHandler.state[:8]}...")
                self._respond(200, "授权成功！请返回终端查看结果。此窗口可以关闭了。")
            elif "error" in params:
                OAuthCallbackHandler.error = params["error"][0]
                OAuthCallbackHandler.error_description = params.get("error_description", [""])[0]
                print(f"[回调] 授权失败: {OAuthCallbackHandler.error} - {OAuthCallbackHandler.error_description}")
                self._respond(200, f"授权失败: {OAuthCallbackHandler.error_description or OAuthCallbackHandler.error}")
            else:
                print(f"[回调] 缺少授权参数")
                self._respond(400, "缺少授权参数")
            OAuthCallbackHandler.auth_complete.set()
        else:
            print(f"[回调] 未知路径: {parsed.path}")
            self._respond(404, "未找到")

    def _respond(self, code, message):
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OpenAI OAuth</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a1a;color:#fff;">
  <div style="text-align:center;">
    <h2>{message}</h2>
  </div>
</body>
</html>"""
        self.wfile.write(html.encode("utf-8"))

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description="OpenAI OAuth 登录")
    parser.add_argument("--server", required=True, help="Crant AI Studio 服务器地址")
    parser.add_argument("--token", required=True, help="一次性认证 token")
    args = parser.parse_args()

    server_base = args.server.rstrip("/")
    auth_token = args.token

    # 1. 启动本地临时 HTTP 服务器
    httpd = HTTPServer(("127.0.0.1", 0), OAuthCallbackHandler)
    local_port = httpd.server_address[1]
    print(f"[1/4] 本地服务器已启动: http://127.0.0.1:{local_port}")

    # 2. 向服务器请求 OAuth URL（使用 token 认证）
    login_url = f"{server_base}/api/admin/providers/openai/login-url?port={local_port}"
    print(f"[2/4] 正在请求服务器获取 OAuth 链接...")
    print(f"      请求: {login_url}")

    try:
        req = urllib.request.Request(login_url, headers={"X-Auth-Token": auth_token})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            err = json.loads(body)
            print(f"[错误] 服务器返回 {e.code}: {err.get('error', body)}")
        except json.JSONDecodeError:
            print(f"[错误] 服务器返回 {e.code}: {body}")
        httpd.server_close()
        sys.exit(1)
    except Exception as e:
        print(f"[错误] 无法连接服务器: {e}")
        httpd.server_close()
        sys.exit(1)

    oauth_url = data.get("url")
    token = data.get("token")
    if not oauth_url or not token:
        print(f"[错误] 服务器返回数据不完整: {data}")
        httpd.server_close()
        sys.exit(1)

    print(f"[2/4] 已获取 OAuth 链接")
    print(f"      URL: {oauth_url[:120]}...")

    # 3. 打开浏览器
    import webbrowser
    print(f"[3/4] 正在打开浏览器...")
    webbrowser.open(oauth_url)
    print(f"      如果浏览器没有自动打开，请手动复制上面的 URL 访问")

    # 4. 等待回调
    print(f"[4/4] 等待授权回调... (按 Ctrl+C 取消)")
    print(f"      监听地址: http://127.0.0.1:{local_port}/auth/callback")
    try:
        httpd.timeout = 300
        httpd.handle_request()
    except KeyboardInterrupt:
        print("\n已取消")
        httpd.server_close()
        sys.exit(0)

    if OAuthCallbackHandler.error:
        print(f"\n[失败] 授权失败: {OAuthCallbackHandler.error_description or OAuthCallbackHandler.error}")
        httpd.server_close()
        sys.exit(1)

    if not OAuthCallbackHandler.code:
        print("\n[失败] 未收到授权码")
        httpd.server_close()
        sys.exit(1)

    print(f"\n已收到授权码，正在提交到服务器...")

    # 5. 将授权码发送到服务器
    complete_url = f"{server_base}/api/admin/providers/openai/complete-login"
    payload = json.dumps({
        "code": OAuthCallbackHandler.code,
        "state": OAuthCallbackHandler.state,
        "token": token
    }).encode("utf-8")

    print(f"      请求: POST {complete_url}")

    try:
        req = urllib.request.Request(complete_url, data=payload, headers={
            "Content-Type": "application/json",
            "X-Auth-Token": auth_token
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if result.get("success"):
                print(f"\n[成功] OpenAI 登录完成！")
                print(f"       账户 ID: {result.get('accountId', 'N/A')}")
            else:
                print(f"\n[失败] 服务器返回: {result}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            err = json.loads(body)
            print(f"\n[失败] 服务器返回 {e.code}: {err.get('error', body)}")
        except json.JSONDecodeError:
            print(f"\n[失败] 服务器返回 {e.code}: {body}")
    except Exception as e:
        print(f"\n[失败] 提交授权码时出错: {e}")

    httpd.server_close()


if __name__ == "__main__":
    main()
