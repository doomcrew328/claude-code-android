// LEASELINE — on-device router over Alberta's road network (+ your own recorded tracks).
// Works with no signal: A* over whatever road data is cached on the phone.

const R = 6371008.8, D2R = Math.PI / 180;
export function dist(a, b) {
  const dLat = (b[1] - a[1]) * D2R, dLon = (b[0] - a[0]) * D2R;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
export function bearing(a, b) {
  const y = Math.sin((b[0] - a[0]) * D2R) * Math.cos(b[1] * D2R);
  const x = Math.cos(a[1] * D2R) * Math.sin(b[1] * D2R) - Math.sin(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.cos((b[0] - a[0]) * D2R);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

// km/h by Alberta FEATURE_TYPE
export const ROAD_TYPES = {
  1: { name: 'ferry crossing', kmh: 5 },
  2: { name: 'ford / winter crossing', kmh: 8 },
  3: { name: 'ramp', kmh: 60 },
  4: { name: 'one-lane gravel', kmh: 45 },
  5: { name: 'two-lane gravel', kmh: 70 },
  6: { name: 'divided highway', kmh: 105 },
  7: { name: 'one-lane paved', kmh: 55 },
  8: { name: 'two-lane paved', kmh: 90 },
  9: { name: 'four-lane paved', kmh: 95 },
  10: { name: 'driveway / lease access', kmh: 15 },
  12: { name: 'winter road', kmh: 25 },
  14: { name: 'dry-weather road', kmh: 25 },
  99: { name: 'your recorded track', kmh: 20 },
};
const MAX_KMH = 105;

export class Graph {
  constructor() {
    this.x = []; this.y = []; this.adj = []; this.key = new Map();
    this.grid = new Map(); // ~200 m buckets for snapping
  }
  _node(lon, lat) {
    const k = Math.round(lon * 1e5) * 1e8 + Math.round(lat * 1e5);
    let i = this.key.get(k);
    if (i === undefined) {
      i = this.x.length; this.x.push(lon); this.y.push(lat); this.adj.push([]); this.key.set(k, i);
      const g = gkey(lon, lat); let a = this.grid.get(g); if (!a) this.grid.set(g, a = []); a.push(i);
    }
    return i;
  }
  _edge(a, b, ft, name) {
    if (a === b) return;
    const d = dist([this.x[a], this.y[a]], [this.x[b], this.y[b]]);
    const kmh = (ROAD_TYPES[ft] || ROAD_TYPES[4]).kmh;
    const w = d / (kmh / 3.6);
    this.adj[a].push({ to: b, d, w, ft, name }); this.adj[b].push({ to: a, d, w, ft, name });
  }
  addLine(coords, ft, name) {
    let prev = -1;
    for (const c of coords) { const i = this._node(c[0], c[1]); if (prev >= 0) this._edge(prev, i, ft, name); prev = i; }
    return prev;
  }
  addFeatures(feats) {
    for (const f of feats) {
      const g = f.geometry; if (!g) continue;
      const ft = f.properties?.ft ?? 4, name = f.properties?.name || '';
      if (ft === 1) continue; // never route over ferries
      if (g.type === 'LineString') this.addLine(g.coordinates, ft, name);
      else if (g.type === 'MultiLineString') for (const l of g.coordinates) this.addLine(l, ft, name);
    }
  }
  // Join dangling ends that stop just short of another road (data gaps of a few metres)
  stitch(tol = 12) {
    let joins = 0;
    for (let i = 0; i < this.x.length; i++) {
      if (this.adj[i].length !== 1) continue;
      const p = [this.x[i], this.y[i]];
      let best = -1, bd = tol;
      for (const j of this.near(p[0], p[1])) {
        if (j === i || this.adj[i].some(e => e.to === j)) continue;
        const d = dist(p, [this.x[j], this.y[j]]); if (d < bd) { bd = d; best = j; }
      }
      if (best >= 0) { this._edge(i, best, this.adj[i][0].ft, this.adj[i][0].name); joins++; }
    }
    return joins;
  }
  near(lon, lat) {
    const out = [], gx = Math.floor(lon / 0.003), gy = Math.floor(lat / 0.002);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = this.grid.get((gx + dx) * 1e6 + gy + dy); if (a) out.push(...a); }
    return out;
  }
  // Nearest point on any edge to p (searches outward)
  snap(p, maxM = 3000) {
    let best = null;
    for (let ring = 1; ring <= 40; ring++) {
      const gx = Math.floor(p[0] / 0.003), gy = Math.floor(p[1] / 0.002);
      const cand = new Set();
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring && ring > 1) continue;
        const a = this.grid.get((gx + dx) * 1e6 + gy + dy); if (a) for (const i of a) cand.add(i);
      }
      for (const i of cand) for (const e of this.adj[i]) {
        if (e.to < i) continue;
        const q = projectOnSeg(p, [this.x[i], this.y[i]], [this.x[e.to], this.y[e.to]]);
        const d = dist(p, q.pt);
        if (!best || d < best.d) best = { d, pt: q.pt, a: i, b: e.to, t: q.t, ft: e.ft, name: e.name };
      }
      const ringM = ring * 140; // smallest cell side ≈ 190 m at 55°N
      if (best && best.d < ringM) break;
      if (ringM > maxM) break;
    }
    return best && best.d <= maxM ? best : null;
  }
  get size() { return { nodes: this.x.length, edges: this.adj.reduce((s, a) => s + a.length, 0) / 2 }; }
}
const gkey = (lon, lat) => Math.floor(lon / 0.003) * 1e6 + Math.floor(lat / 0.002);

