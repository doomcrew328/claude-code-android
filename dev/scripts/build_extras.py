"""Build small offline lookup files for LEASELINE:
  data/places.json    — Alberta populated places (Gov. of Alberta Geographic Names, OGL-Alberta)
  data/hospitals.json — Alberta hospitals (Statistics Canada ODHF v1.1, Open Government Licence – Canada)
Usage: python3 -I build_extras.py <odhf csv> <out data dir>"""
import csv, json, re, sys, urllib.request, urllib.parse

GN = "https://geospatial.alberta.ca/titan/rest/services/locator/geographic_name_system/MapServer/2/query"
TYPES = ['City', 'Town', 'Village', 'Summer Village', 'Hamlet', 'Locality', 'Settlement', 'Indian Reserve', 'Metis Settlement', 'Specialized Municipality', 'Urban Service Area']


def places():
    out, offset = [], 0
    where = "FEAT_TYPE IN (%s)" % ",".join("'%s'" % t for t in TYPES)
    while True:
        q = urllib.parse.urlencode({"where": where, "outFields": "GAZ_NAME,FEAT_TYPE,LATITUDE,LONGITUDE", "returnGeometry": "false",
                                    "orderByFields": "OBJECTID", "resultOffset": offset, "resultRecordCount": 1000, "f": "json"})
        d = json.load(urllib.request.urlopen(GN + "?" + q, timeout=60))
        f = d.get("features", [])
        for x in f:
            a = x["attributes"]
            if a["LATITUDE"] and a["LONGITUDE"]:
                lon = a["LONGITUDE"]
                out.append([a["GAZ_NAME"].strip(), a["FEAT_TYPE"], round(a["LATITUDE"], 5), round(-abs(lon), 5)])
        if len(f) < 1000:
            break
        offset += 1000
    return out


def hospitals(path):
    bad = re.compile(r'cancer|clinic|hip and knee|glenrose|alberta hospital edmonton|mental|addiction|rehab|continuing care|forensic|capitalcare|auxiliary|villa caritas', re.I)
    out = []
    for r in csv.DictReader(open(path, encoding='latin-1')):
        if r['province'].lower() != 'ab' or r['odhf_facility_type'] != 'Hospitals' or bad.search(r['facility_name']):
            continue
        if not (r['latitude'] and r['longitude']):
            continue
        name = r['facility_name'].replace('\x92', "'").replace('\x97', '-').strip()
        out.append([name, r['city'].title(), round(float(r['latitude']), 5), round(float(r['longitude']), 5)])
    return out


def main():
    odhf, outdir = sys.argv[1], sys.argv[2]
    p = places()
    json.dump(p, open(f"{outdir}/places.json", "w"), separators=(",", ":"))
    h = hospitals(odhf)
    json.dump(h, open(f"{outdir}/hospitals.json", "w"), separators=(",", ":"))
    print("places", len(p), "hospitals", len(h))


if __name__ == "__main__":
    main()
