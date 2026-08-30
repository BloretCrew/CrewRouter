#!/usr/bin/env python3
"""Install or remove CrewRouter's global Grok lifecycle hook."""
import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path

HOOK_EVENTS = (
    "SessionStart", "SessionEnd", "PreToolUse", "PostToolUse",
    "PostToolUseFailure", "PermissionDenied", "Stop", "StopFailure",
    "Notification", "SubagentStart", "SubagentStop", "PreCompact",
    "PostCompact",
)
HOOK_FILE_NAME = "crewrouter-helper.json"


def grok_home():
    return Path(os.environ.get("GROK_HOME") or (Path.home() / ".grok")).expanduser()


def find_report(explicit=None):
    candidates = [explicit] if explicit else []
    candidates.extend([
        shutil.which("cr-report.py"),
        str(Path.home() / ".local/bin/cr-report.py"),
        "/usr/local/bin/cr-report.py",
    ])
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return str(Path(candidate).resolve())
    return None


def hook_config(report_path):
    command = f"{report_path} hook --harness grok"
    return {"hooks": {
        event: [{"hooks": [{"type": "command", "command": command, "timeout": 5}]}]
        for event in HOOK_EVENTS
    }}


def install(report_path=None):
    report = find_report(report_path)
    if not report:
        raise SystemExit("找不到可执行的 cr-report.py，请用 --cr-report 指定路径")
    directory = grok_home() / "hooks"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / HOOK_FILE_NAME
    data = json.dumps(hook_config(report), ensure_ascii=False, indent=2) + "\n"
    fd, temporary = tempfile.mkstemp(prefix=f".{HOOK_FILE_NAME}.", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(data)
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f"已安装 {target}（{report}）")


def uninstall():
    target = grok_home() / "hooks" / HOOK_FILE_NAME
    try:
        target.unlink()
        print(f"已卸载 {target}")
    except FileNotFoundError:
        print(f"未找到 {target}，无需卸载")


def main():
    parser = argparse.ArgumentParser(description="安装/卸载 CrewRouter 的 Grok 全局 Hooks")
    actions = parser.add_subparsers(dest="action", required=True)
    add = actions.add_parser("install", help="安装或更新 Hook")
    add.add_argument("--cr-report", help="cr-report.py 的可执行绝对路径")
    actions.add_parser("uninstall", help="只删除 CrewRouter 自己的 Hook 文件")
    args = parser.parse_args()
    if args.action == "install":
        install(args.cr_report)
    else:
        uninstall()


if __name__ == "__main__":
    main()
