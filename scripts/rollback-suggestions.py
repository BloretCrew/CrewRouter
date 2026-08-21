#!/usr/bin/env python3
"""Rollback the wrong-path upload: delete suggestions, translation mirrors, and approval states
for file 67875fec / locale en / author Detrital. MT rows (official path) stay untouched."""
import json
import subprocess

cfg = json.load(open('/data/Bloret-Translation-Collector/config.json'))
db = cfg['database']
FILE_ID = '67875fec-f3f1-4455-9c43-9be1f29094f2'
DETRITAL = 'df4df676-2fea-4428-8205-b2a9e6f186fd'

def q(sql):
    r = subprocess.run(['psql','-h',db['host'],'-U',db['user'],'-d',db['name'],'-tAc',sql],
        env={'PGPASSWORD':db['password'],'PATH':'/usr/bin:/bin'},capture_output=True,text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout.strip()

# order matters: states reference suggestions; translations mirror is independent
n1 = q(f"delete from string_locale_states st using string_units u where st.string_id=u.id and u.file_id='{FILE_ID}' and st.locale='en' returning 1")
print('states deleted:', len(n1.splitlines()) if n1 else 0)
n2 = q(f"delete from translation_suggestions s using string_units u where s.string_id=u.id and u.file_id='{FILE_ID}' and s.locale='en' and s.author_id='{DETRITAL}' returning 1")
print('suggestions deleted:', len(n2.splitlines()) if n2 else 0)
n3 = q(f"delete from translations t using string_units u where t.string_id=u.id and u.file_id='{FILE_ID}' and t.locale='en' returning 1")
print('translation mirrors deleted:', len(n3.splitlines()) if n3 else 0)

# verify
print('remaining suggestions:', q(f"select count(*) from translation_suggestions s join string_units u on s.string_id=u.id where u.file_id='{FILE_ID}' and s.locale='en'"))
print('remaining mirrors:', q(f"select count(*) from translations t join string_units u on t.string_id=u.id where u.file_id='{FILE_ID}' and t.locale='en'"))
print('remaining approved states:', q(f"select count(*) from string_locale_states st join string_units u on st.string_id=u.id where u.file_id='{FILE_ID}' and st.locale='en'"))
print('MT rows intact:', q(f"select count(*) from machine_translations where file_id='{FILE_ID}' and locale='en'"))
