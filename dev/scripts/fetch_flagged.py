"""Fetch official LSD polygons for irregular sections; store their exact LSD centres.
Then re-check accuracy on a fresh sample of NON-flagged irregular sections."""
import json, random, urllib.request, urllib.parse, collections
from concurrent.futures import ThreadPoolExecutor
from validate import centroid, corners, bilinear, lsd_uv, dist_m, fetch

LSD_URL = "https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer/5/query"


def fetch_twp(item):
    (m, r, t), secs = item
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "where": f"M={m} AND RGE={r} AND TWP={t} AND RA=' ' AND SEC IN ({','.join(map(str, secs))})",
            "outFields": "SEC,LS", "outSR": "4326", "geometryPrecision": "6", "f": "json",
            "resultOffset": str(offset), "resultRecordCount": "1000", "orderByFields": "OBJECTID"})
        for i in range(5):
            try:
                with urllib.request.urlopen(LSD_URL + "?" + q, timeout=90) as resp:
                    d = json.loads(resp.read())
                break
            except Exception:
                if i == 4:
                    raise
        feats = d.get("features", [])
        for f in feats:
            a = f["attributes"]
            if not a["LS"] or not f.get("geometry"):
                continue
            ring = max(f["geometry"]["rings"], key=len)
            cx, cy = centroid(ring)
            out.append([m, r, t, a["SEC"], a["LS"], round(cx, 6), round(cy, 6)])
        if len(feats) < 1000:
            break
        offset += 1000
    return out


def main():
    flagged = json.load(open("data/flagged.json"))
    by = collections.defaultdict(list)
    for m, r, t, s in flagged:
        by[(m, r, t)].append(s)
    res = []
    with ThreadPoolExecutor(6) as ex:
        for out in ex.map(fetch_twp, by.items()):
            res.extend(out)
    json.dump(res, open("data/exact_lsds.json", "w"))
    print("exact LSDs stored", len(res), "for sections", len({tuple(x[:4]) for x in res}), "of", len(flagged))

    # fresh check on NON-flagged irregular sections
    fl = {tuple(x) for x in flagged}
    secs = [json.loads(l) for l in open("data/sections.jsonl")]
    cand = [s for s in secs if len(s["ring"]) != 17 and (s["m"], s["r"], s["t"], s["s"]) not in fl]
    random.seed(99)
    sample = random.sample(cand, 150) + random.sample([s for s in secs if len(s["ring"]) == 17 and (s["m"], s["r"], s["t"], s["s"]) not in fl], 150)
    errs = []
    with ThreadPoolExecutor(6) as ex:
        for sec, feats in ex.map(fetch, sample):
            c = corners(sec["ring"])
            for f in feats:
                ls = f["attributes"]["LS"]
                if not ls:
                    continue
                e = dist_m(centroid(max(f["geometry"]["rings"], key=len)), bilinear(c, *lsd_uv(ls)))
                errs.append((e, sec["m"], sec["r"], sec["t"], sec["s"], ls, len(sec["ring"])))
    errs.sort()
    v = [e[0] for e in errs]
    print("non-flagged n", len(v), "median %.1f p95 %.1f p99 %.1f max %.1f" % (v[len(v) // 2], v[int(len(v) * .95)], v[int(len(v) * .99)], v[-1]))
    print("worst", errs[-8:])


if __name__ == "__main__":
    main()
