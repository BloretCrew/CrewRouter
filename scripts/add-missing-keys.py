#!/usr/bin/env python3
"""Add missing keys (点击禁用/点击启用) to zh+en, re-sync BTC source + MT."""
import json
import subprocess

zh_path = '/data/CrewRouter/lang/zh.json'
en_path = '/data/CrewRouter/lang/en.json'
zh = json.load(open(zh_path))
en = json.load(open(en_path))
for k in ('点击禁用', '点击启用'):
    zh.setdefault(k, k)
    en.setdefault(k, {'点击禁用': 'Click to disable', '点击启用': 'Click to enable'}[k])
json.dump(zh, open(zh_path, 'w'), ensure_ascii=False, indent=2)
out = {k: en.get(k, k) for k in zh}
json.dump(out, open(en_path, 'w'), ensure_ascii=False, indent=2)
print('local keys now:', len(zh))

# re-sync BTC
r = subprocess.run(['node_modules/.bin/tsx', 'scripts/btc-sync-all.ts'],
                   cwd='/data/Bloret-Translation-Collector', capture_output=True, text=True)
print(r.stdout.strip()[-200:] or r.stderr.strip()[-300:])
