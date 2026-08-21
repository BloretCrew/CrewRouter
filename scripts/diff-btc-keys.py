#!/usr/bin/env python3
"""Find which keys are in local zh.json but missing from BTC upload (863 local vs 816 BTC)."""
import json
import subprocess

cfg = json.load(open('/data/Bloret-Translation-Collector/config.json'))
db = cfg['database']
FILE_ID = '67875fec-f3f1-4455-9c43-9be1f29094f2'

r = subprocess.run(
    ['psql', '-h', db['host'], '-U', db['user'], '-d', db['name'], '-tAc',
     f"select key_path from string_units where file_id='{FILE_ID}'"],
    env={'PGPASSWORD': db['password'], 'PATH': '/usr/bin:/bin'},
    capture_output=True, text=True)
btc_keys = set(r.stdout.splitlines())

zh = json.load(open('/data/CrewRouter/lang/zh.json'))
local = set(zh.keys())

missing_in_btc = local - btc_keys
orphan_in_btc = btc_keys - local
print('local:', len(local), '| btc:', len(btc_keys))
print('missing in BTC:', len(missing_in_btc))
for k in sorted(missing_in_btc): print('  ', repr(k[:50]))
print('orphaned in BTC:', len(orphan_in_btc))
for k in sorted(orphan_in_btc)[:10]: print('  ', repr(k[:50]))
