// LEASELINE — offline Alberta Township System engine.
// Decodes lsd.bin (all 252,578 ATS sections + exact centres for irregular sections)
// Data: Government of Alberta, ATS v4.1, Open Government Licence – Alberta.

const Q = 1e5;

export class LsdDB {
  constructor(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'LSD1') throw new Error('Bad LSD database');
    const nT = dv.getUint32(4, true), nS = dv.getUint32(8, true), nE = dv.getUint32(12, true);
    this.nSections = nS;
    // Section table: key -> index; corners in Float64 arrays (lon,lat) x4 (sw,se,ne,nw)
    this.keys = new Int32Array(nS);
    this.c = new Float64Array(nS * 8);
    this.flags = new Uint8Array(nS);
    this.index = new Map();
    let o = 16, si = 0;
    for (let t = 0; t < nT; t++) {
      const m = dv.getUint8(o), r = dv.getUint8(o + 1), tw = dv.getUint8(o + 2), cnt = dv.getUint8(o + 3);
      const ox = dv.getInt32(o + 4, true), oy = dv.getInt32(o + 8, true);
      o += 12;
      for (let k = 0; k < cnt; k++) {
        const sec = dv.getUint8(o), fl = dv.getUint8(o + 1);
        const swx = ox + dv.getInt16(o + 2, true), swy = oy + dv.getInt16(o + 4, true);
        const b = si * 8;
        this.c[b] = swx / Q; this.c[b + 1] = swy / Q;
        for (let j = 0; j < 3; j++) {
          this.c[b + 2 + j * 2] = (swx + dv.getInt16(o + 6 + j * 4, true)) / Q;
          this.c[b + 3 + j * 2] = (swy + dv.getInt16(o + 8 + j * 4, true)) / Q;
        }
        o += 18;
        const key = secKey(m, r, tw, sec);
        this.keys[si] = key; this.flags[si] = fl; this.index.set(key, si);
        si++;
      }
    }
    this.exact = new Map();
    for (let e = 0; e < nE; e++) {
      const m = dv.getUint8(o), r = dv.getUint8(o + 1), tw = dv.getUint8(o + 2), s = dv.getUint8(o + 3), ls = dv.getUint8(o + 4);
      this.exact.set(secKey(m, r, tw, s) * 32 + ls, [dv.getInt32(o + 5, true) / Q, dv.getInt32(o + 9, true) / Q]);
      o += 13;
    }
    this._buildGrid();
  }

  _buildGrid() {
    // 0.05° buckets for point -> section lookup and viewport queries
    this.grid = new Map();
    const n = this.nSections;
    this.bbox = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      const b = i * 8; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let j = 0; j < 4; j++) { const x = this.c[b + j * 2], y = this.c[b + j * 2 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      this.bbox.set([x0, y0, x1, y1], i * 4);
      for (let gx = Math.floor(x0 / 0.05); gx <= Math.floor(x1 / 0.05); gx++)
        for (let gy = Math.floor(y0 / 0.05); gy <= Math.floor(y1 / 0.05); gy++) {
          const k = gx * 100000 + gy; let a = this.grid.get(k); if (!a) { a = []; this.grid.set(k, a); } a.push(i);
        }
    }
  }

  corners(i) { const b = i * 8, c = this.c; return [[c[b], c[b + 1]], [c[b + 2], c[b + 3]], [c[b + 4], c[b + 5]], [c[b + 6], c[b + 7]]]; }
  find(m, r, t, s) { const i = this.index.get(secKey(m, r, t, s)); return i === undefined ? -1 : i; }
  decode(i) { const k = this.keys[i]; return { m: (k >> 20) & 15, r: (k >> 13) & 127, t: (k >> 6) & 127, s: k & 63 }; }

  // ---- forward: legal description -> location ----
  locate(d) {
    const i = this.find(d.m, d.r, d.t, d.s);
    if (i < 0) return { error: `Section ${d.s}-${d.t}-${d.r}-W${d.m} isn't in the Alberta grid` };
    const c = this.corners(i), irregular = !!this.flags[i];
    if (d.ls) {
      const ex = this.exact.get(this.keys[i] * 32 + d.ls);
      const [u, v] = lsdUV(d.ls);
      const quad = cellQuad(c, u - 0.125, v - 0.125, u + 0.125, v + 0.125);
      if (irregular) {
        if (!ex) return { error: `LSD ${d.ls} doesn't exist in that section (fractional section)` };
        return { kind: 'LSD', center: ex, quad: shiftQuad(quad, ex), exact: true, irregular, label: fmtLSD(d) };
      }
      return { kind: 'LSD', center: bilinear(c, u, v), quad, exact: true, irregular, label: fmtLSD(d) };
    }
    if (d.qs) {
      const [u0, v0] = { SE: [0.5, 0], SW: [0, 0], NW: [0, 0.5], NE: [0.5, 0.5] }[d.qs];
      return { kind: 'QS', center: bilinear(c, u0 + 0.25, v0 + 0.25), quad: cellQuad(c, u0, v0, u0 + 0.5, v0 + 0.5), irregular, label: fmtLSD(d) };
    }
    return { kind: 'SEC', center: bilinear(c, 0.5, 0.5), quad: c, irregular, label: fmtLSD(d) };
  }

  // ---- reverse: point -> LSD ----
  whereIs(lon, lat) {
    const cand = this.grid.get(Math.floor(lon / 0.05) * 100000 + Math.floor(lat / 0.05)) || [];
    let best = -1, bestD = 1e9;
    for (const i of cand) {
      const c = this.corners(i);
      if (pointInQuad(lon, lat, c)) { best = i; bestD = 0; break; }
      const b = i * 4, cx = (this.bbox[b] + this.bbox[b + 2]) / 2, cy = (this.bbox[b + 1] + this.bbox[b + 3]) / 2;
      const dd = (cx - lon) ** 2 + (cy - lat) ** 2; if (dd < bestD) { bestD = dd; best = i; }
    }
    if (best < 0) return null;
    const onGrid = bestD === 0;
    const d = this.decode(best), c = this.corners(best);
    let ls;
    if (this.flags[best]) {
      let bd = 1e9;
      for (let n = 1; n <= 16; n++) { const e = this.exact.get(this.keys[best] * 32 + n); if (!e) continue; const q = (e[0] - lon) ** 2 + (e[1] - lat) ** 2; if (q < bd) { bd = q; ls = n; } }
    }
    if (!ls) {
      const [u, v] = invBilinear(c, lon, lat);
      const col = clamp(Math.floor(u * 4), 0, 3), row = clamp(Math.floor(v * 4), 0, 3);
      ls = uvToLsd(col, row);
    }
    const out = { ...d, ls, onGrid };
    out.label = fmtLSD(out);
    return out;
  }

  // ---- grid lines for the map (sections + LSD subdivisions) ----
  gridGeoJSON(w, s, e, n, withLsd) {
    const feats = [], seen = new Set();
    for (let gx = Math.floor(w / 0.05); gx <= Math.floor(e / 0.05); gx++)
      for (let gy = Math.floor(s / 0.05); gy <= Math.floor(n / 0.05); gy++) {
        for (const i of this.grid.get(gx * 100000 + gy) || []) {
          if (seen.has(i)) continue; seen.add(i);
          const b = i * 4; if (this.bbox[b] > e || this.bbox[b + 2] < w || this.bbox[b + 1] > n || this.bbox[b + 3] < s) continue;
          const c = this.corners(i), d = this.decode(i);
          feats.push({ type: 'Feature', properties: { k: 'sec', label: `${d.s}` , full: `${d.s}-${d.t}-${d.r}-W${d.m}` }, geometry: { type: 'Polygon', coordinates: [[...c, c[0]]] } });
          if (withLsd && !this.flags[i]) {
            for (const f of [0.25, 0.5, 0.75]) {
              feats.push(line(bilinear(c, f, 0), bilinear(c, f, 1), f === 0.5 ? 'qs' : 'lsd'));
              feats.push(line(bilinear(c, 0, f), bilinear(c, 1, f), f === 0.5 ? 'qs' : 'lsd'));
            }
            for (let n = 1; n <= 16; n++) { const [u, v] = lsdUV(n); feats.push({ type: 'Feature', properties: { k: 'lsdlabel', label: String(n) }, geometry: { type: 'Point', coordinates: bilinear(c, u, v) } }); }
          }
          if (seen.size > 6000) return { type: 'FeatureCollection', features: feats };
        }
      }
    return { type: 'FeatureCollection', features: feats };
  }
}

