#!/usr/bin/env python3
"""Fix the concat-line with wrongly-injected dollar-brace t() (should be + t() +)."""
from pathlib import Path

p = Path('/data/CrewRouter/public/js/admin.js')
src = p.read_text(encoding='utf-8')
old = "'</strong>${t(' + chr(39)"
# build strings without nesting issues
bad = "</strong>${t("
good = "</strong>' + t("
line_old = None
for line in src.split('\n'):
    if bad in line and '不会误删' in line:
        line_old = line
        break
assert line_old, 'line not found'
line_new = line_old.replace(bad, good)
# the injected form was: </strong>${t('...')}  inside a single-quoted string ending with ',
# correct to: </strong>' + t('...') + '
line_new = line_new.replace("')}',", "') + '\,',") if False else line_new
# handle tail: ...}')}',  →  ...}') + ',
if line_new.endswith("}'),"):
    line_new = line_new[:-len("}'),")] + "'),"
src = src.replace(line_old, line_new)
p.write_text(src, encoding='utf-8')
print('OLD:', line_old.strip()[:120])
print('NEW:', line_new.strip()[:120])
