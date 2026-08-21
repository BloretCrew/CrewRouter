#!/usr/bin/env python3
"""Debug v2: why did the escaped-quote check fail? Print repr of body."""
import re
from pathlib import Path

src = Path('/data/CrewRouter/public/js/app.js').read_text(encoding='utf-8')
line = src.split('\n')[451]
STR_RE = re.compile(r"""(['"])((?:\\.|(?!\1).)*?)\1""")
m = next(STR_RE.finditer(line))
body = m.group(2)
print('q:', m.group(1))
print('body repr head:', repr(body[:90]))
print('contains \\" (backslash-quote):', '\\"' in body)
# The regex (?:\\.|(?!\1).)*? — does it even match across escaped quotes?
print('full match end ok:', line[m.end():m.end()+2])
