#!/usr/bin/env python3
"""Wrap Chinese text in console.html with data-i18n attributes.

- Text nodes:  >中文<            → <span data-i18n="中文">…</span>
- Attributes:  placeholder/title/aria-label/alt="中文" → adds data-i18n-placeholder/-title="中文"
Skips <script>/<style> blocks. New keys discovered here are appended to lang/zh.json.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "public" / "pages" / "console.html"
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
    src = TARGET.read_text(encoding="utf-8")
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
                # multi-line/odd whitespace node: only tag when node text is exactly normalized
                return m.group(0)
            if norm not in ZH:
                ZH[norm] = norm
            stats["text"] += 1
            return f'><span data-i18n="{esc_attr(norm)}">{chunk}</span><'

        part = re.sub(r">([^<>]+)<", text_repl, part)
        parts[idx] = part

    TARGET.write_text("".join(parts), encoding="utf-8")
    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"text nodes wrapped: {stats['text']}, attrs wrapped: {stats['attr']}, zh keys now: {len(ZH)}")


if __name__ == "__main__":
    main()
