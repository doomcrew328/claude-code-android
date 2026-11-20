// LEASELINE v2 — wells & facilities, road-reach check, site notes + crew links, trips,
// rig activity, nearest hospital, place search, geo-stamped photos.
import { loadWells, H2S } from './wells.js';
import { parseQuery } from './lsd.js';
import { dist, bearing, compassShort, Graph } from './route.js';
import * as D from './data.js';

let A;            // app API
let W = null;     // WellDB
let wellsState = 'idle';
let rigs = [], places = [], hospitals = [];
let selWell = null;
window.__V2 = { get W() { return W; }, get rigs() { return rigs; }, get places() { return places; } };

export async function init(api) {
  A = api;
  const S = A.S;
  S.prefs = Object.assign({ wells: true, rigs: true }, S.prefs);
  S.trip = A.store.get('trip', { stops: [], fromMode: 'gps', fromText: '' });
  S.followRigs = A.store.get('followRigs', []);
  addLayers();
  // small offline lookups
  fetch('data/places.json').then(r => r.json()).then(j => { places = j; }).catch(() => { });
  fetch('data/hospitals.json').then(r => r.json()).then(j => { hospitals = j; }).catch(() => { });
  fetch('data/rigs.json', { cache: 'no-cache' }).then(r => r.json()).then(j => { rigs = j; checkFollowed(); A.refresh(); }).catch(() => { });
  // the well database is large: load it once the app is up
  setTimeout(() => ensureWells(false), 1500);
  // crew link import (?site=...)
  const site = new URLSearchParams(location.search).get('site');
  if (site) setTimeout(() => importSite(site), 900);
}

// ---------------- map layers ----------------
function addLayers() {
  const m = A.S.map;
  const go = () => {
    if (m.getSource('wells')) return;
    m.addSource('wells', { type: 'geojson', data: A.fc() });
    m.addSource('rigs', { type: 'geojson', data: A.fc() });
    m.addSource('sel', { type: 'geojson', data: A.fc() });
    const before = m.getLayer('route-glow') ? 'route-glow' : undefined;
    m.addLayer({ id: 'wells-leg', type: 'line', source: 'wells', minzoom: 12.5, filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#9fe8c0', 'line-opacity': 0.45, 'line-width': 1.2, 'line-dasharray': [2, 2] } }, before);
    m.addLayer({ id: 'wells-sour', type: 'circle', source: 'wells', minzoom: 11, filter: ['all', ['==', ['geometry-type'], 'Point'], ['>=', ['get', 'h2s'], 2], ['<=', ['get', 'h2s'], 4]], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4.5, 16, 10], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ff4d5e', 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.9 } }, before);
    m.addLayer({ id: 'wells', type: 'circle', source: 'wells', minzoom: 11, filter: ['==', ['geometry-type'], 'Point'], paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.2, 16, 6],
      'circle-color': ['match', ['get', 'st'], 'Abandoned', '#7f93a1', 'Suspension', '#ffb43c', 'new', '#3be6ff', '#46ff9a'],
      'circle-stroke-color': '#02070a', 'circle-stroke-width': 1, 'circle-opacity': 0.95 } }, before);
    m.addLayer({ id: 'rigs-glow', type: 'circle', source: 'rigs', minzoom: 5, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 8, 14, 22], 'circle-color': '#c6ff3d', 'circle-blur': 1, 'circle-opacity': 0.55 } }, before);
    m.addLayer({ id: 'rigs', type: 'circle', source: 'rigs', minzoom: 5, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 14, 7], 'circle-color': '#c6ff3d', 'circle-stroke-color': '#0b1400', 'circle-stroke-width': 1.5 } }, before);
    m.addLayer({ id: 'sel', type: 'line', source: 'sel', paint: { 'line-color': '#c6ff3d', 'line-width': 2.5, 'line-dasharray': [1, 1] } });
    applyVis();
  };
  if (m.isStyleLoaded()) go(); else m.once('load', go);
}
export function applyVis() {
  const m = A.S.map, p = A.S.prefs; if (!m.getLayer('wells')) return;
  for (const id of ['wells', 'wells-sour', 'wells-leg']) m.setLayoutProperty(id, 'visibility', p.wells ? 'visible' : 'none');
  for (const id of ['rigs', 'rigs-glow']) m.setLayoutProperty(id, 'visibility', p.rigs ? 'visible' : 'none');
}