function projectOnSeg(p, a, b) {
  const k = Math.cos(p[1] * D2R);
  const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
  return { t, pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
}

class Heap {
  constructor() { this.a = []; }
  push(n, f) { const a = this.a; a.push([f, n]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; }
}

// Route from point `from` to point `to`. Returns null if no connected road path.
export function route(g, from, to) {
  const s = g.snap(from, 2500), t = g.snap(to, 6000);
  if (!s || !t) return { error: !s ? 'No mapped road near you yet' : 'No mapped road near the lease', s, t };
  // virtual nodes: S = n, T = n+1
  const n = g.x.length, S = n, T = n + 1;
  const ex = new Map(); // extra adjacency for virtual nodes
  const add = (u, v, d, ft, name) => { const kmh = (ROAD_TYPES[ft] || ROAD_TYPES[4]).kmh, w = d / (kmh / 3.6); (ex.get(u) || ex.set(u, []).get(u)).push({ to: v, d, w, ft, name }); };
  const px = (i) => i === S ? s.pt : i === T ? t.pt : [g.x[i], g.y[i]];
  for (const [V, sn] of [[S, s], [T, t]]) {
    const pa = [g.x[sn.a], g.y[sn.a]], pb = [g.x[sn.b], g.y[sn.b]];
    add(V, sn.a, dist(sn.pt, pa), sn.ft, sn.name); add(sn.a, V, dist(sn.pt, pa), sn.ft, sn.name);
    add(V, sn.b, dist(sn.pt, pb), sn.ft, sn.name); add(sn.b, V, dist(sn.pt, pb), sn.ft, sn.name);
  }
  if ((s.a === t.a && s.b === t.b) || (s.a === t.b && s.b === t.a)) add(S, T, dist(s.pt, t.pt), s.ft, s.name);
  const gS = new Float64Array(n + 2).fill(Infinity), prev = new Int32Array(n + 2).fill(-1), prevE = new Array(n + 2);
  const h = (i) => dist(px(i), t.pt) / (MAX_KMH / 3.6);
  const heap = new Heap(); gS[S] = 0; heap.push(S, h(S));
  const closed = new Uint8Array(n + 2);
  let iters = 0;
  while (heap.size) {
    const [, u] = heap.pop();
    if (closed[u]) continue; closed[u] = 1;
    if (u === T) break;
    if (++iters > 900000) break;
    const edges = u < n ? (ex.has(u) ? g.adj[u].concat(ex.get(u)) : g.adj[u]) : ex.get(u) || [];
    for (const e of edges) {
      const nd = gS[u] + e.w;
      if (nd < gS[e.to]) { gS[e.to] = nd; prev[e.to] = u; prevE[e.to] = e; heap.push(e.to, nd + h(e.to)); }
    }
  }
  if (!isFinite(gS[T])) return { error: 'Roads near you and near the lease aren’t connected in the map data', s, t };
  const path = [], segs = [];
  for (let v = T; v !== -1; v = prev[v]) { path.push(px(v)); if (prevE[v]) segs.push(prevE[v]); }
  path.reverse(); segs.reverse();
  const nodesSeq = []; for (let v = T; v !== -1; v = prev[v]) nodesSeq.push(v); nodesSeq.reverse();
  const meters = segs.reduce((a, e) => a + e.d, 0);
  return { path, segs, nodes: nodesSeq, meters, seconds: gS[T], snapStart: s, snapEnd: t, steps: buildSteps(g, path, segs, nodesSeq, n), lastMile: dist(t.pt, to) };
}

// ---- turn instructions with odometer km (how lease directions are written) ----
function turnWord(delta) {
  const a = Math.abs(delta), side = delta < 0 ? 'left' : 'right';
  if (a < 20) return null;
  if (a < 45) return { verb: `Keep ${side}`, icon: delta < 0 ? 'slight-left' : 'slight-right' };
  if (a < 125) return { verb: `Turn ${side}`, icon: side };
  if (a < 165) return { verb: `Sharp ${side}`, icon: delta < 0 ? 'sharp-left' : 'sharp-right' };
  return { verb: 'Make a U-turn', icon: 'uturn' };
}
function pointAlong(path, i, dir, meters) {
  let acc = 0, j = i;
  while (j + dir >= 0 && j + dir < path.length) { acc += dist(path[j], path[j + dir]); j += dir; if (acc >= meters) break; }
  return path[j];
}
function buildSteps(g, path, segs, nodes, n) {
  const steps = []; let km = 0;
  const label = (e) => (e.name ? e.name + ' · ' : '') + (ROAD_TYPES[e.ft] || ROAD_TYPES[4]).name;
  steps.push({ km: 0, at: path[0], icon: 'start', text: `Head ${compass(bearing(path[0], pointAlong(path, 0, 1, 40)))} on ${label(segs[0] || { ft: 4 })}` });
  for (let i = 1; i < path.length - 1; i++) {
    km += segs[i - 1].d / 1000;
    const v = nodes[i];
    const deg = v < n ? g.adj[v].length : 2;
    const ein = segs[i - 1], eout = segs[i];
    const bin = bearing(pointAlong(path, i, -1, 25), path[i]);
    const bout = bearing(path[i], pointAlong(path, i, 1, 25));
    const delta = ((bout - bin + 540) % 360) - 180;
    const tw = turnWord(delta);
    const changed = ein.ft !== eout.ft || (ein.name || '') !== (eout.name || '');
    if (deg >= 3 && tw) steps.push({ km, at: path[i], icon: tw.icon, text: `${tw.verb} onto ${label(eout)}`, delta });
    else if (deg >= 3 && changed && (eout.name || ROAD_TYPES[eout.ft]?.name !== ROAD_TYPES[ein.ft]?.name)) steps.push({ km, at: path[i], icon: 'straight', text: `Continue onto ${label(eout)}` });
  }
  km += segs.length ? segs[segs.length - 1].d / 1000 : 0;
  steps.push({ km, at: path[path.length - 1], icon: 'arrive', text: 'Arrive — closest mapped road to the lease' });
  // merge steps closer than 30 m (data noise at junction clusters)
  return steps.filter((s, i) => i === 0 || i === steps.length - 1 || (s.km - steps[i - 1].km) * 1000 > 30 || s.icon !== 'straight');
}
export function compass(b) { return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(b / 45) % 8]; }
export function compassShort(b) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8]; }

// Progress along a route polyline: distance travelled + distance off the line
export function progressOn(path, cum, p) {
  let best = { off: Infinity, along: 0, i: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    const q = projectOnSeg(p, path[i], path[i + 1]);
    const d = dist(p, q.pt);
    if (d < best.off) best = { off: d, along: cum[i] + q.t * (cum[i + 1] - cum[i]), i };
  }
  return best;
}
export function cumulative(path) { const c = [0]; for (let i = 1; i < path.length; i++) c.push(c[i - 1] + dist(path[i - 1], path[i])); return c; }
