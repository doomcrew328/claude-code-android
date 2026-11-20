"""Daily LEASELINE data: drilling-rig activity (AER ST49) + wells licensed since the last ST37 snapshot.
Usage: python3 -I build_daily.py <work dir> <app data dir> [days=30]
Writes rigs.json, wells_new.json, meta.json into the app data dir.
Data: Alberta Energy Regulator (free public data)."""
import csv, datetime, gzip, io, json, os, re, struct, sys, urllib.request

SPUD = 'https://static.aer.ca/prd/data/wells/SPUD{:%m%d}.txt'
LICS = 'https://www2.aer.ca/t/Production/views/COM-WellLicenceAllList/WellLicenceAllAB.csv'


def get(url, path):
    req = urllib.request.Request(url, headers={'User-Agent': 'LEASELINE data refresh (personal use)'})
    with urllib.request.urlopen(req, timeout=300) as r, open(path, 'wb') as fo:
        fo.write(r.read())


def parse_spud(text):
    lines = text.splitlines()
    dash = next((i for i, l in enumerate(lines) if l.startswith('-------')), None)
    if dash is None:
        return []
    spans, pos = [], 0
    for m in re.finditer(r'-+', lines[dash]):
        spans.append((m.start(), m.end()))
    out = []
    for l in lines[dash + 1:]:
        if not re.match(r'^[0-9A-Z]{2}/\d{2}-\d{2}-\d{3}-\d{2}W\d/\d', l):
            continue
        f = [l[a:b + 1].strip() if i < len(spans) - 1 else l[a:].strip() for i, (a, b) in enumerate(spans)]
        # contractor name column can be blank; rig number sits in its own column
        rec = {'uwi': f[0], 'name': f[1], 'lic': f[2], 'contractor': f[4], 'rig': f[5], 'when': f[6], 'field': f[7], 'licensee': f[9], 'type': f[11] if len(f) > 11 else ''}
        try:
            rec['date'] = datetime.datetime.strptime(rec['when'], '%d %b %Y %I:%M:%S %p').isoformat(timespec='minutes')
        except ValueError:
            rec['date'] = ''
        out.append(rec)
    return out


def main():
    work, data = sys.argv[1], sys.argv[2]
    ndays = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    os.makedirs(work, exist_ok=True)
    # licence list (daily, includes new licences)
    lic_path = os.path.join(work, 'lic.csv')
    get(LICS, lic_path)
    lic = {}
    for r in csv.reader(open(lic_path, newline='', encoding='utf-8', errors='replace')):
        if not r or not r[0].startswith('W'):
            continue
        num = r[0].replace('W', '').strip()
        try:
            lic[num] = (r[1], float(r[2]), float(r[3]), r[4], r[7], r[8])
        except (ValueError, IndexError):
            pass
    # spud activity, last N days
    today = datetime.date.today()
    rigs, seen = [], set()
    for k in range(ndays):
        d = today - datetime.timedelta(days=k)
        p = os.path.join(work, f'SPUD{d:%m%d}.txt')
        try:
            get(SPUD.format(d), p)
        except Exception as e:
            print('skip', d, e)
            continue
        txt = open(p, encoding='latin-1').read()
        run = re.search(r'Run Date:\s*(\d{1,2} \w{3} \d{4})', txt)
        if run:
            rd = datetime.datetime.strptime(run.group(1), '%d %b %Y').date()
            if (today - rd).days > ndays + 2:   # file left over from a previous year
                continue
        for rec in parse_spud(txt):
            key = (rec['uwi'], rec['date'], rec['rig'])
            if key in seen:
                continue
            seen.add(key)
            L = lic.get(rec['lic'])
            if L:
                rec['lat'], rec['lon'] = round(L[1], 5), round(L[2], 5)
            rigs.append(rec)
    # some ST49 rows leave the contractor blank; fill it when that rig number belongs to one contractor
    by_rig = {}
    for r in rigs:
        if r['contractor']:
            by_rig.setdefault(r['rig'], set()).add(r['contractor'])
    for r in rigs:
        if not r['contractor'] and len(by_rig.get(r['rig'], ())) == 1:
            r['contractor'] = next(iter(by_rig[r['rig']]))
    rigs.sort(key=lambda r: r['date'], reverse=True)
    json.dump(rigs, open(os.path.join(data, 'rigs.json'), 'w'), separators=(',', ':'))
    # wells licensed after the ST37 snapshot (not in wells.bin)
    st37 = set()
    wb = os.path.join(data, 'wells.bin.gz')
    if os.path.exists(wb):
        b = gzip.decompress(open(wb, 'rb').read())
        n, m, tl = struct.unpack('<III', b[4:16])
        o = 16 + tl
        while o % 4:
            o += 1
        cols = []
        for _ in range(4):
            L = struct.unpack('<I', b[o:o + 4])[0]
            cols.append(b[o + 4:o + 4 + L]); o += 4 + L
            while o % 4:
                o += 1
        vi, pos, nums = cols[2], 0, []
        while pos < len(vi):
            v = sh = 0
            while True:
                c = vi[pos]; pos += 1; v |= (c & 0x7F) << sh; sh += 7
                if c < 0x80:
                    break
            nums.append(v)
        suf = cols[3]
        st37 = {f'{nums[i]:07d}' + (chr(suf[i]) if suf[i] else '') for i in range(len(nums))}
    keep = {'issued', 'amended', 'suspension', 're-entered', 'abandoned'}
    new = [[k, v[0], round(v[1], 5), round(v[2], 5), v[3], v[4], v[5]] for k, v in lic.items()
           if k not in st37 and v[4].strip().lower() in keep and len(k) >= 7]
    if st37:
        json.dump(new, open(os.path.join(data, 'wells_new.json'), 'w'), separators=(',', ':'))
    meta_path = os.path.join(data, 'meta.json')
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    meta.update({'daily': datetime.datetime.now().isoformat(timespec='minutes'), 'rigs': len(rigs), 'wells_new': len(new)})
    json.dump(meta, open(meta_path, 'w'), indent=1)
    print('rigs', len(rigs), 'with coords', sum(1 for r in rigs if 'lat' in r), 'new wells', len(new))


if __name__ == '__main__':
    main()
