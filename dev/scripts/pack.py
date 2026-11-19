"""Pack sections + exact LSD centres into a compact binary (gzipped) for the app.

Layout (little endian), all coordinates in 1e-5 degree integers:
  magic 'LSD1' | u32 nTownships | u32 nSections | u32 nExact
  per township: u8 m | u8 r | u8 t | u8 count | i32 originLon | i32 originLat
     per section: u8 sec | u8 flags(1=irregular) | i16 swLon-originLon | i16 swLat-originLat
                  | i16 seLon-swLon | i16 seLat-swLat | i16 neLon-swLon | i16 neLat-swLat | i16 nwLon-swLon | i16 nwLat-swLat
  exact LSDs: u8 m | u8 r | u8 t | u8 sec | u8 ls | i32 lon | i32 lat
"""
import json, struct, gzip, collections, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from validate import corners

Q = 1e5


def q(v):
    return int(round(v * Q))


def main():
    flagged = {tuple(x) for x in json.load(open("data/flagged.json"))}
    twp = collections.defaultdict(list)
    for line in open("data/sections.jsonl"):
        s = json.loads(line)
        r = s["ring"]
        if r[0] != r[-1]:
            r = r + [r[0]]
        sw, se, ne, nw = corners(r)
        twp[(s["m"], s["r"], s["t"])].append((s["s"], 1 if (s["m"], s["r"], s["t"], s["s"]) in flagged else 0,
                                              [(q(p[0]), q(p[1])) for p in (sw, se, ne, nw)]))
    exact = json.load(open("data/exact_lsds.json"))
    out = bytearray(b"LSD1")
    nsec = sum(len(v) for v in twp.values())
    out += struct.pack("<III", len(twp), nsec, len(exact))
    i16 = lambda v: struct.pack("<h", v)
    for key in sorted(twp):
        secs = sorted(twp[key])
        ox = min(c[0][0] for _, _, c in secs)
        oy = min(c[0][1] for _, _, c in secs)
        out += struct.pack("<BBBBii", key[0], key[1], key[2], len(secs), ox, oy)
        for sec, fl, c in secs:
            sw = c[0]
            vals = [sw[0] - ox, sw[1] - oy]
            for p in c[1:]:
                vals += [p[0] - sw[0], p[1] - sw[1]]
            assert all(-32768 <= v <= 32767 for v in vals), (key, sec, vals)
            out += struct.pack("<BB", sec, fl) + b"".join(i16(v) for v in vals)
    for m, r, t, s, ls, x, y in sorted(exact):
        out += struct.pack("<BBBBBii", m, r, t, s, ls, q(x), q(y))
    open("data/lsd.bin", "wb").write(out)
    gz = gzip.compress(bytes(out), 9)
    open("data/lsd.bin.gz", "wb").write(gz)
    print("townships", len(twp), "sections", nsec, "exact", len(exact), "raw", len(out), "gz", len(gz))


if __name__ == "__main__":
    main()
