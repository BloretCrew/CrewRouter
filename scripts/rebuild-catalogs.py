#!/usr/bin/env python3
"""Rebuild clean zh.json/en.json from wrapped console.html + restored app.js + saved translations."""
import json
import subprocess
from pathlib import Path

ROOT = Path('/data/CrewRouter')

# 1. extract from current sources (console.html is wrapped; app.js is pristine)
subprocess.run(['python3', 'scripts/extract-i18n-keys.py'], cwd=ROOT, check=True)

zh = json.loads((ROOT / 'lang' / 'zh.json').read_text(encoding='utf-8'))
backup = json.loads((ROOT / 'lang' / '.en-translations-backup.json').read_text(encoding='utf-8'))

en = {}
missing = []
for k in zh:
    if k in backup:
        en[k] = backup[k]
    else:
        en[k] = k
        missing.append(k)

print('zh:', len(zh), '| translated:', len(zh) - len(missing), '| missing:', len(missing))
for k in missing[:30]:
    print('  MISSING:', repr(k[:70]))

(ROOT / 'lang' / 'en.json').write_text(
    json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(ROOT / 'lang' / 'zh.json').write_text(
    json.dumps({k: k for k in zh}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('rebuilt.')
