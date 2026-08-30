#!/usr/bin/env python3
import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).parent

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

report = load("cr-report")
installer = load("install-grok-hooks")

cases = {
    "SessionStart": "session_start", "SessionEnd": "session_end",
    "PreToolUse": "tool_use", "PostToolUse": "tool_use",
    "PostToolUseFailure": "tool_use_failure", "PermissionDenied": "permission_denied",
    "Stop": "response_stop", "StopFailure": "response_stop_failure",
    "Notification": "notification", "SubagentStart": "subagent_start",
    "SubagentStop": "subagent_stop", "PreCompact": "pre_compact", "PostCompact": "post_compact",
}
for name, expected in cases.items():
    assert report.map_hook_event({"hookEventName": name}) == expected
    assert report.map_hook_event({"hook_event_name": name.lower()}) == expected
assert report.map_hook_event({"hookEventName": "Unknown"}) is None
assert report.map_hook_event({}, "tool_use") == "tool_use"
assert report.map_hook_event({}, "session_start") == "session_start"
assert report.map_hook_event({}, "unknown") is None
safe = report._safe_detail({"toolInput": {"command": "secret", "token": "x"}, "sessionId": "s"})
assert "tool_input" not in safe and safe["tool_input_keys"] == ["command", "token"]

with tempfile.TemporaryDirectory() as home:
    os.environ["HOME"] = home
    os.environ["GROK_HOME"] = str(Path(home) / ".grok")
    report_path = Path(home) / "cr-report.py"
    report_path.write_text("#!/bin/sh\n", encoding="utf-8")
    report_path.chmod(0o700)
    installer.install(str(report_path))
    target = Path(home) / ".grok/hooks/crewrouter-helper.json"
    first = target.read_bytes()
    installer.install(str(report_path))
    assert target.read_bytes() == first
    assert len(json.loads(target.read_text())["hooks"]) == len(installer.HOOK_EVENTS)
    installer.uninstall()
    assert not target.exists()
print("All Grok hook assertions passed.")
