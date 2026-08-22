#!/usr/bin/env python3
"""Find suspicious i18n keys: keys containing HTML tags or attribute syntax
(indicates a broken wrap that swallowed markup into the key)."""
import json
import re
from pathlib import Path

zh = json.loads(Path('/data/CrewRouter/lang/zh.json').read_text(encoding='utf-8'))
BAD = re.compile(r'<[a-zA-Z/][^>]*>|\btitle=|\bstyle=|\bclass=|</')
bad = [k for k in zh if BAD.search(k)]
print(f"suspicious keys: {len(bad)}")
for k in bad[:40]:
    print('  ', repr(k[:100]))
