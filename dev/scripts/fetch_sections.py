"""Fetch every ATS section polygon (no road allowances) from Alberta's open data service.
Writes data/sections.jsonl: one record per section {m,r,t,s,ring:[[lon,lat],...]}.
Data: Government of Alberta, Open Government Licence - Alberta."""
import json, sys, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

URL = "https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer/1/query"
MAX_ID = 756369
STEP = 2500


def get(params, tries=5):
    q = urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(URL + "?" + q, timeout=90) as r:
                d = json.loads(r.read())
            if "error" in d:
                raise RuntimeError(d["error"])
            return d
        except Exception as e:  # retry with backoff
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def chunk(a):
    b = a + STEP
    out, offset = [], 0
    while True:
        d = get({
            "where": f"RA=' ' AND OBJECTID>={a} AND OBJECTID<{b}",
            "outFields": "M,RGE,TWP,SEC",
            "returnGeometry": "true",
            "outSR": "4326",
            "geometryPrecision": "6",
            "orderByFields": "OBJECTID",
            "resultOffset": str(offset),
            "resultRecordCount": "1000",
            "f": "json",
        })
        feats = d.get("features", [])
        for f in feats:
            at, g = f["attributes"], f.get("geometry") or {}
            rings = g.get("rings") or []
            if not rings:
                continue
            ring = max(rings, key=len)
            out.append({"m": at["M"], "r": at["RGE"], "t": at["TWP"], "s": at["SEC"], "ring": ring, "nrings": len(rings)})
        if len(feats) < 1000 and not d.get("exceededTransferLimit"):
            break
        offset += len(feats)
    return out


def main():
    starts = list(range(0, MAX_ID + 1, STEP))
    n = 0
    with open("data/sections.jsonl", "w") as fo, ThreadPoolExecutor(6) as ex:
        for i, res in enumerate(ex.map(chunk, starts)):
            for rec in res:
                fo.write(json.dumps(rec, separators=(",", ":")) + "\n")
            n += len(res)
            if i % 25 == 0:
                print(f"chunk {i}/{len(starts)} sections so far {n}", flush=True)
    print("TOTAL", n)


if __name__ == "__main__":
    main()
