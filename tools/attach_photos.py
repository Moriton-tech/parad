#!/usr/bin/env python3
"""img/horses/cat/<каталог№>[-n].jpg (+ -t.jpg) зургуудыг адуунд холбох SQL хэвлэнэ.
Зөвхөн каталогийн дугаар (sort) нь давхардаагүй, зураггүй адуунд онооно.
Ажиллуулах: python3 tools/attach_photos.py > /tmp/x.sql  → Supabase SQL Editor-т ажиллуулна."""
import os, json, collections
d = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'img', 'horses', 'cat')
g = collections.defaultdict(list)
for f in os.listdir(d):
    if f.endswith('.jpg') and not f.endswith('-t.jpg'):
        b = f[:-4]; g[int(b.split('-')[0])].append(b)
rows = []
for n, bs in sorted(g.items()):
    bs.sort(key=lambda b: 0 if '-' not in b else int(b.split('-')[1]))
    ph = [{"u": f"img/horses/cat/{b}.jpg", "t": f"img/horses/cat/{b}-t.jpg"} for b in bs]
    rows.append(f"({n}, '{json.dumps(ph)}'::jsonb)")
print(f"""with m(sort, ph) as (values {', '.join(rows)}),
uniq as (select sort from horses group by sort having count(*) = 1)
update horses h set photos = m.ph, updated_at = now()
from m join uniq using (sort)
where h.sort = m.sort and coalesce(jsonb_array_length(h.photos), 0) = 0
returning h.sort, h.name, jsonb_array_length(h.photos) n;""")
