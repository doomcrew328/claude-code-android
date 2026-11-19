// LEASELINE — data layer: Alberta open-data roads/cutlines, on-device cache (IndexedDB), packs, tracks.
// Roads: Base Features Access & Facility Roads; Cutlines: Base Features Access.
// Government of Alberta — Open Government Licence – Alberta.

const ROADS = 'https://geospatial.alberta.ca/titan/rest/services/transportation/access_facility_roads/FeatureServer/0/query';
const CUTS = 'https://geospatial.alberta.ca/titan/rest/services/utility/access/MapServer/30/query';
export const CELL = 0.1; // degrees
export const MAJOR_TYPES = [3, 5, 6, 7, 8, 9];

// ---------- tiny IndexedDB helper ----------
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('leaseline', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['cells', 'cuts', 'tracks', 'kv']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
export async function idbGet(store, key) {
  try { const d = await db(); return await new Promise((res, rej) => { const q = d.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  catch { return undefined; }
}
export async function idbPut(store, key, val) {
  try { const d = await db(); await new Promise((res, rej) => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); return true; }
  catch { return false; }
}
export async function idbDel(store, key) {
  try { const d = await db(); await new Promise((res) => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).delete(key); t.oncomplete = res; t.onerror = res; }); } catch { }
}
export async function idbAll(store) {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const out = []; const q = d.transaction(store).objectStore(store).openCursor();
      q.onsuccess = () => { const c = q.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); };
      q.onerror = () => rej(q.error);
    });
  } catch { return []; }
}
export async function idbKeys(store) {
  try { const d = await db(); return await new Promise((res) => { const q = d.transaction(store).objectStore(store).getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); }); }
  catch { return []; }
}

// ---------- ArcGIS REST paging ----------
async function queryAll(url, params, pageSize, signal) {
  const feats = [];
  for (let offset = 0; offset < 40000; offset += pageSize) {
    const u = new URL(url);
    for (const [k, v] of Object.entries({ ...params, resultOffset: offset, resultRecordCount: pageSize, orderByFields: 'OBJECTID', f: 'geojson', outSR: 4326, inSR: 4326 })) u.searchParams.set(k, v);
    const r = await fetch(u, { signal });
    if (!r.ok) throw new Error('Alberta server ' + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'query error');
    const f = j.features || [];
    feats.push(...f);
    const more = j.exceededTransferLimit || (j.properties && j.properties.exceededTransferLimit) || f.length === pageSize;
    if (!more) break;
  }
  return feats;
}