export function refresh(w, s, e, n, z) {
  const m = A.S.map; if (!m.getSource('wells')) return;
  if (W && A.S.prefs.wells && z >= 11) {
    const { out, extra } = W.inBox(w, s, e, n, 6000);
    const feats = [];
    for (const i of out) {
      const c = [W.lon[i], W.lat[i]];
      feats.push({ type: 'Feature', properties: { i, st: W.status(i), h2s: W.h2s(i) }, geometry: { type: 'Point', coordinates: c } });
      if (z >= 12.5) for (let j = W.bStart[i]; j < W.bStart[i + 1]; j++) { const b = W.bh(j, i); if (Math.abs(b[0] - c[0]) + Math.abs(b[1] - c[1]) > 0.0006) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [c, b] } }); }
    }
    for (const x of extra) { const q = W.extra[x]; feats.push({ type: 'Feature', properties: { x, st: 'new', h2s: 6 }, geometry: { type: 'Point', coordinates: [q[3], q[2]] } }); }
    m.getSource('wells').setData(A.fc(feats));
  } else m.getSource('wells').setData(A.fc());
  m.getSource('rigs').setData(A.fc(latestRigs().filter(r => r.lat).map(r => ({ type: 'Feature', properties: { rig: r.rig, c: r.contractor }, geometry: { type: 'Point', coordinates: [r.lon, r.lat] } }))));
}
export function drawLabels(cx, m) {
  if (!A.S.prefs.rigs || m.getZoom() < 8) return;
  cx.font = '700 11px B612M, monospace'; cx.textAlign = 'left';
  for (const r of latestRigs()) {
    if (!r.lat) continue;
    const p = m.project([r.lon, r.lat]);
    if (p.x < 0 || p.y < 0 || p.x > innerWidth || p.y > innerHeight) continue;
    const t = `${shortCo(r.contractor)} ${r.rig}`;
    cx.fillStyle = 'rgba(0,0,0,.65)'; cx.fillText(t, p.x + 10, p.y + 4);
    cx.fillStyle = '#d8ff8a'; cx.fillText(t, p.x + 9, p.y + 3);
  }
  cx.textAlign = 'center';
}
const shortCo = (c) => ((c || '').replace(/\(\d+\)/g, '').replace(/\b(Drilling|Corporation|Corp|Inc|Ltd|Limited|Partnership|Services|Solutions|Canada|Company|Co|LP)\b\.?/gi, '').replace(/[.,]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14)) || 'Rig';

// ---------------- well database ----------------
export async function ensureWells(userAsked) {
  if (W || wellsState === 'loading') return W;
  wellsState = 'loading';
  const chip = document.querySelector('#chipData');
  try {
    W = await loadWells((part, f) => { if (chip && !part) chip.lastChild.textContent = `WELLS ${Math.round(f * 100)}%`; });
    wellsState = 'ready';
    A.refresh();
    if (userAsked) A.toast(`Well database ready: ${W.n.toLocaleString()} sites`);
  } catch (e) {
    wellsState = 'error'; console.warn(e);
    if (userAsked) A.toast(A.S.online ? 'Couldn’t load the well database' : 'Well database needs signal the first time');
  }
  return W;
}

