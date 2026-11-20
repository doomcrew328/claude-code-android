"""Pack AER ST37 (surface + bottom holes) into compact columnar files for LEASELINE.
Usage: python3 -I pack_wells.py <dir with sh.tsv, bh.tsv> <out data dir>
Outputs:
  wells.bin.gz        surface holes + bottom holes (UWI, coords, licensee, status, dates, H2S class)
  wellnames.txt.gz    one well name per bottom hole, same order as in wells.bin
Data: Alberta Energy Regulator ST37 (free public data)."""
import csv, sys, gzip, struct, re, datetime, json
from array import array

BASE = datetime.date(1900, 1, 1)
UWI = re.compile(r'^([0-9A-Z]{2})/(\d{2})-(\d{2})-(\d{3})-(\d{2})W(\d)/(\d)$')
LOC = re.compile(r'^(\d{2})-(\d{2})-(\d{3})-(\d{2})W(\d)$')


def year(s):
    d = days(s)
    return 0 if not d else max(1, min(255, (BASE.toordinal() + d - datetime.date(1900, 1, 1).toordinal()) // 365 + 1))


def yr(s):
    s = (s or '').strip()
    if not s:
        return 0
    y = int(s.split('/')[-1]) if '/' in s else int(s[:4])
    return max(0, min(255, y - 1900))


def days(s):
    s = (s or '').strip()
    if not s:
        return 0
    try:
        if '/' in s:
            m, d, y = s.split('/')
            dt = datetime.date(int(y), int(m), int(d))
        else:
            dt = datetime.date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        return max(0, min(65535, (dt - BASE).days))
    except Exception:
        return 0


def h2s(cat):
    c = cat.lower()
    pad = 1 if 'multiwell pad' in c else 0
    if 'bwl historic' in c:
        lvl = 7
    elif 'proximity critical' in c or '>= 2.0' in c:
        lvl = 4
    elif '>= 0.3' in c:
        lvl = 3
    elif '>= 0.01' in c:
        lvl = 2
    elif '>0.00' in c:
        lvl = 1
    elif '0.00 mol' in c:
        lvl = 0
    else:
        lvl = 6  # other (water source, compressor...)
    water = 1 if 'water well' in c else 0
    return lvl | (pad << 3) | (water << 4)


def lic_split(s):
    s = s.strip()
    m = re.match(r'^(\d+)([A-Z]?)$', s)
    return (int(m.group(1)), ord(m.group(2)) if m.group(2) else 0) if m else (0, 0)


def main():
    src, out = sys.argv[1], sys.argv[2]
    # keep sites that physically exist: skip cancelled (never drilled) and reclaimed (RecCertified / RecExempt) licences
    DROP = {'cancelled', 'reccertified', 'recexempt'}
    sh = [r for r in csv.DictReader(open(f'{src}/sh.tsv'), delimiter='\t') if r['Licence_Status'].strip().lower() not in DROP]
    keep = {r['Well_Licence_Number'] for r in sh}
    bh = [r for r in csv.DictReader(open(f'{src}/bh.tsv'), delimiter='\t') if r['Well_Licence_Number'] in keep]
    by_lic = {}
    for r in bh:
        by_lic.setdefault(r['Well_Licence_Number'], []).append(r)

    def key(r):
        m = LOC.match(r['Licence_Surface_Location_Label'])
        if m:
            ls, s, t, rg, mer = map(int, m.groups())
            return (mer, rg, t, s, ls, r['Well_Licence_Number'])
        return (9, 0, 0, 0, 0, r['Well_Licence_Number'])
    sh.sort(key=key)

    licensees = sorted(set(r['Licensee'] for r in sh))
    li_idx = {n: i for i, n in enumerate(licensees)}
    statuses = sorted(set(r['Licence_Status'].title() for r in sh))
    st_idx = {n: i for i, n in enumerate(statuses)}
    les = sorted(set(UWI.match(r['Well_UWI']).group(1) for r in bh))
    le_idx = {n: i for i, n in enumerate(les)}

    n = len(sh)
    lic_num, lic_suf = array('I'), array('B')
    lat, lon = array('i'), array('i')
    lice, stat, flag = array('H'), array('B'), array('B')
    d_stat, d_spud, d_drill = array('B'), array('B'), array('B')
    nbh = array('B')
    # bottom-hole columns
    b_le, b_lsd, b_sec, b_twp, b_rge, b_mer, b_es = (array('B') for _ in range(7))
    b_dlat, b_dlon, b_td = array('i'), array('i'), array('H')
    names = []
    for r in sh:
        a, b = lic_split(r['Well_Licence_Number'])
        lic_num.append(a); lic_suf.append(b)
        y, x = round(float(r['SH_Actual_Latitude']) * 1e5), round(float(r['SH_Actual_Longitude']) * 1e5)
        lat.append(y); lon.append(x)
        lice.append(li_idx[r['Licensee']]); stat.append(st_idx[r['Licence_Status'].title()]); flag.append(h2s(r['Energy_Devlpmt_Category_Type']))
        d_stat.append(yr(r['Licence_Status_Date'])); d_spud.append(yr(r['Spud_Date'])); d_drill.append(yr(r['Most_Recent_Final_Drill_Date']))
        holes = sorted(by_lic.get(r['Well_Licence_Number'], []), key=lambda h: h['Well_UWI'])[:255]
        nbh.append(len(holes))
        for h in holes:
            m = UWI.match(h['Well_UWI'])
            le, ls, s, t, rg, mer, es = m.groups()
            b_le.append(le_idx[le]); b_lsd.append(int(ls)); b_sec.append(int(s)); b_twp.append(int(t)); b_rge.append(int(rg)); b_mer.append(int(mer)); b_es.append(int(es))
            b_dlat.append(round(float(h['BH_Latitude']) * 1e5) - y); b_dlon.append(round(float(h['BH_Longitude']) * 1e5) - x)
            try:
                td = int(round(float(h['Final_Total_Depth'] or 0)))
            except ValueError:
                td = 0
            b_td.append(max(0, min(65535, td)))
            names.append(re.sub(r'\s+', ' ', h['Well_Name']).strip())

    def delta(arr, typ):
        outa, prev = array(typ), 0
        for v in arr:
            outa.append(v - prev); prev = v
        return outa
    m = len(b_le)

    def varint(arr, signed):
        o = bytearray()
        for v in arr:
            if signed:
                v = (v << 1) ^ (v >> 63)
            while v >= 0x80:
                o.append((v & 0x7F) | 0x80); v >>= 7
            o.append(v)
        return o
    V = lambda a: varint(a, True)
    U = lambda a: varint(a, False)
    cols = [
        V(delta(lat, 'i')), V(delta(lon, 'i')), U(lic_num), lic_suf, U(lice), stat, flag, d_stat, d_spud, d_drill, nbh,
        b_le, b_lsd, b_sec, b_twp, b_rge, b_mer, b_es, V(b_dlat), V(b_dlon), U(b_td),
    ]
    tables = json.dumps({'licensees': licensees, 'statuses': statuses, 'les': les,
                         'built': datetime.date.today().isoformat(), 'source': 'AER ST37'}, separators=(',', ':')).encode()
    body = bytearray(b'WEL3') + struct.pack('<III', n, m, len(tables)) + tables
    while len(body) % 4:
        body += b'\0'
    for c in cols:
        bts = bytes(c) if isinstance(c, (bytes, bytearray)) else c.tobytes()
        body += struct.pack('<I', len(bts)) + bts
        while len(body) % 4:
            body += b'\0'
    gz = gzip.compress(bytes(body), 9)
    open(f'{out}/wells.bin.gz', 'wb').write(gz)
    ng = gzip.compress('\n'.join(names).encode(), 9)
    open(f'{out}/wellnames.txt.gz', 'wb').write(ng)
    print('surface', n, 'bottom', m, 'raw', len(body), 'gz', len(gz), 'names gz', len(ng), 'licensees', len(licensees), 'statuses', statuses)


if __name__ == '__main__':
    main()
