"""Compare LSD centres computed from section corners against the official LSD polygons."""
import json, math, random, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

LSD_URL = "https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer/5/query"


def corners(ring):
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = math.cos(math.radians(lat0))
    pts = [(p[0] * k, p[1], p) for p in ring[:-1]] if ring[0] == ring[-1] else [(p[0] * k, p[1], p) for p in ring]
    sw = min(pts, key=lambda q: q[0] + q[1])[2]
    ne = max(pts, key=lambda q: q[0] + q[1])[2]
    se = max(pts, key=lambda q: q[0] - q[1])[2]
    nw = min(pts, key=lambda q: q[0] - q[1])[2]
    return sw, se, ne, nw


def bilinear(c, u, v):
    sw, se, ne, nw = c
    x = (1 - u) * (1 - v) * sw[0] + u * (1 - v) * se[0] + u * v * ne[0] + (1 - u) * v * nw[0]
    y = (1 - u) * (1 - v) * sw[1] + u * (1 - v) * se[1] + u * v * ne[1] + (1 - u) * v * nw[1]
    return x, y


def lsd_uv(n):
    row = (n - 1) // 4
    k = (n - 1) % 4
    col = 3 - k if row % 2 == 0 else k
    return (col + 0.5) / 4, (row + 0.5) / 4


def centroid(ring):
    a = cx = cy = 0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i]; x1, y1 = ring[i + 1]
        cr = x0 * y1 - x1 * y0
        a += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr
    a *= 0.5
    if abs(a) < 1e-14:  # degenerate sliver: fall back to vertex average
        n = len(ring)
        return sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n
    return cx / (6 * a), cy / (6 * a)


def dist_m(a, b):
    k = math.cos(math.radians(a[1]))
    return math.hypot((a[0] - b[0]) * 111320 * k, (a[1] - b[1]) * 110574)


def fetch(sec):
    q = urllib.parse.urlencode({
        "where": f"M={sec['m']} AND RGE={sec['r']} AND TWP={sec['t']} AND SEC={sec['s']} AND RA=' '",
        "outFields": "LS", "outSR": "4326", "geometryPrecision": "7", "f": "json"})
    with urllib.request.urlopen(LSD_URL + "?" + q, timeout=60) as r:
        return sec, json.loads(r.read()).get("features", [])


def main():
    secs = [json.loads(l) for l in open("data/sections.jsonl")]
    random.seed(7)
    regular = [s for s in secs if len(s["ring"]) == 17]
    irregular = [s for s in secs if len(s["ring"]) != 17]
    sample = random.sample(regular, 250) + random.sample(irregular, 100)
    errs_reg, errs_irr, worst = [], [], []
    with ThreadPoolExecutor(6) as ex:
        for sec, feats in ex.map(fetch, sample):
            c = corners(sec["ring"])
            for f in feats:
                ls = f["attributes"]["LS"]
                if not ls:
                    continue
                ring = max(f["geometry"]["rings"], key=len)
                off = centroid(ring)
                calc = bilinear(c, *lsd_uv(ls))
                e = dist_m(off, calc)
                (errs_reg if len(sec["ring"]) == 17 else errs_irr).append(e)
                worst.append((e, sec["m"], sec["r"], sec["t"], sec["s"], ls, len(sec["ring"])))
    for name, es in (("regular", errs_reg), ("irregular", errs_irr)):
        es.sort()
        if es:
            print(name, "n", len(es), "median %.1f m" % es[len(es) // 2], "p95 %.1f m" % es[int(len(es) * .95)],
                  "p99 %.1f m" % es[int(len(es) * .99)], "max %.1f m" % es[-1])
    worst.sort(reverse=True)
    print("worst", worst[:12])


if __name__ == "__main__":
    main()