const env = (w, s, e, n) => ({ geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects' });
const slim = (f, keep) => ({ type: 'Feature', id: f.id ?? f.properties?.OBJECTID, properties: keep(f.properties || {}), geometry: f.geometry });

export function cellId(gx, gy) { return `${gx}_${gy}`; }
export function cellsFor(w, s, e, n) {
  const out = [];
  for (let gx = Math.floor(w / CELL); gx <= Math.floor(e / CELL); gx++)
    for (let gy = Math.floor(s / CELL); gy <= Math.floor(n / CELL); gy++) out.push([gx, gy]);
  return out;
}
const cellBox = (gx, gy) => [gx * CELL, gy * CELL, (gx + 1) * CELL, (gy + 1) * CELL];

// ---------- road / cutline cells (fetched once, kept on device) ----------
const mem = { cells: new Map(), cuts: new Map() };
const inflight = new Map();
const MAX_AGE = 1000 * 60 * 60 * 24 * 45;

async function loadCell(kind, gx, gy, online) {
  const id = cellId(gx, gy), cache = mem[kind];
  if (cache.has(id)) return cache.get(id);
  const key = kind + id;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const stored = await idbGet(kind, id);
    if (stored && (Date.now() - stored.ts < MAX_AGE || !online)) { cache.set(id, stored); return stored; }
    if (!online) return null;
    const [w, s, e, n] = cellBox(gx, gy);
    let feats;
    if (kind === 'cells') {
      feats = (await queryAll(ROADS, { where: '1=1', ...env(w, s, e, n), outFields: 'OBJECTID,FEATURE_TYPE,NAME', maxAllowableOffset: 0.00002, geometryPrecision: 6 }, 2000))
        .map(f => slim(f, p => ({ ft: p.FEATURE_TYPE, name: p.NAME || '' })));
    } else {
      feats = (await queryAll(CUTS, { where: '1=1', ...env(w, s, e, n), outFields: 'OBJECTID', maxAllowableOffset: 0.00003, geometryPrecision: 6 }, 1000))
        .map(f => slim(f, () => ({})));
    }
    const rec = { ts: Date.now(), feats };
    await idbPut(kind, id, rec);
    cache.set(id, rec);
    return rec;
  })().catch(err => { console.warn('cell', kind, id, err); return stored_or_null(kind, id); }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
async function stored_or_null(kind, id) { const s = await idbGet(kind, id); if (s) mem[kind].set(id, s); return s || null; }

export async function roadsIn(w, s, e, n, online, kind = 'cells', limit = 64) {
  const cells = cellsFor(w, s, e, n).slice(0, limit);
  const recs = await Promise.all(cells.map(([x, y]) => loadCell(kind, x, y, online)));
  return dedupe(recs.filter(Boolean).flatMap(r => r.feats));
}
export function dedupe(feats) {
  const seen = new Set(), out = [];
  for (const f of feats) { const k = f.id; if (k != null && seen.has(k)) continue; seen.add(k); out.push(f); }
  return out;
}
export async function cachedCellCount() { return (await idbKeys('cells')).length; }

// Major roads for a long corridor (routing from town to lease)
export async function majorsIn(w, s, e, n, online) {
  const key = 'maj_' + [w, s, e, n].map(v => v.toFixed(2)).join('_');
  const stored = await idbGet('kv', key);
  if (stored && (!online || Date.now() - stored.ts < MAX_AGE)) return stored.feats;
  if (!online) return [];
  const feats = (await queryAll(ROADS, { where: `FEATURE_TYPE IN (${MAJOR_TYPES.join(',')})`, ...env(w, s, e, n), outFields: 'OBJECTID,FEATURE_TYPE,NAME', maxAllowableOffset: 0.00008, geometryPrecision: 5 }, 2000))
    .map(f => slim(f, p => ({ ft: p.FEATURE_TYPE, name: p.NAME || '' })));
  await idbPut('kv', key, { ts: Date.now(), feats });
  return feats;
}
// Everything already on the device inside a box (offline routing)
export async function allCachedRoadsIn(w, s, e, n) {
  const out = [];
  for (const [gx, gy] of cellsFor(w, s, e, n)) {
    const id = cellId(gx, gy);
    const rec = mem.cells.get(id) || await idbGet('cells', id);
    if (rec) out.push(...rec.feats);
  }
  for (const [k, v] of await idbAll('kv')) if (String(k).startsWith('maj_')) out.push(...v.feats);
  return dedupe(out);
}

// ---------- official LSD outline (online refinement) ----------
const LSDQ = 'https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer/5/query';
export async function officialLsd(d) {
  const u = new URL(LSDQ);
  const where = `M=${d.m} AND RGE=${d.r} AND TWP=${d.t} AND SEC=${d.s} AND LS=${d.ls} AND RA=' '`;
  for (const [k, v] of Object.entries({ where, outFields: 'DESCRIPTOR', outSR: 4326, f: 'geojson' })) u.searchParams.set(k, v);
  const r = await fetch(u); const j = await r.json();
  return (j.features || [])[0] || null;
}

// ---------- weather (Open-Meteo, free, no key) ----------
export async function leaseWeather(lat, lon) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  const p = { latitude: lat.toFixed(4), longitude: lon.toFixed(4), current: 'temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,weather_code,precipitation', daily: 'precipitation_sum,snowfall_sum,temperature_2m_max,temperature_2m_min,weather_code', past_days: 3, forecast_days: 3, timezone: 'America/Edmonton', wind_speed_unit: 'kmh' };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  const r = await fetch(u); if (!r.ok) throw new Error('weather ' + r.status);
  const j = await r.json(); await idbPut('kv', 'wx_last', { ts: Date.now(), lat, lon, j });
  return j;
}

// ---------- GPX ----------
export function toGPX(name, pts) {
  const esc = s => String(s).replace(/[<&>"]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
  const seg = pts.map(p => `<trkpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}">${p[2] ? `<time>${new Date(p[2]).toISOString()}</time>` : ''}</trkpt>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="LEASELINE" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(name)}</name><trkseg>${seg}</trkseg></trk></gpx>`;
}
export function fromGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const tracks = [];
  const name = doc.querySelector('trk > name, metadata > name')?.textContent || 'Imported track';
  const pts = [...doc.querySelectorAll('trkpt, rtept')].map(n => [parseFloat(n.getAttribute('lon')), parseFloat(n.getAttribute('lat'))]).filter(p => isFinite(p[0]) && isFinite(p[1]));
  if (pts.length > 1) tracks.push({ name, pts });
  const wpts = [...doc.querySelectorAll('wpt')].map(n => ({ name: n.querySelector('name')?.textContent || 'Waypoint', lon: parseFloat(n.getAttribute('lon')), lat: parseFloat(n.getAttribute('lat')) }));
  return { tracks, wpts };
}
