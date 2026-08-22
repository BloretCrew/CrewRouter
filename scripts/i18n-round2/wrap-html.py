#!/usr/bin/env python3
"""Round-2: wrap ALL remaining pages' Chinese with data-i18n (site-wide i18n).

Usage: python3 wrap-html.py <relative-path-to-html> [...]
Reuses the exact pattern from scripts/wrap-console-html.py but takes target
files as args. New keys appended to lang/zh.json.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
ZH_PATH = ROOT / "lang" / "zh.json"
ZH = json.loads(ZH_PATH.read_text(encoding="utf-8"))
CJK = re.compile(r"[\u4e00-\u9fff]")

ATTR_MAP = {
    "placeholder": "data-i18n-placeholder",
    "title": "data-i18n-title",
    "aria-label": "data-i18n-title",
    "alt": "data-i18n-title",
}


def esc_attr(s: str) -> str:
    return (s.replace("&", "&amp;").replace('"', "&quot;")
             .replace("<", "&lt;").replace(">", "&gt;"))


def main() -> None:
    stats_total = {"text": 0, "attr": 0}
    for arg in sys.argv[1:]:
        target = ROOT / arg
        src = target.read_text(encoding="utf-8")
        parts = re.split(r"(<script\b.*?</script>|<style\b.*?</style>)", src, flags=re.DOTALL)
        stats = {"text": 0, "attr": 0}

        for idx, part in enumerate(parts):
            if part.startswith(("<script", "<style")):
                continue

            def attr_repl(m: re.Match) -> str:
                attr, val = m.group(1), m.group(2)
                if not CJK.search(val):
                    return m.group(0)
                if val not in ZH:
                    ZH[val] = val
                stats["attr"] += 1
                mapped = ATTR_MAP[attr]
                return f'{attr}="{esc_attr(val)}" {mapped}="{esc_attr(val)}"'

            part = re.sub(
                r"""\b(placeholder|title|aria-label|alt)="([^"]*[\u4e00-\u9fff][^"]*)\"""",
                attr_repl, part)

            def text_repl(m: re.Match) -> str:
                chunk = m.group(1)
                if not CJK.search(chunk):
                    return m.group(0)
                norm = re.sub(r"\s+", " ", chunk).strip()
                if not norm or len(norm) > 120 or any(x in norm for x in ("${", "<%", "%>")):
                    return m.group(0)
                if chunk.strip() != norm:
                    return m.group(0)
                if norm not in ZH:
                    ZH[norm] = norm
                stats["text"] += 1
                return f'><span data-i18n="{esc_attr(norm)}">{chunk}</span><'

            part = re.sub(r">([^<>]+)<", text_repl, part)
            parts[idx] = part

        target.write_text("".join(parts), encoding="utf-8")
        print(f"{arg}: text={stats['text']} attr={stats['attr']}")
        stats_total["text"] += stats["text"]
        stats_total["attr"] += stats["attr"]

    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"TOTAL text={stats_total['text']} attr={stats_total['attr']} zh keys={len(ZH)}")


if __name__ == "__main__":
    main()