function line(a, b, k) { return { type: 'Feature', properties: { k }, geometry: { type: 'LineString', coordinates: [a, b] } }; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function secKey(m, r, t, s) { return (m << 20) | (r << 13) | (t << 6) | s; }

// LSD numbering: 1 at SE corner, serpentine westward then north (1-4 / 5-8 / 9-12 / 13-16)
export function lsdUV(n) {
  const row = Math.floor((n - 1) / 4), k = (n - 1) % 4;
  const col = row % 2 === 0 ? 3 - k : k;
  return [(col + 0.5) / 4, (row + 0.5) / 4];
}
function uvToLsd(col, row) { return row * 4 + (row % 2 === 0 ? 3 - col : col) + 1; }

export function bilinear(c, u, v) {
  const [sw, se, ne, nw] = c;
  return [
    (1 - u) * (1 - v) * sw[0] + u * (1 - v) * se[0] + u * v * ne[0] + (1 - u) * v * nw[0],
    (1 - u) * (1 - v) * sw[1] + u * (1 - v) * se[1] + u * v * ne[1] + (1 - u) * v * nw[1],
  ];
}
function cellQuad(c, u0, v0, u1, v1) { return [bilinear(c, u0, v0), bilinear(c, u1, v0), bilinear(c, u1, v1), bilinear(c, u0, v1)]; }
function shiftQuad(q, center) {
  const cx = (q[0][0] + q[2][0]) / 2, cy = (q[0][1] + q[2][1]) / 2;
  return q.map(p => [p[0] - cx + center[0], p[1] - cy + center[1]]);
}
function pointInQuad(x, y, c) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = c[i][0], yi = c[i][1], xj = c[j][0], yj = c[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function invBilinear(c, x, y) {
  // Newton iterations; sections are near-rectangular so this converges in 2-3 steps
  let u = 0.5, v = 0.5;
  for (let it = 0; it < 8; it++) {
    const p = bilinear(c, u, v);
    const [sw, se, ne, nw] = c;
    const dxu = (1 - v) * (se[0] - sw[0]) + v * (ne[0] - nw[0]), dyu = (1 - v) * (se[1] - sw[1]) + v * (ne[1] - nw[1]);
    const dxv = (1 - u) * (nw[0] - sw[0]) + u * (ne[0] - se[0]), dyv = (1 - u) * (nw[1] - sw[1]) + u * (ne[1] - se[1]);
    const det = dxu * dyv - dxv * dyu; if (Math.abs(det) < 1e-18) break;
    const ex = x - p[0], ey = y - p[1];
    u += (ex * dyv - ey * dxv) / det; v += (ey * dxu - ex * dyu) / det;
  }
  return [u, v];
}

const pad = (n, w) => String(n).padStart(w, '0');
export function fmtLSD(d) {
  const tail = `${pad(d.s, 2)}-${pad(d.t, 3)}-${pad(d.r, 2)} W${d.m}`;
  if (d.ls) return `${pad(d.ls, 2)}-${tail}`;
  if (d.qs) return `${d.qs} ${tail}`;
  return `SEC ${tail}`;
}

// ---- input parsing: LSD, UWI, quarter, section, lat/long ----
export function parseQuery(raw) {
  let q = raw.trim().toUpperCase().replace(/[–—]/g, '-');
  if (!q) return null;
  // lat/long (decimal degrees)
  const ll = q.match(/^\s*(-?\d{2}\.\d+)\s*[, ]\s*(-?\d{2,3}\.\d+)\s*$/);
  if (ll) {
    let a = parseFloat(ll[1]), b = parseFloat(ll[2]);
    if (Math.abs(a) > 90) [a, b] = [b, a];
    if (b > 0) b = -b; // Alberta is west longitude
    return { kind: 'LL', lat: a, lon: b };
  }
  // DMS e.g. 54°51'41"N 115°28'04"W
  const dms = q.match(/(\d+)[°\s]+(\d+)['\s]+([\d.]+)"?\s*N?[,\s]+(\d+)[°\s]+(\d+)['\s]+([\d.]+)"?\s*W?/);
  if (dms) {
    const lat = +dms[1] + dms[2] / 60 + dms[3] / 3600, lon = -(+dms[4] + dms[5] / 60 + dms[6] / 3600);
    return { kind: 'LL', lat, lon };
  }
  // UWI: 100/11-04-068-10W5/00  -> strip location exception + event sequence
  q = q.replace(/^\s*1?\d{2}\s*\/\s*/, '').replace(/\s*\/\s*\d{1,2}\s*$/, '');
  q = q.replace(/\bLSD\b|\bSEC(TION)?\b|\bTWP\b|\bTOWNSHIP\b|\bRGE\b|\bRANGE\b|\bMER(IDIAN)?\b/g, ' ');
  // meridian written as W4/W5/W6 (not the W of a NW/SW quarter)
  const merW = q.match(/(?<![NS])W\s*(\d)\s*M?\b/);
  if (merW && !/[4-6]/.test(merW[1])) return { error: `W${merW[1]} is outside Alberta — this app covers W4, W5 and W6` };
  let m = merW ? +merW[1] : null;
  const body = merW ? q.slice(0, merW.index) + ' ' + q.slice(merW.index + merW[0].length) : q;
  const qsM = body.match(/\b(NE|NW|SE|SW)\b/);
  let nums = (body.replace(/\b(NE|NW|SE|SW)\b/, ' ').match(/\d+/g) || []).map(Number);
  let guessedMer = false;
  if (!m && nums.length >= 4 && nums[nums.length - 1] >= 4 && nums[nums.length - 1] <= 6) {
    m = nums.pop(); guessedMer = true; // e.g. 11-04-068-10-5
  }
  if (!m) return nums.length >= 3 ? { error: 'Add the meridian, e.g. W5' } : null;
  let d;
  if (nums.length >= 4) d = { ls: nums[0], s: nums[1], t: nums[2], r: nums[3], m };
  else if (nums.length === 3) d = { s: nums[0], t: nums[1], r: nums[2], m, qs: qsM ? qsM[1] : undefined };
  else return { error: 'Need LSD-SEC-TWP-RGE W#, e.g. 11-04-068-10 W5' };
  const bad = (d.ls !== undefined && (d.ls < 1 || d.ls > 16)) ? 'LSD must be 1–16'
    : (d.s < 1 || d.s > 36) ? 'Section must be 1–36'
    : (d.t < 1 || d.t > 126) ? 'Township must be 1–126'
    : (d.r < 1 || d.r > 30) ? 'Range must be 1–30' : null;
  if (bad) return { error: guessedMer ? 'Add the meridian, e.g. W5' : bad };
  return { kind: 'DLS', ...d };
}
