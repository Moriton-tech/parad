#!/usr/bin/env python3
"""parad.mn — кэш шинэчлэх: JS/CSS холбоосуудад ?v=<хувилбар> залгана.
Сайт шинэчлэх бүрд ажиллуулна:  python3 tools/bump.py"""
import glob, re, time, os
os.chdir(os.path.dirname(os.path.abspath(__file__)) + '/..')
v = time.strftime('%y%m%d%H%M')
pat = re.compile(r"(?<=[\"'])((?:\./)?(?:js|css)/[A-Za-z0-9/_.-]+\.(?:js|mjs|css)|\./(?:app|config|pm-ui|db)\.js)(\?v=\w+)?")
for f in glob.glob('*.html') + glob.glob('js/*.js'):
    s = open(f, encoding='utf-8').read()
    n = pat.sub(lambda m: m.group(1) + '?v=' + v, s)
    if n != s: open(f, 'w', encoding='utf-8').write(n)
print('version', v)
