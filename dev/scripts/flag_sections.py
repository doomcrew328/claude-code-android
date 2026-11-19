"""Flag irregular ATS sections (fractional, odd-shaped, multi-ring) whose LSDs need official centres.
Reads data/sections.jsonl, writes data/flagged.json. Run after fetch_sections.py, before fetch_flagged.py."""
import json, math, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from validate import corners


def area_m2(ring):
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = math.cos(math.radians(lat0))
    a = 0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i][0] * 111320 * k, ring[i][1] * 110574
        x1, y1 = ring[i + 1][0] * 111320 * k, ring[i + 1][1] * 110574
        a += x0 * y1 - x1 * y0
    return abs(a) / 2


def main():
    flag = []
    for line in open("data/sections.jsonl"):
        s = json.loads(line)
        r = s["ring"] if s["ring"][0] == s["ring"][-1] else s["ring"] + [s["ring"][0]]
        c = corners(r)
        quad = [c[0], c[1], c[2], c[3], c[0]]
        ar, aq = area_m2(r), area_m2(quad)
        dev = abs(ar / aq - 1) if aq else 1
        std = abs(ar / 2.585e6 - 1)
        if dev > 0.01 or std > 0.06 or s["nrings"] > 1:
            flag.append([s["m"], s["r"], s["t"], s["s"]])
    json.dump(flag, open("data/flagged.json", "w"))
    print("flagged", len(flag))


if __name__ == "__main__":
    main()
