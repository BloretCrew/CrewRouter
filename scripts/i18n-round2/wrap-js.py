#!/usr/bin/env python3
"""Round-2: wrap Chinese strings in ANY public/js file with t() — site-wide i18n.

Usage: python3 wrap-js.py <relative-path-to-js> [...]
Same line-scoped, syntax-verified pattern as scripts/wrap-app-js.py.
New keys appended to lang/zh.json (key=value) and lang/en.json (placeholder).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
ZH_PATH = ROOT / "lang" / "zh.json"
EN_PATH = ROOT / "lang" / "en.json"
ZH = json.loads(ZH_PATH.read_text(encoding="utf-8"))
EN = json.loads(EN_PATH.read_text(encoding="utf-8"))
CJK = re.compile(r"[\u4e00-\u9fff]")

STR_RE = re.compile(r"""(['"])((?:\\.|(?!\1).)*?)\1""")
INNER_RE = re.compile(r">([^<>]{1,80})<")


def js_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")


def unescape(body: str) -> str:
    return (body.replace("\\'", "'").replace('\\"', '"')
            .replace("\\n", "\n").replace("\\t", "\t").replace("\\\\", "\\"))


def in_comment(line: str) -> bool:
    s = line.strip()
    return s.startswith("//") or s.startswith("*") or s.startswith("/*")


def obj_key(line: str, end: int) -> bool:
    rest = line[end:end + 3]
    if not rest.startswith(":"):
        return False
    return "?" not in line[max(0, end - 60):end]


def bad_plain(raw: str) -> bool:
    if len(raw) > 120:
        return True
    if any(x in raw for x in ("<", ">")):
        return True
    if raw.startswith(("http", "/", "./", "../", "#", "data:", "ccswitch")):
        return True
    if raw.endswith((".js", ".json", ".css", ".png", ".html")):
        return True
    if not CJK.search(raw):
        return True
    stripped = raw.strip()
    if re.fullmatch(r"[A-Za-z0-9_\-.,:;()\[\]\s%#/]*", stripped):
        return True
    cjk_n = len(CJK.findall(stripped))
    if cjk_n == 1 and len(stripped) <= 3 and re.search(r"[A-Za-z]", stripped):
        return True
    return False


def new_keys_add(key: str) -> None:
    ZH.setdefault(key, key)
    EN.setdefault(key, key)


def wrap_line(line: str, stats: dict) -> str:
    if not CJK.search(line) or in_comment(line):
        return line
    out = []
    last = 0

    def emit(seg: str, start: int, end: int) -> None:
        out.append(line[last:start])
        out.append(seg)

    for m in STR_RE.finditer(line):
        q, body = m.group(1), m.group(2)
        raw = unescape(body)
        start, end = m.span()

        left = line[max(0, start - 30):start]
        if re.search(r"(?:\bt|I18N\.t)\s*\(\s*$", left):
            continue

        if "${" in raw or "\n" in raw:
            continue

        if not bad_plain(raw) and not obj_key(line, end):
            new_keys_add(raw)
            emit(f"t('{js_escape(raw)}')", start, end)
            stats["pass1"] += 1
            last = end
            continue

        if "<" in raw and ">" in raw and "'" not in raw and '"' not in raw and "\\" not in body:
            spans = []
            okflag = True
            for im in INNER_RE.finditer(raw):
                text = im.group(1)
                if not CJK.search(text):
                    continue
                key = text.strip()
                if not key or len(key) > 80 or any(c in text for c in ("\\", '"', "'")):
                    okflag = False
                    break
                s, e = im.span(1)
                spans.append((s, e, key))
            if okflag and spans:
                bits = []
                cur = 0
                for s, e, key in spans:
                    if s > cur:
                        bits.append(f"{q}{raw[cur:s]}{q}")
                    new_keys_add(key)
                    bits.append(f"t('{js_escape(key)}')")
                    cur = e
                if cur < len(raw):
                    bits.append(f"{q}{raw[cur:]}{q}")
                emit(" + ".join(bits), start, end)
                stats["pass2"] += 1
                last = end
                continue

    out.append(line[last:])
    return "".join(out)


def main() -> None:
    t_total = {"pass1": 0, "pass2": 0}
    for arg in sys.argv[1:]:
        target = ROOT / arg
        src = target.read_text(encoding="utf-8")
        backup = src
        stats = {"pass1": 0, "pass2": 0}
        lines = src.split("\n")
        wrapped = [wrap_line(l, stats) for l in lines]
        result = "\n".join(wrapped)

        target.write_text(result, encoding="utf-8")
        check = subprocess.run(["node", "--check", str(target)], capture_output=True, text=True)
        if check.returncode != 0:
            target.write_text(backup, encoding="utf-8")
            print(f"{arg}: SYNTAX ERROR — reverted. {check.stderr[:800]}")
            sys.exit(1)

        print(f"{arg}: pass1={stats['pass1']} pass2={stats['pass2']}")
        t_total["pass1"] += stats["pass1"]
        t_total["pass2"] += stats["pass2"]

    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    EN_PATH.write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
    print(f"TOTAL pass1={t_total['pass1']} pass2={t_total['pass2']} zh={len(ZH)} en={len(EN)}")


if __name__ == "__main__":
    main()
