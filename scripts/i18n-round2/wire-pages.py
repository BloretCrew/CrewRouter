#!/usr/bin/env python3
"""Add i18n.js + language switcher to all pages (site-wide i18n).

For each page lacking i18n.js:
1. Insert <script src="/js/i18n.js?v=1"></script> before the first app script
   (or before </head> if no scripts).
2. Insert a compact <select id="langToggle"> switcher into the page's header
   area — heuristics per page: before </header>, or top of <body>.
3. Add a tiny boot script that re-applies DOM translations on i18n:ready for
   pages without their own wiring.
"""
import re
import subprocess
from pathlib import Path

ROOT = Path('/data/CrewRouter/public/pages')

SWITCHER = '''<select id="langToggle" class="btn btn-icon" title="Language" style="width:auto;height:28px;padding:0 6px;font-size:12px;cursor:pointer;">
      <option value="zh">中文</option>
      <option value="en">EN</option>
    </select>'''

BOOT = '''<script>
  // Page-level i18n: apply catalog to static DOM once ready.
  (function () {
    function apply() { if (window.I18N) I18N.applyDom(); }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply);
    } else { apply(); }
    document.addEventListener('i18n:ready', apply);
    var el = document.getElementById('langToggle');
    if (el && window.I18N) {
      el.value = I18N.current();
      el.addEventListener('change', function () { I18N.load(el.value); });
    }
  })();
</script>'''

I18N_TAG = '<script src="/js/i18n.js?v=2"></script>'


def process(name):
    p = ROOT / name
    src = p.read_text(encoding='utf-8')
    changed = []
    if 'js/i18n.js' not in src:
        # insert before first <script src=...> line, else before </head>
        m = re.search(r'[ \t]*<script src="[^"]+"', src)
        if m:
            src = src[:m.start()] + '  ' + I18N_TAG + '\n' + src[m.start():]
        else:
            src = src.replace('</head>', '  ' + I18N_TAG + '\n</head>', 1)
        changed.append('i18n.js')

    if 'id="langToggle"' not in src:
        inserted = False
        # try: right before theme toggle button or user menu in a header
        for marker in ['id="themeToggle"', 'id="userMenuBtn"', 'id="logoutBtn"']:
            idx = src.find(marker)
            if idx != -1:
                # walk back to the start of that element's line
                ls = src.rfind('\n', 0, idx)
                indent = re.match(r'\s*', src[ls + 1:idx]).group(0)
                src = src[:ls + 1] + indent + SWITCHER.replace('\n      ', '\n' + indent) + '\n' + src[ls + 1:]
                inserted = True
                break
        if not inserted:
            # fallback: after <body ...> tag
            m = re.search(r'<body[^>]*>', src)
            if m:
                src = src[:m.end()] + '\n<div style="position:absolute;top:10px;right:12px;z-index:99;">' + SWITCHER + '</div>' + src[m.end():]
                inserted = True
        if inserted:
            changed.append('switcher')

    if 'i18n:ready' not in src and I18N_TAG in src:
        # add boot script just before </body>
        src = src.replace('</body>', BOOT + '\n</body>', 1)
        changed.append('boot')

    if changed:
        p.write_text(src, encoding='utf-8')
    return changed


total = {}
for f in sorted(ROOT.glob('*.html')):
    if f.name.endswith('.bak'):
        continue
    ch = process(f.name)
    total[f.name] = ch
for k, v in total.items():
    print(f'{k}: {v or "no change"}')
