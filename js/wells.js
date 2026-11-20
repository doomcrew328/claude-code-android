// LEASELINE — offline Alberta well database (AER ST37 + daily licence list).
// Decodes wells.bin (WEL3 columnar) + wellnames.txt; spatial grid, licence and UWI lookups.

const Q = 1e5;
export const H2S = ['Sweet', 'Sour (low)', 'Sour', 'Sour (high release)', 'Critical sour', '', 'Other', 'Historic'];

export class WellDB {
  constructor(buf, namesText, newWells) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== 'WEL3') throw new Error('Bad well database');
    const n = dv.getUint32(4, true), m = dv.getUint32(8, true), tl = dv.getUint32(12, true);
    this.t = JSON.parse(new TextDecoder().decode(u8.subarray(16, 16 + tl)));
    let o = 16 + tl; while (o % 4) o++;
    const col = () => { const L = dv.getUint32(o, true); const c = u8.subarray(o + 4, o + 4 + L); o += 4 + L; while (o % 4) o++; return c; };
    const vint = (c, count, signed) => {
      const out = new Int32Array(count); let p = 0;
      for (let i = 0; i < count; i++) { let v = 0, s = 0, b; do { b = c[p++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); out[i] = signed ? ((v % 2) ? -(v + 1) / 2 : v / 2) : v; }
      return out;
    };
    const dlat = vint(col(), n, true), dlon = vint(col(), n, true);
    this.lat = new Float64Array(n); this.lon = new Float64Array(n);
    let a = 0, b = 0; for (let i = 0; i < n; i++) { a += dlat[i]; b += dlon[i]; this.lat[i] = a / Q; this.lon[i] = b / Q; }
    this.lic = vint(col(), n, false); this.licSuf = col().slice();
    this.lice = vint(col(), n, false); this.stat = col().slice(); this.flag = col().slice();
    this.yStat = col().slice(); this.ySpud = col().slice(); this.yDrill = col().slice(); this.nbh = col().slice();
    this.bLe = col().slice(); this.bLsd = col().slice(); this.bSec = col().slice(); this.bTwp = col().slice(); this.bRge = col().slice(); this.bMer = col().slice(); this.bEs = col().slice();
    this.bDlat = vint(col(), m, true); this.bDlon = vint(col(), m, true); this.bTd = vint(col(), m, false);
    this.n = n; this.m = m;
    this.bStart = new Int32Array(n + 1); for (let i = 0, s = 0; i < n; i++) { this.bStart[i] = s; s += this.nbh[i]; this.bStart[i + 1] = s; }
    this.names = namesText ? namesText.split('\n') : [];
    // lookups
    this.byLic = new Map(); this.byUwi = new Map(); this.grid = new Map();
    for (let i = 0; i < n; i++) {
      this.byLic.set(this.licStr(i), i);
      const g = gk(this.lon[i], this.lat[i]); let arr = this.grid.get(g); if (!arr) this.grid.set(g, arr = []); arr.push(i);
      for (let j = this.bStart[i]; j < this.bStart[i + 1]; j++) this.byUwi.set(this.uwiKey(j), [i, j]);
    }
    // wells licensed since the ST37 snapshot (licence list): [lic, company, lat, lon, surf, status, statusDate]
    this.extra = (newWells || []).filter(w => !this.byLic.has(w[0]));
    this.extraByLic = new Map(this.extra.map((w, k) => [w[0], k]));
    this.extraGrid = new Map();
    this.extra.forEach((w, k) => { const g = gk(w[3], w[2]); let arr = this.extraGrid.get(g); if (!arr) this.extraGrid.set(g, arr = []); arr.push(k); });
  }
  licStr(i) { return String(this.lic[i]).padStart(7, '0') + (this.licSuf[i] ? String.fromCharCode(this.licSuf[i]) : ''); }
  uwiKey(j) { return `${this.t.les[this.bLe[j]]}/${p2(this.bLsd[j])}-${p2(this.bSec[j])}-${p3(this.bTwp[j])}-${p2(this.bRge[j])}W${this.bMer[j]}/${this.bEs[j]}`; }
  uwiLoc(j) { return { ls: this.bLsd[j], s: this.bSec[j], t: this.bTwp[j], r: this.bRge[j], m: this.bMer[j] }; }
  bh(j, i) { return [this.lon[i] + this.bDlon[j] / Q, this.lat[i] + this.bDlat[j] / Q]; }
  status(i) { return this.t.statuses[this.stat[i]]; }
  licensee(i) { return this.t.licensees[this.lice[i]]; }
  h2s(i) { return this.flag[i] & 7; }
  isPad(i) { return !!(this.flag[i] & 8); }

  // full record for a surface hole
  well(i) {
    const holes = [];
    for (let j = this.bStart[i]; j < this.bStart[i + 1]; j++) holes.push({ uwi: this.uwiKey(j), name: this.names[j] || '', td: this.bTd[j], bh: this.bh(j, i), loc: this.uwiLoc(j) });
    const y = (v) => v ? 1900 + v : null;
    return { src: 'st37', i, lic: this.licStr(i), licensee: this.licensee(i), status: this.status(i), statusYear: y(this.yStat[i]), spudYear: y(this.ySpud[i]), drillYear: y(this.yDrill[i]), h2s: this.h2s(i), pad: this.isPad(i), center: [this.lon[i], this.lat[i]], holes };
  }
  extraWell(k) {
    const w = this.extra[k];
    return { src: 'licence', lic: w[0], licensee: w[1].replace(/\([A-Z0-9]{4}\)$/, '').trim(), status: w[5], statusYear: +(w[6] || '').slice(-4) || null, center: [w[3], w[2]], surf: w[4], holes: [], h2s: 6, pad: false };
  }
  findLicence(q) {
    const s = q.replace(/^W\s*/i, '').trim().toUpperCase();
    const m = s.match(/^0*(\d{1,9})([A-Z]?)$/); if (!m) return null;
    const key = m[1].padStart(7, '0') + m[2];
    if (this.byLic.has(key)) return this.well(this.byLic.get(key));
    if (this.extraByLic.has(key)) return this.extraWell(this.extraByLic.get(key));
    return null;
  }
  findUwi(q) {
    const m = q.toUpperCase().replace(/\s+/g, '').match(/^1?([0-9A-Z]{2})\/(\d{1,2})-(\d{1,2})-(\d{1,3})-(\d{1,2})W(\d)(?:M)?\/(\d)$/);
    if (!m) return null;
    const key = `${m[1]}/${p2(+m[2])}-${p2(+m[3])}-${p3(+m[4])}-${p2(+m[5])}W${m[6]}/${m[7]}`;
    const hit = this.byUwi.get(key); if (!hit) return { notFound: key };
    const w = this.well(hit[0]); w.matchUwi = key; return w;
  }
  // bottom holes inside an LSD whose surface lease is somewhere else (horizontal / directional wells)
  bottomsIn(d) {
    const out = [];
    for (const [key, [i, j]] of this.byUwi) {
      if (this.bLsd[j] !== d.ls || this.bSec[j] !== d.s || this.bTwp[j] !== d.t || this.bRge[j] !== d.r || this.bMer[j] !== d.m) continue;
      out.push({ i, j, uwi: key });
    }
    return out;
  }
  inBox(w, s, e, n, limit = 4000) {
    const out = [], extra = [];
    for (let gx = Math.floor(w / G); gx <= Math.floor(e / G); gx++) for (let gy = Math.floor(s / G); gy <= Math.floor(n / G); gy++) {
      const k = gx * 100000 + gy;
      for (const i of this.grid.get(k) || []) { if (this.lon[i] >= w && this.lon[i] <= e && this.lat[i] >= s && this.lat[i] <= n) out.push(i); if (out.length > limit) return { out, extra }; }
      for (const x of this.extraGrid.get(k) || []) { const q = this.extra[x]; if (q[3] >= w && q[3] <= e && q[2] >= s && q[2] <= n) extra.push(x); }
    }
    return { out, extra };
  }
  // text search: licensee or well name, nearest first
  searchText(q, near, limit = 40) {
    const t = q.trim().toLowerCase(); if (t.length < 3) return [];
    const lic = new Set(); this.t.licensees.forEach((name, k) => { if (name.toLowerCase().includes(t)) lic.add(k); });
    const hits = [];
    for (let i = 0; i < this.n && hits.length < 5000; i++) {
      let ok = lic.has(this.lice[i]);
      if (!ok) for (let j = this.bStart[i]; j < this.bStart[i + 1]; j++) if ((this.names[j] || '').toLowerCase().includes(t)) { ok = true; break; }
      if (ok) hits.push(i);
    }
    const d = (i) => near ? (this.lon[i] - near[0]) ** 2 * 0.33 + (this.lat[i] - near[1]) ** 2 : 0;
    return hits.sort((a, b) => d(a) - d(b)).slice(0, limit).map(i => this.well(i));
  }
  nearest(p, maxM = 300) {
    let best = null, bd = Infinity;
    const g0 = Math.floor(p[0] / G), g1 = Math.floor(p[1] / G);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const k = (g0 + dx) * 100000 + g1 + dy;
      for (const i of this.grid.get(k) || []) { const d = m2(p, [this.lon[i], this.lat[i]]); if (d < bd) { bd = d; best = { kind: 'st37', i }; } }
      for (const x of this.extraGrid.get(k) || []) { const q = this.extra[x]; const d = m2(p, [q[3], q[2]]); if (d < bd) { bd = d; best = { kind: 'extra', x }; } }
    }
    if (!best || bd > maxM) return null;
    return best.kind === 'st37' ? this.well(best.i) : this.extraWell(best.x);
  }
}
const G = 0.05;
const gk = (lon, lat) => Math.floor(lon / G) * 100000 + Math.floor(lat / G);
const p2 = (v) => String(v).padStart(2, '0'), p3 = (v) => String(v).padStart(3, '0');
function m2(a, b) { const k = Math.cos(a[1] * Math.PI / 180); return Math.hypot((a[0] - b[0]) * 111320 * k, (a[1] - b[1]) * 110574); }

export async function loadWells(progress) {
  const fetchGz = async (url, isText, part) => {
    const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
    const total = +r.headers.get('content-length') || 0; let got = 0;
    const counted = r.body.pipeThrough(new TransformStream({ transform(c, ctl) { got += c.byteLength; if (total) progress?.(part, got / total); ctl.enqueue(c); } }));
    const buf = await new Response(counted).arrayBuffer();
    const u = new Uint8Array(buf);
    const raw = (u[0] === 0x1f && u[1] === 0x8b) ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : buf;
    return isText ? new TextDecoder().decode(raw) : raw;
  };
  const [bin, names, extra] = await Promise.all([
    fetchGz('data/wells.bin.gz', false, 0),
    fetchGz('data/wellnames.txt.gz', true, 1).catch(() => ''),
    fetch('data/wells_new.json').then(r => r.ok ? r.json() : []).catch(() => []),
  ]);
  return new WellDB(bin, names, extra);
}