// ---------------- search ----------------
export function query(v) {
  const t = v.trim(); if (!t) return false;
  // UWI → the well's SURFACE lease (works for horizontals whose UWI is the bottom hole)
  if (/^1?[0-9A-Z]{2}\s*\//i.test(t)) {
    if (!W) { ensureWells(true); return false; }
    const w = W.findUwi(t);
    if (w && !w.notFound) { gotoWell(w, t.toUpperCase()); return true; }
    return false; // falls back to the LSD in the UWI
  }
  // licence number
  if (/^(w\s*|lic(ence)?\s*#?\s*)?0*\d{4,9}[a-z]?$/i.test(t) && !/-/.test(t)) {
    if (!W) { A.toast('Loading well database…'); ensureWells(true).then(db => db && query(v)); return true; }
    const w = W.findLicence(t.replace(/^lic(ence)?\s*#?\s*/i, ''));
    if (w) { gotoWell(w); return true; }
    A.toast('Licence not found (cancelled and reclaimed licences aren’t included)'); return true;
  }
  if (parseQuery(t)) return false;
  // place name
  const pl = places.find(p => p[0].toLowerCase() === t.toLowerCase());
  if (pl) { A.setTarget({ kind: 'PLACE', center: [pl[3], pl[2]], label: `${pl[0]} (${pl[1]})` }); return true; }
  // company / well name
  if (t.length >= 3) {
    if (!W) { A.toast('Loading well database…'); ensureWells(true).then(db => db && query(v)); return true; }
    const hits = W.searchText(t, A.S.pos ? [A.S.pos.lon, A.S.pos.lat] : null, 40);
    if (hits.length) { showWellList(`"${t.toUpperCase()}"`, hits); return true; }
  }
  return false;
}
export function suggest(t) {
  const rows = [], q = t.trim().toLowerCase(); if (q.length < 2) return rows;
  places.filter(p => p[0].toLowerCase().startsWith(q)).slice(0, 4).forEach(p => rows.push([`⌂ ${p[0]}`, `${p[1]}${distTxt([p[3], p[2]])}`, `v2:place:${p[0]}`]));
  if (W && /^(w\s*)?0*\d{5,9}[a-z]?$/i.test(q)) { const w = W.findLicence(q); if (w) rows.push([`◉ Licence ${w.lic}`, `${w.licensee}${distTxt(w.center)}`, `v2:lic:${w.lic}`]); }
  if (W && /^1?[0-9a-z]{2}\//i.test(q)) { const w = W.findUwi(q); if (w && !w.notFound) rows.push([`◉ ${w.matchUwi}`, `surface lease${distTxt(w.center)}`, `v2:uwi:${w.matchUwi}`]); }
  return rows;
}
export function pick(k) {
  const [, kind, ...rest] = k.split(':'); const v = rest.join(':');
  if (kind === 'place') query(v); else if (kind === 'lic') query(v); else if (kind === 'uwi') query(v);
}
const distTxt = (c) => A.S.pos ? ` · ${A.fmtDist(dist([A.S.pos.lon, A.S.pos.lat], c))} ${compassShort(bearing([A.S.pos.lon, A.S.pos.lat], c))}` : '';

function gotoWell(w, uwi) {
  const here = A.S.db?.whereIs(w.center[0], w.center[1]);
  const label = here ? here.label : w.surf || `${w.center[1].toFixed(5)}, ${w.center[0].toFixed(5)}`;
  const quad = here ? A.S.db.locate(here).quad : null;
  A.setTarget({ kind: 'WELL', center: w.center, quad, label, name: w.licensee, well: w });
  const h = uwi && w.holes.find(x => x.uwi === w.matchUwi);
  if (h && dist(h.bh, w.center) > 250) A.toast(`Bottom hole is ${A.fmtDist(dist(w.center, h.bh))} ${compassShort(bearing(w.center, h.bh))} — routing to the surface lease`);
  showSel(w);
}
function showSel(w) {
  const m = A.S.map; if (!m.getSource('sel')) return;
  const f = (w?.holes || []).filter(h => dist(h.bh, w.center) > 60).map(h => A.line([w.center, h.bh]));
  m.getSource('sel').setData(A.fc(f));
}

// ---------------- target hooks: road-reach + sour gas + downhole hint ----------------
let reachSeq = 0;
export async function onTarget(t) {
  const box = document.querySelector('#tgInfo'); if (!box) return;
  if (!t) { box.innerHTML = ''; showSel(null); return; }
  const chips = [];
  const w = t.well || (W && t.kind !== 'PLACE' ? W.nearest(t.center, 120) : null);
  if (w && !t.well) t.well = w;
  if (w) {
    if (w.h2s >= 2 && w.h2s <= 4) chips.push(`<span class="ichip bad">☣ ${H2S[w.h2s].toUpperCase()} WELL — H2S PRECAUTIONS</span>`);
    chips.push(`<span class="ichip" data-act="well">◉ ${esc(w.licensee)} · ${w.status}${w.statusYear ? ' ' + w.statusYear : ''} ›</span>`);
  }
  // horizontal wells that bottom out in this LSD but are drilled from somewhere else
  if (W && t.kind === 'LSD' && t.d && t.d.ls) {
    const bots = W.bottomsIn(t.d).filter(b => dist(W.bh(b.j, b.i), [W.lon[b.i], W.lat[b.i]]) > 250);
    if (bots.length) {
      const surf = [W.lon[bots[0].i], W.lat[bots[0].i]], sl = A.S.db.whereIs(surf[0], surf[1]);
      chips.push(`<span class="ichip warn" data-act="surf" data-i="${bots[0].i}">⤴ ${bots.length} well${bots.length > 1 ? 's' : ''} bottom here — surface lease ${sl ? sl.label : ''} ›</span>`);
    }
  }
  chips.push(`<span class="ichip dim" id="reachChip">ACCESS · checking…</span>`);
  box.innerHTML = chips.join('');
  box.querySelectorAll('[data-act=well]').forEach(el => el.onclick = () => wellSheet(t.well));
  box.querySelectorAll('[data-act=surf]').forEach(el => el.onclick = () => gotoWell(W.well(+el.dataset.i)));
  A.setHud();
  showSel(t.well);
  // road-reach (Lease Locator's BACK40, done on the phone)
  const seq = ++reachSeq;
  try {
    const c = t.center;
    const feats = await D.roadsIn(c[0] - 0.06, c[1] - 0.035, c[0] + 0.06, c[1] + 0.035, A.S.online, 'cells', 9);
    if (seq !== reachSeq) return;
    const g = new Graph(); g.addFeatures(feats);
    for (const tr of A.S.tracks) g.addLine(tr.pts.map(p => [p[0], p[1]]), 99, tr.name);
    const sn = g.snap(c, 5000);
    const chip = document.querySelector('#reachChip'); if (!chip) return;
    const type = sn ? (sn.ft === 99 ? 'your track' : (A.ROAD_TYPES[sn.ft] || {}).name || 'road') : '';
    if (!feats.length && !A.S.online) { chip.className = 'ichip dim'; chip.textContent = 'ACCESS · no road data saved here'; }
    else if (!sn) { chip.className = 'ichip bad'; chip.textContent = 'ACCESS · NO MAPPED ROAD WITHIN 5 KM'; }
    else if (sn.d <= 75) { chip.className = 'ichip ok'; chip.textContent = `ACCESS · ROAD REACHES LEASE (${type})`; }
    else if (sn.d <= 600) { chip.className = 'ichip warn'; chip.textContent = `ACCESS · ROAD STOPS SHORT ${A.fmtDist(sn.d)} (${type})`; }
    else { chip.className = 'ichip bad'; chip.textContent = `ACCESS · ENDS BLIND — nearest road ${A.fmtDist(sn.d)}`; }
    t.reach = sn ? sn.d : null;
  } catch (e) { console.warn(e); }
}

// ---------------- tap on map: wells, rigs ----------------
export function tap(ll) {
  const m = A.S.map, p = m.project(ll);
  const box = [[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]];
  const layers = ['rigs', 'wells'].filter(id => m.getLayer(id) && m.getLayoutProperty(id, 'visibility') !== 'none');
  const hit = layers.length ? m.queryRenderedFeatures(box, { layers }) : [];
  if (!hit.length) return false;
  const f = hit[0];
  if (f.layer.id === 'rigs') { const r = latestRigs().find(x => x.rig === f.properties.rig && x.contractor === f.properties.c); if (r) rigSheet(r); return true; }
  if (f.properties.i != null && W) { wellSheet(W.well(+f.properties.i)); return true; }
  if (f.properties.x != null && W) { wellSheet(W.extraWell(+f.properties.x)); return true; }
  return false;
}

function wellSheet(w) {
  const surf = A.S.db?.whereIs(w.center[0], w.center[1]);
  const sour = w.h2s >= 2 && w.h2s <= 4;
  A.openSheet(`<h2>WELL · ${esc(w.lic)}</h2>
    <div class="big" style="font-size:20px">${esc(w.licensee)}</div>
    ${sour ? `<div class="risk high">☣ ${H2S[w.h2s]} well (AER H2S category). Follow your H2S site procedures.</div>` : ''}
    <div class="kv"><span>SURFACE</span><b>${surf ? surf.label : w.surf || '—'}</b>
      <span>STATUS</span><b>${w.status}${w.statusYear ? ' (' + w.statusYear + ')' : ''}</b>
      ${w.spudYear ? `<span>SPUD</span><b>${w.spudYear}</b>` : ''}
      ${w.h2s != null && w.h2s < 6 ? `<span>H2S</span><b>${H2S[w.h2s]}${w.pad ? ' · multiwell pad' : ''}</b>` : ''}
      <span>COORDS</span><b>${w.center[1].toFixed(5)}, ${w.center[0].toFixed(5)}</b>
      ${A.S.pos ? `<span>FROM YOU</span><b>${A.fmtDist(dist([A.S.pos.lon, A.S.pos.lat], w.center))} ${compassShort(bearing([A.S.pos.lon, A.S.pos.lat], w.center))}</b>` : ''}</div>
    ${w.holes.length ? `<h3>${w.holes.length > 1 ? w.holes.length + ' BOREHOLES' : 'BOREHOLE'}</h3>` + w.holes.map(h => `<div class="row"><div class="grow"><b>${h.uwi}</b><small>${esc(h.name)}${h.td ? ' · TD ' + h.td + ' m' : ''}${dist(h.bh, w.center) > 60 ? ` · bottom ${A.fmtDist(dist(w.center, h.bh))} ${compassShort(bearing(w.center, h.bh))}` : ''}</small></div></div>`).join('') : `<p class="dim">Newly licensed — details arrive with the next monthly AER well list.</p>`}
    <div class="btnRow"><button class="act prime" id="wGo">GO TO LEASE</button><button class="act" id="wCopy">COPY</button></div>
    <p class="dim">AER ST37 well list${w.src === 'licence' ? ' / daily licence list' : ''}. Licence status isn't site access permission.</p>`);
  document.querySelector('#wGo').onclick = () => { A.closeSheet(); gotoWell(w); };
  document.querySelector('#wCopy').onclick = () => A.copy(`Licence ${w.lic} · ${w.licensee}\nSurface ${surf ? surf.label : ''}\n${w.center[1].toFixed(6)}, ${w.center[0].toFixed(6)}`);
  showSel(w);
}
function showWellList(title, hits) {
  A.openSheet(`<h2>WELLS ${esc(title)}</h2><p class="dim">${hits.length >= 40 ? 'Nearest 40 shown.' : hits.length + ' found.'}</p>
  ${hits.map((w, k) => { const s = A.S.db?.whereIs(w.center[0], w.center[1]); return `<div class="row" data-k="${k}"><div class="grow"><b>${s ? s.label : w.lic}</b><small>${esc(w.licensee)} · ${esc((w.holes[0] || {}).name || '')} · ${w.status}${distTxt(w.center)}</small></div><span class="dim">›</span></div>`; }).join('')}`);
  document.querySelectorAll('#sheetBody [data-k]').forEach(el => el.onclick = () => wellSheet(hits[+el.dataset.k]));
}

// ---------------- rigs ----------------
let latestCache = null;
function latestRigs() {
  if (latestCache && latestCache.src === rigs) return latestCache.list;
  const by = new Map();
  for (const r of rigs) { const k = r.contractor + '|' + r.rig; if (!by.has(k)) by.set(k, r); }
  latestCache = { src: rigs, list: [...by.values()] };
  return latestCache.list;
}
function checkFollowed() {
  const f = A.S.followRigs; if (!f.length) return;
  const moved = [];
  for (const fr of f) {
    const r = latestRigs().find(x => x.contractor + '|' + x.rig === fr.k);
    if (r && r.uwi !== fr.uwi) { moved.push(`${shortCo(r.contractor)} ${r.rig} → ${r.uwi.slice(3, 17)}`); fr.uwi = r.uwi; }
  }
  if (moved.length) { A.store.set('followRigs', f); setTimeout(() => A.toast('RIG MOVED: ' + moved.join(' · ')), 2500); }
}
export function showRigs() {
  const me = A.S.pos ? [A.S.pos.lon, A.S.pos.lat] : null;
  const list = latestRigs().filter(r => r.lat).sort((a, b) => me ? dist(me, [a.lon, a.lat]) - dist(me, [b.lon, b.lat]) : b.date.localeCompare(a.date)).slice(0, 40);
  const fol = new Set(A.S.followRigs.map(x => x.k));
  A.openSheet(`<h2>RIG ACTIVITY</h2><p class="dim">AER daily drilling activity, last 30 days${me ? ', nearest first' : ''}. ★ follows a rig and tells you when it moves.</p>
  ${list.map((r, k) => `<div class="row"><button class="act" data-f="${k}" style="width:44px;padding:0">${fol.has(r.contractor + '|' + r.rig) ? '★' : '☆'}</button><div class="grow" data-k="${k}"><b>${esc(shortCo(r.contractor))} ${esc(r.rig)}</b><small>${esc(r.licensee)} · ${esc(r.name)} · ${r.date.slice(0, 10)} ${esc(r.type)}${me ? ' · ' + A.fmtDist(dist(me, [r.lon, r.lat])) : ''}</small></div><span class="dim">›</span></div>`).join('') || '<p>No rig data loaded.</p>'}`);
  document.querySelectorAll('#sheetBody [data-k]').forEach(el => el.onclick = () => rigSheet(list[+el.dataset.k]));
  document.querySelectorAll('#sheetBody [data-f]').forEach(el => el.onclick = () => {
    const r = list[+el.dataset.f], k = r.contractor + '|' + r.rig, f = A.S.followRigs;
    const at = f.findIndex(x => x.k === k); if (at >= 0) f.splice(at, 1); else f.push({ k, uwi: r.uwi });
    A.store.set('followRigs', f); showRigs();
  });
}
function rigSheet(r) {
  const hist = rigs.filter(x => x.contractor === r.contractor && x.rig === r.rig).slice(0, 6);
  A.openSheet(`<h2>RIG · ${esc(shortCo(r.contractor))} ${esc(r.rig)}</h2>
    <div class="kv"><span>CONTRACTOR</span><b>${esc(r.contractor || '—')}</b><span>OPERATOR</span><b>${esc(r.licensee)}</b><span>WELL</span><b>${esc(r.name)}</b><span>UWI</span><b>${esc(r.uwi)}</b><span>LICENCE</span><b>${esc(r.lic)}</b><span>ACTIVITY</span><b>${esc(r.type)} · ${esc(r.when)}</b></div>
    ${hist.length > 1 ? '<h3>RECENT MOVES</h3>' + hist.map(h => `<div class="row"><div class="grow"><b>${esc(h.uwi)}</b><small>${h.date.slice(0, 10)} · ${esc(h.type)}</small></div></div>`).join('') : ''}
    <div class="btnRow"><button class="act prime" id="rGo">GO TO RIG</button></div>
    <p class="dim">Position is the well's surface location from the AER licence list.</p>`);
  document.querySelector('#rGo').onclick = () => { A.closeSheet(); const s = A.S.db?.whereIs(r.lon, r.lat); A.setTarget({ kind: 'RIG', center: [r.lon, r.lat], quad: s ? A.S.db.locate(s).quad : null, label: s ? s.label : r.uwi, name: `${shortCo(r.contractor)} ${r.rig}` }); };
}

// ---------------- hospitals (emergency screen) ----------------
export function sosHtml() {
  if (!A.S.pos || !hospitals.length) return '';
  const me = [A.S.pos.lon, A.S.pos.lat];
  const near = hospitals.map(h => ({ h, d: dist(me, [h[3], h[2]]) })).sort((a, b) => a.d - b.d).slice(0, 3);
  return `<h3>NEAREST HOSPITALS (straight line)</h3>${near.map((x, k) => `<div class="row"><div class="grow"><b>${esc(x.h[0])}</b><small>${esc(x.h[1])} · ${A.fmtDist(x.d)} ${compassShort(bearing(me, [x.h[3], x.h[2]]))}</small></div><button class="act prime" data-hosp="${k}">ROUTE</button></div>`).join('')}
  <p class="dim">Hospital list: Statistics Canada ODHF (2020) + Grande Prairie Regional Hospital. Not every site has a 24/7 emergency department — call 911 first.</p>`;
}
export function wireSos() {
  if (!A.S.pos) return;
  const me = [A.S.pos.lon, A.S.pos.lat];
  const near = hospitals.map(h => ({ h, d: dist(me, [h[3], h[2]]) })).sort((a, b) => a.d - b.d).slice(0, 3);
  document.querySelectorAll('[data-hosp]').forEach(b => b.onclick = () => { const h = near[+b.dataset.hosp].h; A.closeSheet(); A.setTarget({ kind: 'HOSP', center: [h[3], h[2]], label: h[0], name: 'HOSPITAL' }); A.route(); });
}

// ---------------- sites: pins with gate codes, radio, notes + crew links ----------------
export function siteSheet(t, existing) {
  const p = existing || {};
  A.openSheet(`<h2>${existing ? 'EDIT SITE' : 'SAVE SITE'}</h2><p>${esc(t.label)}</p>
    <input class="field" id="sName" placeholder="Name (Pad 7, Battery, Camp…)" value="${esc(p.name || t.name || '')}">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><input class="field" id="sGate" placeholder="Gate code" value="${esc(p.gate || '')}"><input class="field" id="sRadio" placeholder="Radio ch. / RR" value="${esc(p.radio || '')}"></div>
    <textarea class="field" id="sNote" placeholder="Notes: road call-outs, km markers, hazards, contact…" style="height:90px;padding:10px;margin-top:8px">${esc(p.note || '')}</textarea>
    <div class="btnRow"><button class="act go2" id="sSave">SAVE</button>${existing ? '<button class="act" id="sShare">SEND TO CREW</button>' : ''}</div>
    <p class="dim">Saved on this phone. SEND TO CREW makes a link that opens LEASELINE with this site (gate code included — only send it to people who should have it).</p>`);
  document.querySelector('#sSave').onclick = () => {
    const site = existing || A.addPin('', t.center, t.quad, t.label);
    Object.assign(site, { name: val('#sName') || t.label, gate: val('#sGate'), radio: val('#sRadio'), note: val('#sNote') });
    A.savePins(); if (A.S.target) { A.S.target.name = site.name; A.S.target.site = site; }
    A.closeSheet(); A.toast('Site saved'); A.refreshTargetLabel();
  };
  const sh = document.querySelector('#sShare'); if (sh) sh.onclick = () => shareSite(existing);
}
const val = (s) => (document.querySelector(s)?.value || '').trim();
function siteLink(p) {
  const payload = { n: p.name, c: p.center.map(v => +v.toFixed(6)), l: p.label, g: p.gate || undefined, r: p.radio || undefined, o: p.note || undefined };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}?site=${b64}`;
}
async function shareSite(p) {
  const url = siteLink(p), text = `${p.name} — ${p.label}${p.radio ? ' · radio ' + p.radio : ''}\nOpen in LEASELINE: ${url}`;
  try { if (navigator.share) { await navigator.share({ title: p.name, text }); return; } } catch { return; }
  A.copy(text);
}
function importSite(b64) {
  try {
    const j = JSON.parse(decodeURIComponent(escape(atob(b64.replace(/-/g, '+').replace(/_/g, '/')))));
    const c = j.c; if (!Array.isArray(c) || c.length !== 2 || !isFinite(c[0]) || !isFinite(c[1])) throw new Error('bad');
    A.openSheet(`<h2>SITE FROM CREW</h2><div class="big" style="font-size:20px">${esc(j.n || 'Site')}</div>
      <div class="kv"><span>LOCATION</span><b>${esc(j.l || '')}</b>${j.g ? `<span>GATE</span><b>${esc(j.g)}</b>` : ''}${j.r ? `<span>RADIO</span><b>${esc(j.r)}</b>` : ''}</div>${j.o ? `<p>${esc(j.o)}</p>` : ''}
      <div class="btnRow"><button class="act go2" id="iSave">SAVE + GO</button><button class="act" id="iGo">JUST GO</button></div>`);
    const tgt = () => A.setTarget({ kind: 'PIN', center: c, label: j.l || `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`, name: j.n });
    document.querySelector('#iSave').onclick = () => { const p = A.addPin(j.n || 'Site', c, null, j.l); Object.assign(p, { gate: j.g || '', radio: j.r || '', note: j.o || '' }); A.savePins(); A.closeSheet(); tgt(); A.toast('Site saved'); };
    document.querySelector('#iGo').onclick = () => { A.closeSheet(); tgt(); };
    history.replaceState(null, '', location.pathname);
  } catch { A.toast('That site link is damaged'); }
}
export function showSites() {
  const pins = A.S.pins;
  A.openSheet(`<h2>SITES</h2>${pins.map((p, k) => `<div class="row"><div class="grow" data-go="${k}"><b>★ ${esc(p.name)}</b><small>${esc(p.label)}${p.gate ? ' · gate ✓' : ''}${p.radio ? ' · radio ' + esc(p.radio) : ''}${distTxt(p.center)}</small></div><button class="act" data-ed="${k}">EDIT</button><button class="act" data-tr="${k}">+TRIP</button></div>`).join('') || '<p class="dim">No sites yet. Set a target and tap PIN.</p>'}`);
  document.querySelectorAll('[data-go]').forEach(el => el.onclick = () => { const p = pins[+el.dataset.go]; A.closeSheet(); A.setTarget({ kind: 'PIN', center: p.center, quad: p.quad, label: p.label, name: p.name, site: p }); });
  document.querySelectorAll('[data-ed]').forEach(el => el.onclick = () => { const p = pins[+el.dataset.ed]; siteSheet({ center: p.center, quad: p.quad, label: p.label, name: p.name }, p); });
  document.querySelectorAll('[data-tr]').forEach(el => el.onclick = () => { const p = pins[+el.dataset.tr]; addStop({ center: p.center, label: p.name }); });
}

// ---------------- trips: custom start + multi-stop ----------------
export function addStop(st) {
  const T = A.S.trip; T.stops.push({ center: st.center, label: st.label }); A.store.set('trip', T);
  A.toast(`Added to trip (${T.stops.length} stop${T.stops.length > 1 ? 's' : ''})`);
}
export function showTrip() {
  const T = A.S.trip;
  A.openSheet(`<h2>TRIP PLANNER</h2>
    <h3>START FROM</h3>
    <div class="seg"><button data-fm="gps" class="${T.fromMode === 'gps' ? 'on' : ''}">MY GPS</button><button data-fm="text" class="${T.fromMode === 'text' ? 'on' : ''}">TOWN / LSD</button></div>
    ${T.fromMode === 'text' ? `<input class="field" id="tFrom" style="margin-top:8px" placeholder="e.g. Drayton Valley, or 06-21-045-09 W5" value="${esc(T.fromText)}">` : ''}
    <h3>STOPS</h3>
    ${T.stops.map((s, k) => `<div class="row"><div class="grow"><b>${k + 1}. ${esc(s.label)}</b></div><button class="act" data-up="${k}" style="width:40px;padding:0">↑</button><button class="act warn" data-rm="${k}" style="width:40px;padding:0">✕</button></div>`).join('') || '<p class="dim">Add stops with +TRIP on a target, site or well.</p>'}
    <div class="btnRow">${A.S.target ? '<button class="act" id="tAdd">+ CURRENT TARGET</button>' : ''}<button class="act prime" id="tGo" ${T.stops.length ? '' : 'disabled'}>PLAN TRIP</button></div>
    ${T.stops.length ? '<div class="btnRow"><button class="act warn" id="tClear">CLEAR STOPS</button></div>' : ''}`);
  document.querySelectorAll('[data-fm]').forEach(b => b.onclick = () => { T.fromMode = b.dataset.fm; A.store.set('trip', T); showTrip(); });
  document.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const k = +b.dataset.up; if (k) { [T.stops[k - 1], T.stops[k]] = [T.stops[k], T.stops[k - 1]]; A.store.set('trip', T); showTrip(); } });
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { T.stops.splice(+b.dataset.rm, 1); A.store.set('trip', T); showTrip(); });
  const add = document.querySelector('#tAdd'); if (add) add.onclick = () => { addStop({ center: A.S.target.center, label: A.S.target.name ? `${A.S.target.name} · ${A.S.target.label}` : A.S.target.label }); showTrip(); };
  const clr = document.querySelector('#tClear'); if (clr) clr.onclick = () => { T.stops = []; A.store.set('trip', T); showTrip(); };
  document.querySelector('#tGo').onclick = async () => {
    let from;
    if (T.fromMode === 'text') {
      T.fromText = val('#tFrom'); A.store.set('trip', T);
      from = resolvePoint(T.fromText); if (!from) return A.toast('Start not found — use a town name or an LSD');
    }
    const last = T.stops[T.stops.length - 1];
    A.closeSheet();
    A.setTarget({ kind: 'PIN', center: last.center, label: last.label }, { keepView: true });
    await A.route({ from, stops: T.stops.slice() });
  };
}
function resolvePoint(text) {
  const t = text.trim(); if (!t) return null;
  const pl = places.find(p => p[0].toLowerCase() === t.toLowerCase()) || places.find(p => p[0].toLowerCase().startsWith(t.toLowerCase()));
  if (pl) return [pl[3], pl[2]];
  const p = parseQuery(t); if (!p || p.error) return null;
  if (p.kind === 'LL') return [p.lon, p.lat];
  const r = A.S.db.locate(p); return r.error ? null : r.center;
}

// ---------------- geo-stamped photos ----------------
export function takePhoto() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    A.busy('STAMPING PHOTO');
    try {
      const pos = A.S.pos, here = A.S.here, ts = Date.now();
      const img = await createImageBitmap(f);
      const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      x.drawImage(img, 0, 0, w, h);
      const bar = Math.round(h * 0.11), fs = Math.round(bar * 0.26);
      const g = x.createLinearGradient(0, h - bar * 1.4, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.35, 'rgba(2,6,10,.78)'); g.addColorStop(1, 'rgba(2,6,10,.92)');
      x.fillStyle = g; x.fillRect(0, h - bar * 1.4, w, bar * 1.4);
      x.fillStyle = '#ffb43c'; x.fillRect(Math.round(fs * 0.8), h - bar + fs * 0.2, Math.round(fs * 0.25), bar - fs * 0.9);
      x.textBaseline = 'alphabetic'; x.textAlign = 'left';
      x.font = `700 ${Math.round(fs * 1.25)}px B612M, monospace`; x.fillStyle = '#3be6ff';
      x.fillText(here ? 'LSD ' + here.label : 'LSD —', fs * 1.4, h - bar + fs * 1.35);
      x.font = `700 ${fs}px B612M, monospace`; x.fillStyle = '#dce8f0';
      const when = new Date(ts).toLocaleString('en-CA', { hour12: false });
      x.fillText(`${pos ? pos.lat.toFixed(6) + ', ' + pos.lon.toFixed(6) + '  ±' + Math.round(pos.acc) + ' m' : 'no GPS fix'}   ${when}${A.S.heading != null ? '   HDG ' + Math.round(A.S.heading) + '°' : ''}`, fs * 1.4, h - bar + fs * 2.6);
      x.textAlign = 'right'; x.fillStyle = 'rgba(255,180,60,.9)'; x.fillText('LEASELINE', w - fs, h - bar + fs * 1.35);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
      const id = 'ph' + ts;
      await D.idbPut('photos', id, { id, ts, blob, lsd: here ? here.label : '', lat: pos?.lat, lon: pos?.lon, acc: pos?.acc, note: '' });
      A.busy(false); A.toast('Photo saved with LSD + GPS stamp'); showPhotos();
    } catch (e) { A.busy(false); console.error(e); A.toast('Photo failed'); }
  };
  inp.click();
}
export async function showPhotos() {
  const all = (await D.idbAll('photos')).map(([, v]) => v).sort((a, b) => b.ts - a.ts);
  const urls = all.map(p => URL.createObjectURL(p.blob));
  A.openSheet(`<h2>PHOTOS</h2><div class="btnRow" style="margin-top:0"><button class="act prime" id="phNew">TAKE PHOTO</button></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px">${all.map((p, k) => `<img data-ph="${k}" src="${urls[k]}" style="width:100%;aspect-ratio:1;object-fit:cover;border:1px solid var(--line)">`).join('')}</div>
    ${all.length ? '' : '<p class="dim">Photos get the LSD, GPS position and time burned in, so they hold up as site records.</p>'}`);
  document.querySelector('#phNew').onclick = takePhoto;
  document.querySelectorAll('[data-ph]').forEach(el => el.onclick = () => photoView(all[+el.dataset.ph], urls[+el.dataset.ph]));
}
function photoView(p, url) {
  A.openSheet(`<h2>PHOTO · ${esc(p.lsd || '')}</h2><img src="${url}" style="width:100%;border:1px solid var(--line)">
    <div class="kv" style="margin-top:8px"><span>TAKEN</span><b>${new Date(p.ts).toLocaleString()}</b>${p.lat ? `<span>AT</span><b>${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</b>` : ''}</div>
    <div class="btnRow"><button class="act prime" id="pShare">SHARE</button>${p.lat ? '<button class="act" id="pMap">ON MAP</button>' : ''}<button class="act warn" id="pDel">DELETE</button></div>`);
  document.querySelector('#pShare').onclick = async () => {
    const file = new File([p.blob], `LEASELINE_${(p.lsd || 'photo').replace(/\W+/g, '-')}_${p.ts}.jpg`, { type: 'image/jpeg' });
    try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; } } catch { return; }
    const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
  };
  const pm = document.querySelector('#pMap'); if (pm) pm.onclick = () => { A.closeSheet(); A.setTarget({ kind: 'PT', center: [p.lon, p.lat], label: `Photo · ${p.lsd}` }); };
  document.querySelector('#pDel').onclick = async () => { await D.idbDel('photos', p.id); showPhotos(); };
}

// ---------------- menu / layers / about additions ----------------
export function menuRows() {
  return [['mTrip', 'TRIP PLANNER', `${A.S.trip.stops.length} stops · custom start`], ['mRigs', 'RIG ACTIVITY', `${latestRigs().length} rigs · last 30 days`], ['mSites', '★ SITES', `${A.S.pins.length} saved · gate codes, radio, crew links`], ['mPhotos', 'PHOTOS', 'LSD + GPS stamped'], ['mWells', 'WELL DATABASE', W ? `${W.n.toLocaleString()} sites · ready offline` : wellsState === 'loading' ? 'loading…' : 'tap to load']];
}
export function wireMenu() {
  const on = (id, f) => { const el = document.querySelector('#' + id); if (el) el.onclick = f; };
  on('mTrip', showTrip); on('mRigs', showRigs); on('mSites', showSites); on('mPhotos', showPhotos);
  on('mWells', () => { if (W) A.toast(`${W.n.toLocaleString()} well sites + ${W.extra.length} new licences on this phone`); else ensureWells(true); });
}
export function moreSheet() {
  const t = A.S.target; if (!t) return;
  A.openSheet(`<h2>TARGET</h2><p>${esc(t.name ? t.name + ' · ' : '')}${esc(t.label)}</p>
    ${[['oSite', t.site ? 'EDIT SITE NOTES' : 'SAVE AS SITE', 'name, gate code, radio channel, notes'], ['oTrip', '+ ADD TO TRIP', 'multi-stop route'], ['oShare', 'SHARE LOCATION', 'LSD + coordinates + map link'], ['oCrew', 'SEND TO CREW', 'link that opens this site in LEASELINE']]
      .map(([id, a, b]) => `<div class="row" id="${id}"><div class="grow"><b>${a}</b><small>${b}</small></div><span class="dim">›</span></div>`).join('')}`);
  document.querySelector('#oSite').onclick = () => siteSheet(t, t.site);
  document.querySelector('#oTrip').onclick = () => { addStop({ center: t.center, label: t.name ? `${t.name} · ${t.label}` : t.label }); A.closeSheet(); };
  document.querySelector('#oShare').onclick = () => { A.closeSheet(); A.shareTarget(); };
  document.querySelector('#oCrew').onclick = () => shareSite(t.site || { name: t.name || t.label, center: t.center, label: t.label });
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
