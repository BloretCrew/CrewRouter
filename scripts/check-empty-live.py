#!/usr/bin/env python3
"""Check which of the 47 new keys are still empty in BTC live export."""
import json
import subprocess

cfg = json.load(open('/data/Bloret-Translation-Collector/config.json'))
db = cfg['database']
FILE_ID = '67875fec-f3f1-4455-9c43-9be1f29094f2'

r = subprocess.run(
    ['psql', '-h', db['host'], '-U', db['user'], '-d', db['name'], '-tAc',
     f"select key_path, text from machine_translations where file_id='{FILE_ID}' and locale='en'"],
    env={'PGPASSWORD': db['password'], 'PATH': '/usr/bin:/bin'},
    capture_output=True, text=True)
mt = {}
for line in r.stdout.splitlines():
    if '|' in line:
        k, v = line.split('|', 1)
        mt[k] = v
print('MT rows:', len(mt))
live = json.load(open('/tmp/live5.json'))
empty = [k for k, v in live.items() if not v]
print('live empty keys:', len(empty))
for k in empty[:10]:
    print('  ', repr(k[:40]), '-> MT has:', repr(mt.get(k, '<<NO MT ROW>>')[:40]))
