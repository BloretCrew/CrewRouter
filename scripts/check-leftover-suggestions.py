#!/usr/bin/env python3
"""Check leftover suggestion/approval data from the earlier wrong-path upload."""
import json
import subprocess

cfg = json.load(open('/data/Bloret-Translation-Collector/config.json'))
db = cfg['database']
FILE_ID = '67875fec-f3f1-4455-9c43-9be1f29094f2'
DETRITAL = 'df4df676-2fea-4428-8205-b2a9e6f186fd'

def q(sql):
    r = subprocess.run(['psql','-h',db['host'],'-U',db['user'],'-d',db['name'],'-tAc',sql],
        env={'PGPASSWORD':db['password'],'PATH':'/usr/bin:/bin'},capture_output=True,text=True)
    return r.stdout.strip() or r.stderr.strip()

print('suggestions by Detrital (en) for this file:',
      q(f"select count(*) from translation_suggestions s join string_units u on s.string_id=u.id where u.file_id='{FILE_ID}' and s.locale='en' and s.author_id='{DETRITAL}'"))
print('translations mirror rows (en):',
      q(f"select count(*) from translations t join string_units u on t.string_id=u.id where u.file_id='{FILE_ID}' and t.locale='en'"))
print('string_locale_states approved (en):',
      q(f"select count(*) from string_locale_states st join string_units u on st.string_id=u.id where u.file_id='{FILE_ID}' and st.locale='en' and st.status='approved'"))
