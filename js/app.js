// LEASELINE — Alberta lease navigation. Personal-use build.
import { LsdDB, parseQuery, fmtLSD } from './lsd.js';
import * as D from './data.js';
import { Graph, route as planPath, dist, bearing, compass, compassShort, progressOn, cumulative, ROAD_TYPES } from './route.js';

const $ = (s) => document.querySelector(s);
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// ---------------- state ----------------
const store = {
  get(k, d) { try { const v = localStorage.getItem('ll_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ll_' + k, JSON.stringify(v)); } catch { } },
};
const S = {
  db: null, map: null, online: navigator.onLine,
  pos: null, heading: null, speed: 0, lastFixTs: 0,
  follow: 'free', target: null, route: null, nav: null,
  rec: null, tracks: [],
  prefs: Object.assign({ base: 'sat', terrain: false, grid: true, cuts: true, tracks: true, voice: true }, store.get('prefs', {})),
  odo: store.get('odo', { m: 0 }), odoLast: null,
  pins: store.get('pins', []), history: store.get('history', []),
  packs: store.get('packs', []),
  roadsCount: 0, gridFC: null, wakeLock: null,
};
const savePrefs = () => store.set('prefs', S.prefs);

// ---------------- boot ----------------
const bootLog = (txt, state = 'OK', cls = '') => { const li = document.createElement('li'); li.innerHTML = `<span>${txt}</span><b class="${cls}">${state}</b>`; $('#bootLog').appendChild(li); return li; };
const bootBar = (p) => { $('#bootBar').style.width = p + '%'; };

async function boot() {
  bootBar(8);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
  try { navigator.storage?.persist?.(); } catch { }
  const li = bootLog('ATS GRID DATABASE', 'LOADING', 'w');
  try {
    S.db = await loadDB((p) => bootBar(8 + p * 55));
    li.innerHTML = `<span>ATS GRID · ${S.db.nSections.toLocaleString()} SECTIONS</span><b>ONLINE</b>`;
  } catch (e) { li.innerHTML = `<span>ATS GRID DATABASE</span><b class="e">FAIL</b>`; console.error(e); }
  bootBar(70);
  bootLog('ROAD NETWORK CACHE', `${await D.cachedCellCount()} CELLS`);
  bootLog('DATA LINK', S.online ? 'ONLINE' : 'OFFLINE', S.online ? '' : 'w');
  bootLog('GPS RECEIVER', 'STARTING', 'w');
  bootBar(85);
  initMap();
  initUI();
  startGPS();
  loadTracks();
  bootBar(100);
  setTimeout(() => $('#boot').classList.add('gone'), 450);
  setTimeout(() => $('#boot').remove(), 1100);
}

async function loadDB(progress) {
  const res = await fetch('data/lsd.bin.gz');
  if (!res.ok) throw new Error('db ' + res.status);
  const total = +res.headers.get('content-length') || 2340110;
  let got = 0;
  const counter = new TransformStream({ transform(chunk, ctl) { got += chunk.byteLength; progress(Math.min(1, got / total)); ctl.enqueue(chunk); } });
  let stream = res.body.pipeThrough(counter);
  // GitHub Pages may already have un-gzipped it in transit; sniff the magic bytes
  const buf = await new Response(stream).arrayBuffer();
  const u8 = new Uint8Array(buf);
  let raw = buf;
  if (u8[0] === 0x1f && u8[1] === 0x8b) raw = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return new LsdDB(raw);
}

// ---------------- map ----------------
function initMap() {
  const start = S.pos ? [S.pos.lon, S.pos.lat] : store.get('lastView', { c: [-115.5, 55.2], z: 6 });
  const map = new maplibregl.Map({
    container: 'map', center: start.c, zoom: start.z, maxPitch: 75, attributionControl: false,
    style: {
      version: 8,
      sources: {
        sat: { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
        dem: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 13, encoding: 'terrarium', attribution: 'Terrain: AWS Terrain Tiles / Mapzen' },
        grid: { type: 'geojson', data: fc(), attribution: 'ATS, roads & cutlines: Government of Alberta, Open Government Licence – Alberta' },
        roads: { type: 'geojson', data: fc() },
        cuts: { type: 'geojson', data: fc() },
        tracks: { type: 'geojson', data: fc() },
        rec: { type: 'geojson', data: fc() },
        route: { type: 'geojson', data: fc(), lineMetrics: true },
        last: { type: 'geojson', data: fc() },
        target: { type: 'geojson', data: fc() },
        acc: { type: 'geojson', data: fc() },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#04070a' } },
        { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-brightness-max': 0.78, 'raster-saturation': -0.3, 'raster-contrast': 0.12, 'raster-fade-duration': 150 } },
        { id: 'hill', type: 'hillshade', source: 'dem', layout: { visibility: 'none' }, paint: { 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#24394a', 'hillshade-accent-color': '#0b1720', 'hillshade-exaggeration': 0.55 } },
        { id: 'grid-sec', type: 'line', source: 'grid', minzoom: 10.5, filter: ['==', ['get', 'k'], 'sec'], paint: { 'line-color': '#5fd4ff', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 10.5, 0.15, 13, 0.45], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 15, 1.4] } },
        { id: 'grid-qs', type: 'line', source: 'grid', minzoom: 13, filter: ['==', ['get', 'k'], 'qs'], paint: { 'line-color': '#5fd4ff', 'line-opacity': 0.28, 'line-width': 0.8 } },
        { id: 'grid-lsd', type: 'line', source: 'grid', minzoom: 13.5, filter: ['==', ['get', 'k'], 'lsd'], paint: { 'line-color': '#5fd4ff', 'line-opacity': 0.16, 'line-width': 0.7, 'line-dasharray': [3, 3] } },
        { id: 'cuts', type: 'line', source: 'cuts', minzoom: 12.5, paint: { 'line-color': '#62e39a', 'line-opacity': 0.35, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 16, 1.6], 'line-dasharray': [1, 2] } },
        { id: 'roads-glow', type: 'line', source: 'roads', layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': roadColor(), 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 18], 'line-blur': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 12], 'line-opacity': 0.32 } },
        { id: 'roads-case', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 8] } },
        { id: 'roads', type: 'line', source: 'roads', filter: ['!', ['in', ['get', 'ft'], ['literal', [2, 12, 14]]]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': roadColor(), 'line-width': roadWidth(), 'line-opacity': 0.95 } },
        { id: 'roads-dash', type: 'line', source: 'roads', filter: ['in', ['get', 'ft'], ['literal', [2, 12, 14]]], paint: { 'line-color': roadColor(), 'line-width': roadWidth(), 'line-dasharray': [2, 1.4] } },
        { id: 'tracks-glow', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#3be6ff', 'line-width': 9, 'line-blur': 6, 'line-opacity': 0.4 } },
        { id: 'tracks', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#3be6ff', 'line-width': 2.6 } },
        { id: 'rec', type: 'line', source: 'rec', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ff4d5e', 'line-width': 3, 'line-dasharray': [1, 1] } },
        { id: 'target-fill', type: 'fill', source: 'target', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ff3df2', 'fill-opacity': 0.12 } },
        { id: 'target-line', type: 'line', source: 'target', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#ff3df2', 'line-width': 2, 'line-opacity': 0.9 } },
        { id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff3df2', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 10, 16, 22], 'line-blur': 10, 'line-opacity': 0.5 } },
        { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9], 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#ff8af7', 1, '#ff3df2'] } },
        { id: 'route-flow', type: 'line', source: 'route', layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 2.6], 'line-dasharray': [0, 4, 3] } },
        { id: 'last', type: 'line', source: 'last', paint: { 'line-color': '#ffb43c', 'line-width': 2.5, 'line-dasharray': [1.5, 1.5] } },
        { id: 'acc', type: 'fill', source: 'acc', paint: { 'fill-color': '#3be6ff', 'fill-opacity': 0.08, 'fill-outline-color': '#3be6ff' } },
      ],
    },
  });
  S.map = map;
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.on('load', () => { applyPrefs(); refreshData(); animateRoute(); document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'); setHudVar(); });
  map.on('moveend', () => { refreshDataSoon(); const c = map.getCenter(); store.set('lastView', { c: [c.lng, c.lat], z: map.getZoom() }); });
  map.on('render', drawLabelsSoon);
  map.on('dragstart', () => { if (S.follow !== 'free' && !S.nav) setFollow('free'); });
  map.on('click', (e) => onMapTap(e.lngLat));
  window.addEventListener('resize', sizeCanvas); sizeCanvas();

  // ownship marker
  const el = document.createElement('div'); el.className = 'ownship stale';
  el.innerHTML = `<div class="sweep"></div><svg viewBox="-32 -32 64 64"><circle r="10" fill="rgba(59,230,255,.15)" stroke="#3be6ff" stroke-width="1.2"/><path d="M0 -17 L9 11 L0 5 L-9 11 Z" fill="#3be6ff" stroke="#02161c" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  S.me = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' });
  const te = document.createElement('div'); te.className = 'tgtMark';
  te.innerHTML = `<i></i><i></i><svg viewBox="-28 -28 56 56"><path d="M-14 0H-5M5 0H14M0 -14V-5M0 5V14" stroke="#ff3df2" stroke-width="2.5"/><circle r="3" fill="#fff"/></svg>`;
  S.tgtMarker = new maplibregl.Marker({ element: te });
}
const fc = (features = []) => ({ type: 'FeatureCollection', features });
function roadColor() {
  return ['match', ['get', 'ft'], [6, 9], '#f5f8fa', 8, '#e3ebf0', [7, 3], '#c3ced6', 5, '#ffb43c', 4, '#ef8f2a', 14, '#d0904c', 12, '#86c0ff', 2, '#86c0ff', 10, '#b08f63', 99, '#3be6ff', '#d0904c'];
}
function roadWidth() {
  return ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'ft'], [6, 8, 9], 1.6, 5, 1.3, 0.8], 16, ['match', ['get', 'ft'], [6, 8, 9], 6, 5, 5, [4, 7], 4, 3]];
}
function applyPrefs() {
  const m = S.map, p = S.prefs;
  m.setLayoutProperty('sat', 'visibility', p.base === 'sat' ? 'visible' : 'none');
  m.setLayoutProperty('hill', 'visibility', p.base === 'tac' || p.terrain ? 'visible' : 'none');
  m.setPaintProperty('hill', 'hillshade-exaggeration', p.base === 'tac' ? 0.85 : 0.25);
  m.setPaintProperty('hill', 'hillshade-highlight-color', p.base === 'tac' ? '#3d6177' : '#24394a');
  m.setLayoutProperty('roads-glow', 'visibility', p.base === 'tac' ? 'visible' : 'none');
  m.setPaintProperty('roads-case', 'line-opacity', p.base === 'tac' ? 0 : 0.55);
  for (const id of ['grid-sec', 'grid-qs', 'grid-lsd']) m.setLayoutProperty(id, 'visibility', p.grid ? 'visible' : 'none');
  m.setLayoutProperty('cuts', 'visibility', p.cuts ? 'visible' : 'none');
  for (const id of ['tracks', 'tracks-glow']) m.setLayoutProperty(id, 'visibility', p.tracks ? 'visible' : 'none');
  try {
    if (p.terrain && S.online) { m.setTerrain({ source: 'dem', exaggeration: 1.5 }); m.setSky?.({ 'sky-color': '#05121c', 'horizon-color': '#1d3445', 'fog-color': '#04070a', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.4 }); if (m.getPitch() < 30) m.easeTo({ pitch: 60, duration: 800 }); }
    else { m.setTerrain(null); }
  } catch (e) { console.warn(e); }
  drawLabelsSoon();
}

// route flow animation (dash march)
function animateRoute() {
  const seq = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
  let i = 0, last = 0;
  const tick = (t) => {
    if (S.route && t - last > 70 && S.map.getLayer('route-flow')) { last = t; i = (i + 1) % seq.length; S.map.setPaintProperty('route-flow', 'line-dasharray', seq[i]); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------- viewport data ----------------
let dataTimer;
const refreshDataSoon = () => { clearTimeout(dataTimer); dataTimer = setTimeout(refreshData, 250); };
async function refreshData() {
  const m = S.map; if (!m) return;
  const z = m.getZoom(), b = m.getBounds();
  const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
  // grid from on-device ATS database (always offline)
  if (S.db && z >= 10.5) {
    const pad = 0.02;
    S.gridFC = S.db.gridGeoJSON(w - pad, s - pad, e + pad, n + pad, z >= 13);
    m.getSource('grid').setData(S.gridFC);
  } else if (S.gridFC) { S.gridFC = null; m.getSource('grid').setData(fc()); }
  // roads
  if (z >= 10.8) {
    try {
      const feats = await D.roadsIn(w, s, e, n, S.online, 'cells', 30);
      S.roadsCount = feats.length;
      m.getSource('roads').setData(fc(feats));
    } catch (err) { console.warn(err); }
  }
  if (z >= 12.5 && S.prefs.cuts) {
    try { m.getSource('cuts').setData(fc(await D.roadsIn(w, s, e, n, S.online, 'cuts', 16))); } catch { }
  }
  updateChips();
}

// ---------------- labels canvas (section + LSD numbers, in cockpit font) ----------------
const cv = $('#labels'), cx = cv.getContext('2d');
let dpr = 1, labelPending = false;
function sizeCanvas() { dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; drawLabels(); setHudVar(); }
function drawLabelsSoon() { if (labelPending) return; labelPending = true; requestAnimationFrame(() => { labelPending = false; drawLabels(); }); }
function drawLabels() {
  cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, innerWidth, innerHeight);
  const m = S.map; if (!m || !S.gridFC || !S.prefs.grid) return;
  const z = m.getZoom(); if (z < 11.5) return;
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  for (const f of S.gridFC.features) {
    const k = f.properties.k;
    if (k === 'sec') {
      const c = f.geometry.coordinates[0];
      const p = m.project([(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2]);
      if (p.x < -40 || p.y < -40 || p.x > innerWidth + 40 || p.y > innerHeight + 40) continue;
      const big = z >= 13;
      cx.font = `700 ${big ? 12 : 11}px B612M, monospace`;
      const t = big ? f.properties.full : f.properties.label;
      const hw = cx.measureText(t).width / 2;
      if (p.x - hw < 4 || p.x + hw > innerWidth - 4) continue; // don't draw clipped labels
      cx.fillStyle = 'rgba(0,0,0,.6)'; cx.fillText(t, p.x + 1, p.y + (big ? -1 : 1) + 1);
      cx.fillStyle = 'rgba(120,220,255,.85)'; cx.fillText(t, p.x, p.y + (big ? -1 : 0));
    } else if (k === 'lsdlabel' && z >= 14.3) {
      const p = m.project(f.geometry.coordinates);
      if (p.x < -20 || p.y < -20 || p.x > innerWidth + 20 || p.y > innerHeight + 20) continue;
      cx.font = '700 11px B612M, monospace';
      cx.fillStyle = 'rgba(0,0,0,.55)'; cx.fillText(f.properties.label, p.x + 1, p.y + 1);
      cx.fillStyle = 'rgba(255,200,110,.75)'; cx.fillText(f.properties.label, p.x, p.y);
    }
  }
}
function setHudVar() { const h = $('#hud')?.offsetHeight || 150; document.documentElement.style.setProperty('--hudh', h + 'px'); const bl = document.querySelector('.maplibregl-ctrl-bottom-left'); if (bl) bl.style.bottom = `calc(${h + 14}px + env(safe-area-inset-bottom,0px))`; }

// ---------------- GPS ----------------
function startGPS() {
  if (!('geolocation' in navigator)) { toast('This browser has no GPS access'); return; }
  navigator.geolocation.watchPosition(onFix, (err) => {
    $('#chipGps').className = 'chip bad'; $('#chipGps').lastChild.textContent = err.code === 1 ? 'GPS BLOCKED' : 'NO FIX';
    if (err.code === 1) toast('Location permission is off — allow it for this site to see your LSD');
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  setInterval(() => { if (S.pos && Date.now() - S.lastFixTs > 15000) { S.me.getElement().classList.add('stale'); $('#chipGps').className = 'chip warn'; $('#chipGps').lastChild.textContent = 'GPS STALE'; } }, 3000);
}
function onFix(p) {
  const c = p.coords, prev = S.pos;
  S.pos = { lon: c.longitude, lat: c.latitude, acc: c.accuracy, ts: p.timestamp };
  S.lastFixTs = Date.now();
  const spd = c.speed != null && !isNaN(c.speed) ? c.speed : (prev ? dist([prev.lon, prev.lat], [S.pos.lon, S.pos.lat]) / Math.max(1, (p.timestamp - prev.ts) / 1000) : 0);
  S.speed = spd > 60 ? (S.speed || 0) : spd; // ignore GPS jumps (>216 km/h)
  if (c.heading != null && !isNaN(c.heading) && spd > 1.2) S.heading = c.heading;
  else if (prev && spd > 1.5 && dist([prev.lon, prev.lat], [S.pos.lon, S.pos.lat]) > 6) S.heading = bearing([prev.lon, prev.lat], [S.pos.lon, S.pos.lat]);
  const ll = [S.pos.lon, S.pos.lat];
  // odometer
  if (c.accuracy < 35) {
    if (S.odoLast) { const d = dist(S.odoLast, ll); if (d > 4 && d < 2000 && spd > 0.8) { S.odo.m += d; S.odoLast = ll; store.set('odo', S.odo); } }
    else S.odoLast = ll;
  }
  // marker
  const el = S.me.getElement(); el.classList.remove('stale');
  S.me.setLngLat(ll).setRotation(S.heading ?? 0); if (!S.me._map) S.me.addTo(S.map);
  S.map.getSource('acc')?.setData(fc([circle(ll, Math.min(c.accuracy, 400))]));
  // first fix: fly there
  if (!prev && S.follow === 'free' && !S.target) S.map.jumpTo({ center: ll, zoom: Math.max(S.map.getZoom(), 13) });
  // recording
  if (S.rec && c.accuracy < 30) {
    const lastPt = S.rec.pts[S.rec.pts.length - 1];
    if (!lastPt || dist(lastPt, ll) > 8) { S.rec.pts.push([ll[0], ll[1], Date.now()]); S.map.getSource('rec').setData(fc([line(S.rec.pts)])); }
  }
  updateHud();
  if (S.nav) navTick();
  followCam();
}
function followCam() {
  if (!S.pos || S.follow === 'free') return;
  const ll = [S.pos.lon, S.pos.lat];
  if (S.follow === 'north') S.map.easeTo({ center: ll, bearing: 0, duration: 600 });
  else {
    const kmh = S.speed * 3.6;
    const zoom = S.nav ? (kmh > 70 ? 15 : kmh > 35 ? 15.7 : 16.4) : S.map.getZoom();
    const bottom = ($('#hud').offsetHeight || 220) + 16, top = Math.max(0, (innerHeight - bottom) * 0.5);
    S.map.easeTo({ center: ll, bearing: S.heading ?? S.map.getBearing(), pitch: S.nav ? 58 : S.map.getPitch(), zoom, padding: { top, bottom, left: 0, right: 0 }, duration: 900 });
  }
}
function setFollow(mode) {
  S.follow = mode;
  const b = $('#bFollow'); b.classList.toggle('on', mode !== 'free'); b.querySelector('span').textContent = { free: 'FREE', north: 'NORTH', heading: 'TRACK' }[mode];
  if (mode === 'free') { try { S.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); } catch { } }
  if (mode === 'north') S.map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  followCam();
}

// ---------------- HUD ----------------
function updateHud() {
  const p = S.pos;
  const hdg = S.heading;
  $('#hdgBox').textContent = hdg == null ? '---°' : String(Math.round(hdg)).padStart(3, '0') + '°';
  if (p) {
    const w = S.db?.whereIs(p.lon, p.lat);
    $('#roLsd').textContent = w ? (w.onGrid ? w.label : '≈ ' + w.label) : 'OUTSIDE ALBERTA GRID';
    S.here = w;
    $('#roSpd').textContent = Date.now() - S.lastFixTs > 15000 ? '--' : Math.round(S.speed * 3.6);
    $('#roAcc').textContent = '±' + Math.round(p.acc);
    const g = $('#chipGps'); g.className = 'chip ' + (p.acc <= 15 ? 'ok' : p.acc <= 50 ? 'warn' : 'bad'); g.lastChild.textContent = `GPS ±${Math.round(p.acc)} m`;
  }
  $('#roOdo').textContent = (S.odo.m / 1000).toFixed(1);
  drawHSI();
  if (S.target && p) {
    const d = dist([p.lon, p.lat], S.target.center), b = bearing([p.lon, p.lat], S.target.center);
    $('#tgDist').textContent = fmtDist(d);
    $('#tgBrg').textContent = `${String(Math.round(b)).padStart(3, '0')}° ${compassShort(b)}`;
  }
}
function drawHSI() {
  const hdg = S.heading ?? 0, svg = $('#hsi');
  let ticks = '';
  for (let a = 0; a < 360; a += 10) {
    const r1 = 50, r2 = a % 30 === 0 ? 42 : 46, rad = (a - 90) * Math.PI / 180;
    ticks += `<line x1="${r1 * Math.cos(rad)}" y1="${r1 * Math.sin(rad)}" x2="${r2 * Math.cos(rad)}" y2="${r2 * Math.sin(rad)}" stroke="${a % 90 === 0 ? '#ffb43c' : '#5c7383'}" stroke-width="${a % 30 === 0 ? 1.6 : 1}"/>`;
    if (a % 90 === 0) { const t = 'NESW'[a / 90], rr = 33; ticks += `<text x="${rr * Math.cos(rad)}" y="${rr * Math.sin(rad) + 3.5}" text-anchor="middle" font-family="B612M" font-weight="700" font-size="10" fill="${a === 0 ? '#ffb43c' : '#9fb3c0'}" transform="rotate(${a} ${rr * Math.cos(rad)} ${rr * Math.sin(rad)})">${t}</text>`; }
  }
  let needle = '';
  if (S.target && S.pos) {
    let tb = bearing([S.pos.lon, S.pos.lat], S.target.center);
    if (S.nav && !S.nav.lastMile && S.nav.nextAt) tb = bearing([S.pos.lon, S.pos.lat], S.nav.nextAt);
    needle = `<g transform="rotate(${tb})"><path d="M0 -50 L5 -38 L1.6 -38 L1.6 38 L-1.6 38 L-1.6 -38 L-5 -38 Z" fill="#ff3df2" style="filter:drop-shadow(0 0 4px #ff3df2)"/></g>`;
  }
  svg.innerHTML = `<defs><radialGradient id="hg"><stop offset="0" stop-color="#0b141b"/><stop offset="1" stop-color="#020406"/></radialGradient></defs>
    <circle r="56" fill="url(#hg)" stroke="#1d2c36"/>
    <g transform="rotate(${-hdg})">${ticks}${needle}</g>
    <path d="M0 -56 L-5 -64 L5 -64 Z" fill="#ffb43c"/>
    <path d="M0 -9 L6 7 L0 3.5 L-6 7 Z" fill="#3be6ff" style="filter:drop-shadow(0 0 4px #3be6ff)"/>`;
}
function updateChips() {
  const n = $('#chipNet'); n.className = 'chip ' + (S.online ? 'ok' : 'warn'); n.lastChild.textContent = S.online ? 'ONLINE' : 'OFFLINE';
  const d = $('#chipData'); d.className = 'chip ' + (S.roadsCount ? 'ok' : 'warn'); d.lastChild.textContent = S.map && S.map.getZoom() < 10.8 ? 'ZOOM IN FOR ROADS' : `ROADS ${S.roadsCount.toLocaleString()}`;
}

// ---------------- search ----------------
function initSearch() {
  const q = $('#q'), sg = $('#suggest');
  q.addEventListener('input', () => renderSuggest(q.value));
  q.addEventListener('focus', () => renderSuggest(q.value));
  q.addEventListener('blur', () => setTimeout(() => sg.classList.add('hidden'), 180));
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); runQuery(q.value); });
}
function renderSuggest(v) {
  const sg = $('#suggest'), items = [];
  const t = v.trim();
  if (t) {
    const p = parseQuery(t);
    if (p?.error) items.push(`<div class="sg err">${p.error}</div>`);
    else if (p) { const r = resolve(p); if (r?.error) items.push(`<div class="sg err">${r.error}</div>`); else if (r) items.push(sgRow(r.label, describe(r), 'q:' + t)); }
    const lower = t.toLowerCase();
    S.pins.filter(x => x.name.toLowerCase().includes(lower)).slice(0, 5).forEach(x => items.push(sgRow('★ ' + x.name, x.label, 'pin:' + x.id)));
  } else {
    S.pins.slice(0, 4).forEach(x => items.push(sgRow('★ ' + x.name, x.label, 'pin:' + x.id)));
    S.history.slice(0, 6).forEach(h => items.push(sgRow(h.label, 'recent', 'q:' + h.q)));
  }
  sg.innerHTML = items.join('');
  sg.classList.toggle('hidden', !items.length);
  sg.querySelectorAll('[data-k]').forEach(el => el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); const k = el.dataset.k;
    if (k.startsWith('pin:')) { const pin = S.pins.find(x => x.id === k.slice(4)); if (pin) setTarget({ kind: 'PIN', center: pin.center, quad: pin.quad, label: pin.label, name: pin.name, d: pin.d }); }
    else runQuery(k.slice(2));
    $('#q').blur();
  }));
}
const sgRow = (a, b, k) => `<div class="sg" data-k="${esc(k)}"><span>${esc(a)}</span><small>${esc(b)}</small></div>`;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function describe(r) {
  if (!S.pos) return r.kind === 'LSD' ? 'legal subdivision' : r.kind;
  const d = dist([S.pos.lon, S.pos.lat], r.center), b = bearing([S.pos.lon, S.pos.lat], r.center);
  return `${fmtDist(d)} ${compassShort(b)}`;
}
function resolve(p) {
  if (!p || p.error) return p;
  if (p.kind === 'LL') {
    const w = S.db?.whereIs(p.lon, p.lat);
    return { kind: 'LL', center: [p.lon, p.lat], label: `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`, sub: w ? w.label : '' };
  }
  if (!S.db) return { error: 'Grid database still loading' };
  const r = S.db.locate(p); if (r.error) return r;
  return { ...r, d: p };
}
function runQuery(v) {
  const p = parseQuery(v);
  if (!p) { const pin = S.pins.find(x => x.name.toLowerCase() === v.trim().toLowerCase()); if (pin) return setTarget({ kind: 'PIN', center: pin.center, quad: pin.quad, label: pin.label, name: pin.name }); return toast('Type an LSD like 11-04-068-10 W5'); }
  const r = resolve(p);
  if (r.error) return toast(r.error);
  S.history = [{ q: v.trim(), label: r.label }, ...S.history.filter(h => h.label !== r.label)].slice(0, 12); store.set('history', S.history);
  $('#q').value = r.label; $('#q').blur();
  setTarget(r);
}

// ---------------- target ----------------
function setTarget(t) {
  S.target = t;
  if (S.nav) endNav(true);
  const feats = [];
  if (t.quad) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...t.quad, t.quad[0]]] } });
  S.map.getSource('target').setData(fc(feats));
  S.tgtMarker.setLngLat(t.center).addTo(S.map);
  $('#tgLabel').textContent = t.name ? `${t.name} · ${t.label}` : t.label;
  $('#target').classList.remove('hidden'); setHudVar();
  clearRouteDisplay();
  setFollow('free');
  const pad = { top: 140, bottom: ($('#hud').offsetHeight || 200) + 30, left: 40, right: 80 };
  if (S.pos) {
    const b = new maplibregl.LngLatBounds([S.pos.lon, S.pos.lat], [S.pos.lon, S.pos.lat]).extend(t.center);
    if (dist([S.pos.lon, S.pos.lat], t.center) < 60000) S.map.fitBounds(b, { padding: pad, maxZoom: 15, duration: 900 });
    else S.map.flyTo({ center: t.center, zoom: 14.5, duration: 1100 });
  } else S.map.flyTo({ center: t.center, zoom: 14.5, duration: 1100 });
  updateHud();
  // online: swap in the official LSD outline
  if (t.kind === 'LSD' && t.d && S.online) D.officialLsd(t.d).then(f => {
    if (!f || S.target !== t) return;
    const ring = f.geometry.coordinates[0];
    S.map.getSource('target').setData(fc([{ type: 'Feature', properties: {}, geometry: f.geometry }]));
    const cxy = ring.slice(0, -1).reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]).map(v => v / (ring.length - 1));
    t.center = cxy; t.official = true; S.tgtMarker.setLngLat(cxy); updateHud();
  }).catch(() => { });
}
function clearTarget() {
  S.target = null; if (S.nav) endNav(true);
  S.tgtMarker.remove(); S.map.getSource('target').setData(fc()); clearRouteDisplay();
  $('#target').classList.add('hidden'); setHudVar(); drawHSI();
}
function onMapTap(ll) {
  if (!S.db) return;
  const w = S.db.whereIs(ll.lng, ll.lat);
  const pr = $('#probe');
  if (!w) { pr.classList.add('hidden'); return; }
  const d = S.pos ? ` · ${fmtDist(dist([S.pos.lon, S.pos.lat], [ll.lng, ll.lat]))} ${compassShort(bearing([S.pos.lon, S.pos.lat], [ll.lng, ll.lat]))}` : '';
  pr.innerHTML = `<div><b>${w.label}</b><small>${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}${d}</small></div><button class="act prime" id="probeGo">SET</button>`;
  pr.classList.remove('hidden');
  $('#probeGo').onclick = () => { pr.classList.add('hidden'); const r = S.db.locate(w); setTarget({ kind: 'PT', quad: r.quad, center: [ll.lng, ll.lat], label: `${w.label} (tapped point)` }); };
  clearTimeout(pr._t); pr._t = setTimeout(() => pr.classList.add('hidden'), 7000);
}

// ---------------- routing ----------------
async function doRoute(reroute = false) {
  if (!S.target) return;
  if (!S.pos) return toast('Waiting for a GPS fix…');
  const from = [S.pos.lon, S.pos.lat], to = S.target.center;
  if (!reroute) busy('PLOTTING ROUTE');
  try {
    const w = Math.min(from[0], to[0]), e = Math.max(from[0], to[0]), s = Math.min(from[1], to[1]), n = Math.max(from[1], to[1]);
    const padX = Math.max(0.08, (e - w) * 0.15), padY = Math.max(0.05, (n - s) * 0.15);
    const box = [w - padX, s - padY, e + padX, n + padY];
    let feats = [];
    if (S.online) {
      const [a, b, c] = await Promise.all([
        D.roadsIn(to[0] - 0.16, to[1] - 0.1, to[0] + 0.16, to[1] + 0.1, true, 'cells', 20),
        D.roadsIn(from[0] - 0.08, from[1] - 0.05, from[0] + 0.08, from[1] + 0.05, true, 'cells', 9),
        D.majorsIn(...box, true).catch(() => []),
      ]);
      feats = [...a, ...b, ...c];
    }
    feats = D.dedupe([...feats, ...await D.allCachedRoadsIn(...box)]);
    const g = new Graph(); g.addFeatures(feats);
    for (const t of S.tracks) if (t.use !== false) g.addLine(t.pts.map(p => [p[0], p[1]]), 99, t.name);
    g.stitch(12);
    const r = planPath(g, from, to);
    if (r.error) { busy(false); return toast(r.error + (S.online ? '' : ' (offline: only saved areas are on the phone)')); }
    r.cum = cumulative(r.path);
    S.route = r;
    S.map.getSource('route').setData(fc([line(r.path)]));
    S.map.getSource('last').setData(fc(r.lastMile > 25 ? [line([r.path[r.path.length - 1], to])] : []));
    if (!reroute) {
      S.map.fitBounds(r.path.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(r.path[0], r.path[0])), { padding: { top: 140, bottom: ($('#hud').offsetHeight || 200) + 30, left: 40, right: 80 }, maxZoom: 15, duration: 900 });
      showRouteSheet(r);
      if (S.online) cacheAlong(r.path); // keep these roads for when the signal drops
    }
  } catch (e) { console.error(e); toast('Route failed: ' + e.message); }
  busy(false);
}
async function cacheAlong(path) {
  const cells = new Set();
  for (let i = 0; i < path.length; i += 3) cells.add(`${Math.floor(path[i][0] / D.CELL)}_${Math.floor(path[i][1] / D.CELL)}`);
  for (const k of cells) { const [gx, gy] = k.split('_').map(Number); await D.roadsIn(gx * D.CELL + 0.01, gy * D.CELL + 0.01, gx * D.CELL + 0.09, gy * D.CELL + 0.09, true, 'cells', 1).catch(() => { }); }
}
function clearRouteDisplay() { S.route = null; S.map.getSource('route')?.setData(fc()); S.map.getSource('last')?.setData(fc()); }
function showRouteSheet(r) {
  const eta = new Date(Date.now() + r.seconds * 1000);
  openSheet(`<h2>ROUTE PLOTTED</h2>
    <div class="kv"><span>DRIVE</span><b>${(r.meters / 1000).toFixed(1)} km · ~${Math.round(r.seconds / 60)} min</b>
    <span>ETA</span><b>${eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>
    <span>LAST LEG</span><b>${r.lastMile > 25 ? fmtDist(r.lastMile) + ' off mapped road to LSD centre' : 'road reaches the LSD'}</b></div>
    <p class="dim">Built on Alberta's road layer${S.tracks.length ? ' plus your recorded tracks' : ''}. Lease roads built after the government's last update won't show — follow site directions if they disagree.</p>
    <div class="btnRow"><button class="act prime" id="bStart">START NAV</button><button class="act" id="bLog2">ROAD LOG</button></div>`);
  $('#bStart').onclick = () => { closeSheet(); startNav(); };
  $('#bLog2').onclick = () => showLog();
}
function showLog() {
  const r = S.route; if (!r) return;
  const along = S.nav?.along || 0;
  openSheet(`<h2>ROAD LOG · ${(r.meters / 1000).toFixed(1)} km</h2><p class="dim">Odometer-style, like written lease directions. Reset TRIP at the start to follow along.</p>
  <div class="log">${r.steps.map((s) => `<div class="row ${s.km * 1000 < along - 30 ? 'done' : ''} ${S.nav && S.nav.stepIdx === r.steps.indexOf(s) ? 'next' : ''}"><div class="km">${s.km.toFixed(1)}</div><div class="grow">${esc(s.text)}</div></div>`).join('')}
  ${r.lastMile > 25 ? `<div class="row"><div class="km">+${(r.lastMile / 1000).toFixed(2)}</div><div class="grow">No mapped road the rest of the way — ${fmtDist(r.lastMile)} ${compassShort(bearing(r.path[r.path.length - 1], S.target.center))} to LSD centre. Look for the access road on the imagery.</div></div>` : ''}</div>`);
}

// ---------------- navigation ----------------
async function startNav() {
  if (!S.route) return;
  S.nav = { stepIdx: 1, spoken: {}, off: 0, lastReroute: 0, along: 0, lastMile: false };
  document.body.classList.add('nav');
  $('#navBanner').classList.remove('hidden'); $('#top').classList.add('hidden');
  $('#navBar').classList.remove('hidden'); $('#target').classList.add('hidden'); setHudVar();
  setFollow('heading');
  try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { }
  say(`Route started. ${(S.route.meters / 1000).toFixed(1)} kilometres.`);
  navTick();
}
function endNav(silent) {
  S.nav = null; document.body.classList.remove('nav');
  $('#navBanner').classList.add('hidden'); $('#top').classList.remove('hidden');
  $('#navBar').classList.add('hidden'); if (S.target) $('#target').classList.remove('hidden'); setHudVar();
  try { S.wakeLock?.release(); } catch { } S.wakeLock = null;
  setFollow('free'); S.map.easeTo({ pitch: 0, duration: 600 });
  if (!silent) toast('Navigation ended');
}
function navTick() {
  const r = S.route, nv = S.nav; if (!r || !nv || !S.pos) return;
  const p = [S.pos.lon, S.pos.lat];
  const pr = progressOn(r.path, r.cum, p);
  nv.along = pr.along;
  const total = r.cum[r.cum.length - 1];
  const remain = Math.max(0, total - pr.along);
  // trim the drawn route to what's ahead
  const ahead = [p, ...r.path.slice(pr.i + 1)];
  if (ahead.length > 1) S.map.getSource('route').setData(fc([line(ahead)]));
  // off-route → reroute (works offline from cached roads)
  if (!nv.lastMile && pr.off > Math.max(50, (S.pos.acc || 10) * 1.5)) nv.off++; else nv.off = 0;
  if (nv.off >= 3 && Date.now() - nv.lastReroute > 15000) { nv.lastReroute = Date.now(); nv.off = 0; say('Off route. Recalculating.'); toast('OFF ROUTE — RECALCULATING'); doRoute(true).then(() => { if (S.route) { nv.stepIdx = 1; nv.spoken = {}; } }); return; }
  // arrival at end of mapped road → last-mile mode
  if (remain < 35 && !nv.lastMile) { nv.lastMile = true; say(r.lastMile > 25 ? `End of mapped road. Lease centre is ${Math.round(r.lastMile)} metres ${compass(bearing(p, S.target.center))}.` : 'You have arrived.'); }
  let step = null;
  while (nv.stepIdx < r.steps.length - 1 && r.steps[nv.stepIdx].km * 1000 < pr.along - 10) nv.stepIdx++;
  step = r.steps[nv.stepIdx];
  const toStep = Math.max(0, step.km * 1000 - pr.along);
  nv.nextAt = step.at;
  if (nv.lastMile) {
    const d = dist(p, S.target.center), b = bearing(p, S.target.center);
    $('#mvDist').textContent = fmtDist(d); $('#mvKm').textContent = 'TO LSD CENTRE';
    $('#mvText').textContent = `Lease ${compass(b)} · ${String(Math.round(b)).padStart(3, '0')}°`;
    $('#mvNext').textContent = r.lastMile > 25 ? 'Off the mapped network — use the imagery and site directions' : 'Arrived';
    setIcon('arrive');
  } else {
    $('#mvDist').textContent = fmtDist(toStep); $('#mvKm').textContent = `@ km ${step.km.toFixed(1)}`;
    $('#mvText').textContent = step.text; setIcon(step.icon);
    const nx = r.steps[nv.stepIdx + 1]; $('#mvNext').textContent = nx ? `then ${nx.text.toLowerCase()} (km ${nx.km.toFixed(1)})` : '';
    const key = nv.stepIdx;
    if (toStep < 900 && toStep > 500 && !nv.spoken[key + 'f']) { nv.spoken[key + 'f'] = 1; say(`In ${roundSpeech(toStep)}, ${step.text}`); }
    if (toStep < 140 && !nv.spoken[key + 'n']) { nv.spoken[key + 'n'] = 1; say(step.text.replace(/ onto .*/, '') + ' now'); }
  }
  $('#nvRem').textContent = fmtDist(remain + (r.lastMile > 25 ? r.lastMile : 0));
  const secs = r.seconds * (remain / Math.max(1, total));
  $('#nvEta').textContent = new Date(Date.now() + secs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#nvAlong').textContent = (pr.along / 1000).toFixed(1);
  drawHSI();
}
const roundSpeech = (m) => m >= 1000 ? `${(m / 1000).toFixed(1)} kilometres` : `${Math.round(m / 50) * 50} metres`;
function setIcon(kind) {
  const P = {
    left: 'M44 54V28H18M28 18L18 28l10 10', right: 'M20 54V28h26M36 18l10 10-10 10',
    'slight-left': 'M40 56V34L22 16M22 30V16h14', 'slight-right': 'M24 56V34l18-18M42 30V16H28',
    'sharp-left': 'M42 14v24L18 52M18 38v14h14', 'sharp-right': 'M22 14v24l24 14M46 38v14H32',
    uturn: 'M42 56V26a10 10 0 0 0-20 0v20M14 38l8 8 8-8', straight: 'M32 56V12M22 22l10-10 10 10',
    start: 'M32 56V12M22 22l10-10 10 10', arrive: 'M32 8v24M20 30l12 14 12-14M16 54h32',
  };
  $('#mvrIcon').innerHTML = `<path d="${P[kind] || P.straight}"/>`;
}
let voices = null;
function say(text) {
  if (!S.prefs.voice || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text.replace(/·/g, ',').replace(/\bkm\b/g, 'kilometres'));
    voices = voices || speechSynthesis.getVoices(); const v = voices.find(v => /en[-_]CA/i.test(v.lang)) || voices.find(v => /^en/i.test(v.lang)); if (v) u.voice = v;
    u.rate = 1.02; speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { }
}

// ---------------- tracks ----------------
async function loadTracks() {
  S.tracks = (await D.idbAll('tracks')).map(([, v]) => v).sort((a, b) => b.created - a.created);
  S.map?.getSource('tracks')?.setData(fc(S.tracks.map(t => line(t.pts))));
}
function toggleRec() {
  if (!S.rec) {
    if (!S.pos) return toast('Need a GPS fix to record');
    S.rec = { pts: [[S.pos.lon, S.pos.lat, Date.now()]], started: Date.now() };
    $('#bRec').classList.add('on'); toast('RECORDING — drive the lease road, tap REC to stop');
  } else {
    const pts = S.rec.pts; S.rec = null; $('#bRec').classList.remove('on'); S.map.getSource('rec').setData(fc());
    if (pts.length < 3) return toast('Track too short — not saved');
    const km = cumulative(pts)[pts.length - 1] / 1000;
    const here = S.db?.whereIs(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    openSheet(`<h2>SAVE TRACK</h2><p>${km.toFixed(2)} km recorded. Saved tracks show in cyan and the router can use them.</p>
      <input class="field" id="trkName" value="${esc(here ? 'Road to ' + here.label : 'Lease road')}">
      <div class="btnRow"><button class="act go2" id="trkSave">SAVE</button><button class="act warn" id="trkDiscard">DISCARD</button></div>`);
    $('#trkSave').onclick = async () => { const id = 't' + Date.now(); await D.idbPut('tracks', id, { id, name: $('#trkName').value || 'Track', pts, created: Date.now(), km }); await loadTracks(); closeSheet(); toast('Track saved'); };
    $('#trkDiscard').onclick = () => { closeSheet(); toast('Discarded'); };
  }
}
function showTracks() {
  openSheet(`<h2>YOUR ROADS</h2><p class="dim">Tracks you drove or imported. Share them with your crew as GPX.</p>
  <div>${S.tracks.map(t => `<div class="row"><div class="grow"><b>${esc(t.name)}</b><small>${t.km.toFixed(2)} km · ${new Date(t.created).toLocaleDateString()}</small></div>
    <button class="act" data-gpx="${t.id}">GPX</button><button class="act warn" data-del="${t.id}">✕</button></div>`).join('') || '<p class="dim">No tracks yet — tap REC while driving a lease road.</p>'}</div>
  <div class="btnRow"><label class="act" style="display:grid;place-items:center">IMPORT GPX<input type="file" id="gpxIn" accept=".gpx,application/gpx+xml,application/xml,text/xml" hidden></label></div>`);
  document.querySelectorAll('[data-gpx]').forEach(b => b.onclick = () => shareGPX(S.tracks.find(t => t.id === b.dataset.gpx)));
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await D.idbDel('tracks', b.dataset.del); await loadTracks(); showTracks(); });
  $('#gpxIn').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const { tracks, wpts } = D.fromGPX(await f.text());
    for (const t of tracks) { const id = 't' + Date.now() + Math.random().toString(36).slice(2, 6); await D.idbPut('tracks', id, { id, name: t.name, pts: t.pts, created: Date.now(), km: cumulative(t.pts)[t.pts.length - 1] / 1000 }); }
    for (const w of wpts) addPin(w.name, [w.lon, w.lat]);
    await loadTracks(); showTracks(); toast(`Imported ${tracks.length} track(s), ${wpts.length} pin(s)`);
  };
}
async function shareGPX(t) {
  const blob = new Blob([D.toGPX(t.name, t.pts)], { type: 'application/gpx+xml' });
  const file = new File([blob], t.name.replace(/[^\w-]+/g, '_') + '.gpx', { type: 'application/gpx+xml' });
  try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: t.name }); return; } } catch { return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------- pins / share ----------------
function addPin(name, center, quad, label) {
  const w = S.db?.whereIs(center[0], center[1]);
  const pin = { id: 'p' + Date.now() + Math.random().toString(36).slice(2, 5), name, center, quad, label: label || (w ? w.label : `${center[1].toFixed(5)}, ${center[0].toFixed(5)}`) };
  S.pins.unshift(pin); store.set('pins', S.pins); return pin;
}
function pinTarget() {
  const t = S.target; if (!t) return;
  openSheet(`<h2>SAVE PIN</h2><p>${esc(t.label)}</p><input class="field" id="pinName" placeholder="e.g. Pad 7 / Battery / Camp" value="${esc(t.name || '')}">
    <div class="btnRow"><button class="act go2" id="pinSave">SAVE</button></div>`);
  $('#pinName').focus();
  $('#pinSave').onclick = () => { const p = addPin($('#pinName').value || t.label, t.center, t.quad, t.label); S.target.name = p.name; $('#tgLabel').textContent = `${p.name} · ${p.label}`; closeSheet(); toast('Pinned — search it by name'); };
}
function showPins() {
  openSheet(`<h2>PINS</h2>${S.pins.map(p => `<div class="row"><div class="grow"><b>★ ${esc(p.name)}</b><small>${esc(p.label)}</small></div><button class="act" data-go="${p.id}">GO</button><button class="act warn" data-pdel="${p.id}">✕</button></div>`).join('') || '<p class="dim">No pins yet. Set a target and tap PIN.</p>'}`);
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { const p = S.pins.find(x => x.id === b.dataset.go); closeSheet(); setTarget({ kind: 'PIN', center: p.center, quad: p.quad, label: p.label, name: p.name }); });
  document.querySelectorAll('[data-pdel]').forEach(b => b.onclick = () => { S.pins = S.pins.filter(x => x.id !== b.dataset.pdel); store.set('pins', S.pins); showPins(); });
}
async function shareTarget() {
  const t = S.target; if (!t) return;
  const [lon, lat] = t.center;
  const text = `${t.name ? t.name + ' — ' : ''}${t.label}\n${lat.toFixed(6)}, ${lon.toFixed(6)}\nhttps://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
  try { if (navigator.share) { await navigator.share({ title: t.label, text }); return; } } catch { return; }
  copy(text);
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast(text); } }

// ---------------- offline packs ----------------
function showPacks() {
  const m = S.map, b = m.getBounds(), cells = D.cellsFor(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
  openSheet(`<h2>OFFLINE AREAS</h2>
  <p>The whole Alberta LSD grid is already on this phone. Roads and cutlines are kept for every area you've viewed or routed through. Save an area before you lose signal so search, your position and routing all work out there.</p>
  <div class="row"><div class="grow"><b>THIS VIEW</b><small>${cells.length} cells · ~${Math.round(cells.length * 0.06 * 10) / 10} MB</small></div>
  <button class="act go2" id="pkSave" ${cells.length > 150 ? 'disabled' : ''}>${cells.length > 150 ? 'ZOOM IN' : 'SAVE'}</button></div>
  <div class="prog hidden" id="pkProg"><i></i></div>
  <h3>SAVED</h3>${S.packs.map(p => `<div class="row"><div class="grow"><b>${esc(p.name)}</b><small>${p.cells} cells · ${new Date(p.ts).toLocaleDateString()}</small></div><button class="act" data-pgo="${p.id}">VIEW</button><button class="act warn" data-pkdel="${p.id}">✕</button></div>`).join('') || '<p class="dim">None yet.</p>'}
  <h3>NOT STORED OFFLINE</h3><p class="dim">Satellite tiles are kept only for places you've already looked at (the imagery licence doesn't allow bulk downloads). The tactical map works fully offline.</p>`);
  $('#pkSave').onclick = async () => {
    if (!S.online) return toast('Need signal to download');
    const pg = $('#pkProg'), bar = pg.firstElementChild; pg.classList.remove('hidden');
    let done = 0;
    const jobs = cells.map(([gx, gy]) => async () => {
      await D.roadsIn(gx * D.CELL + 0.01, gy * D.CELL + 0.01, gx * D.CELL + 0.09, gy * D.CELL + 0.09, true, 'cells', 1);
      await D.roadsIn(gx * D.CELL + 0.01, gy * D.CELL + 0.01, gx * D.CELL + 0.09, gy * D.CELL + 0.09, true, 'cuts', 1);
      bar.style.width = (++done / cells.length * 100) + '%';
    });
    const workers = Array.from({ length: 4 }, async () => { while (jobs.length) await jobs.shift()().catch(() => { }); });
    await Promise.all(workers);
    const c = m.getCenter(), here = S.db?.whereIs(c.lng, c.lat);
    S.packs.unshift({ id: 'k' + Date.now(), name: here ? `Around TWP ${here.t} RGE ${here.r} W${here.m}` : 'Saved area', cells: cells.length, ts: Date.now(), center: [c.lng, c.lat], zoom: m.getZoom() });
    store.set('packs', S.packs); toast('Area saved for offline'); showPacks(); refreshData();
  };
  document.querySelectorAll('[data-pgo]').forEach(b => b.onclick = () => { const p = S.packs.find(x => x.id === b.dataset.pgo); closeSheet(); S.map.flyTo({ center: p.center, zoom: p.zoom }); });
  document.querySelectorAll('[data-pkdel]').forEach(b => b.onclick = () => { S.packs = S.packs.filter(x => x.id !== b.dataset.pkdel); store.set('packs', S.packs); showPacks(); });
}

// ---------------- weather ----------------
const WMO = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail' };
async function showWeather() {
  const t = S.target; if (!t) return;
  openSheet(`<h2>LEASE CONDITIONS</h2><p class="dim">${esc(t.label)}</p><div id="wxBody"><p>Loading…</p></div>`);
  let j;
  try { j = await D.leaseWeather(t.center[1], t.center[0]); }
  catch { const last = await D.idbGet('kv', 'wx_last'); if (last && dist([last.lon, last.lat], t.center) < 20000) { j = last.j; j._stale = last.ts; } }
  if (!j) { $('#wxBody').innerHTML = '<p>No signal and no saved forecast for this area.</p>'; return; }
  const dd = j.daily, today = dd.time.indexOf(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }));
  const ti = today >= 0 ? today : 3;
  const past = dd.precipitation_sum.slice(Math.max(0, ti - 3), ti).reduce((a, b) => a + (b || 0), 0);
  const pastSnow = dd.snowfall_sum.slice(Math.max(0, ti - 3), ti).reduce((a, b) => a + (b || 0), 0);
  const maxPast = Math.max(...dd.temperature_2m_max.slice(Math.max(0, ti - 3), ti + 1));
  let risk, cls;
  if (maxPast <= 0.5) { risk = pastSnow > 5 ? `Frozen ground, ${pastSnow.toFixed(0)} cm new snow — expect plowing needs` : 'Frozen — lease roads likely firm'; cls = pastSnow > 5 ? 'mod' : 'low'; }
  else if (past >= 15) { risk = `HIGH mud risk — ${past.toFixed(0)} mm in the last 3 days`; cls = 'high'; }
  else if (past >= 5) { risk = `Moderate mud risk — ${past.toFixed(0)} mm in the last 3 days`; cls = 'mod'; }
  else { risk = `Low mud risk — ${past.toFixed(1)} mm in the last 3 days`; cls = 'low'; }
  const cur = j.current || {};
  $('#wxBody').innerHTML = `${j._stale ? `<p class="dim">Saved forecast from ${new Date(j._stale).toLocaleString()}</p>` : ''}
  <div class="big">${Math.round(cur.temperature_2m)}°C <span style="font-size:14px;color:var(--dim)">feels ${Math.round(cur.apparent_temperature)}° · ${WMO[cur.weather_code] || ''}</span></div>
  <div class="kv"><span>WIND</span><b>${Math.round(cur.wind_speed_10m)} km/h · gusts ${Math.round(cur.wind_gusts_10m)}</b></div>
  <div class="risk ${cls}">${risk}</div>
  <h3>LAST 3 DAYS → NEXT 3</h3>
  <div class="wxGrid">${dd.time.map((d, i) => `<div class="ro" style="${i === ti ? 'border-color:var(--amber)' : i < ti ? 'opacity:.65' : ''}"><label>${new Date(d + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric' }).toUpperCase()}</label><b>${Math.round(dd.temperature_2m_min[i])}/${Math.round(dd.temperature_2m_max[i])}°</b><small class="dim">${(dd.precipitation_sum[i] || 0).toFixed(1)} mm${dd.snowfall_sum[i] ? ` · ${dd.snowfall_sum[i].toFixed(0)} cm` : ''}</small></div>`).join('')}</div>
  <p class="dim">Forecast model data (Open-Meteo), not a site report. Rough guide only.</p>`;
}

// ---------------- SOS ----------------
function showSOS() {
  const p = S.pos, w = S.here;
  const dms = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60; return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(1)}"${v >= 0 ? pos : neg}`; };
  const txt = p ? `My location: ${w ? 'LSD ' + w.label : ''}\n${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}\n(${dms(p.lat, 'N', 'S')} ${dms(p.lon, 'E', 'W')}) ±${Math.round(p.acc)} m` : '';
  openSheet(`<h2>EMERGENCY LOCATION</h2>${p ? `
    <p class="dim">Read this to 911 or the site safety line.</p>
    <div class="big">${w ? (w.onGrid ? '' : '≈ ') + w.label : '—'}</div>
    <div class="kv"><span>LAT/LON</span><b>${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</b><span>DMS</span><b>${dms(p.lat, 'N', 'S')} ${dms(p.lon, 'E', 'W')}</b>
    <span>ACCURACY</span><b>±${Math.round(p.acc)} m</b><span>FIX</span><b>${new Date(p.ts).toLocaleTimeString()}</b></div>
    <div class="btnRow"><button class="act prime" id="sosCopy">COPY</button><button class="act" id="sosShare">SEND</button><a class="act warn" href="tel:911" style="display:grid;place-items:center;text-decoration:none">CALL 911</a></div>` : '<p>No GPS fix yet.</p>'}`);
  if (p) { $('#sosCopy').onclick = () => copy(txt); $('#sosShare').onclick = async () => { try { await navigator.share({ text: txt }); } catch { copy(txt); } }; }
}

// ---------------- layers / menu / about ----------------
function showLayers() {
  const p = S.prefs;
  openSheet(`<h2>MAP</h2>
    <div class="seg"><button data-base="sat" class="${p.base === 'sat' ? 'on' : ''}">SATELLITE</button><button data-base="tac" class="${p.base === 'tac' ? 'on' : ''}">TACTICAL</button></div>
    ${[['terrain', '3D TERRAIN', 'online only'], ['grid', 'LSD GRID', 'sections, quarters, LSD numbers'], ['cuts', 'CUTLINES', 'seismic / pipeline cuts'], ['tracks', 'YOUR ROADS', 'recorded + imported tracks'], ['voice', 'VOICE', 'spoken turn prompts']]
      .map(([k, t, s]) => `<div class="row"><div class="grow"><b>${t}</b><small>${s}</small></div><button class="tog ${p[k] ? 'on' : ''}" data-tog="${k}"></button></div>`).join('')}
    <h3>ROAD KEY</h3>
    <div class="kv" style="font-size:12px">${[['#f5f8fa', 'paved highway'], ['#ffb43c', 'two-lane gravel'], ['#ef8f2a', 'one-lane gravel'], ['#d0904c', 'dry-weather (dashed)'], ['#86c0ff', 'winter road (dashed)'], ['#b08f63', 'lease access / driveway'], ['#62e39a', 'cutline'], ['#3be6ff', 'your tracks'], ['#ff3df2', 'active route']].map(([c, t]) => `<span style="display:inline-block;width:26px;height:4px;margin-top:7px;background:${c};box-shadow:0 0 6px ${c}"></span><b style="font-weight:400">${t}</b>`).join('')}</div>`);
  document.querySelectorAll('[data-base]').forEach(b => b.onclick = () => { p.base = b.dataset.base; savePrefs(); applyPrefs(); showLayers(); });
  document.querySelectorAll('[data-tog]').forEach(b => b.onclick = () => { const k = b.dataset.tog; p[k] = !p[k]; if (k === 'terrain' && p[k] && !S.online) toast('3D terrain needs signal'); savePrefs(); applyPrefs(); if (k === 'cuts' || k === 'grid') refreshData(); showLayers(); });
}
function showMenu() {
  openSheet(`<h2>SYSTEMS</h2>
    ${[['mPins', '★ PINS', `${S.pins.length} saved`], ['mTracks', 'YOUR ROADS', `${S.tracks.length} tracks · GPX share/import`], ['mSOS', 'EMERGENCY LOCATION', 'LSD + coordinates for 911'], ['mOdo', 'RESET TRIP ODOMETER', `${(S.odo.m / 1000).toFixed(1)} km`], ['mAbout', 'ABOUT & ACCURACY', 'data sources, limits']]
      .map(([id, t, s]) => `<div class="row" id="${id}"><div class="grow"><b>${t}</b><small>${s}</small></div><span class="dim">›</span></div>`).join('')}`);
  $('#mPins').onclick = showPins; $('#mTracks').onclick = showTracks; $('#mSOS').onclick = showSOS; $('#mAbout').onclick = showAbout;
  $('#mOdo').onclick = () => { resetOdo(); closeSheet(); };
}
function showAbout() {
  openSheet(`<h2>ABOUT LEASELINE</h2>
  <p><b style="color:var(--amber)">LSD positions</b> come from the Government of Alberta's ATS v4.1 survey grid, stored on the phone (all 252,578 sections). Checked against the official LSD polygons: typically within ~4 m of the official LSD centre, worst case found ~35 m. Fractional sections use the official centres directly. Online, the exact official LSD outline is drawn.</p>
  <p><b style="color:var(--amber)">Roads & cutlines</b>: Alberta Base Features (Access & Facility Roads, Cutlines). New lease roads appear only after the province updates its layer — record your own tracks to fill gaps.</p>
  <p><b style="color:var(--amber)">Routing</b> runs on the phone, so it keeps working with no signal over any roads already stored.</p>
  <p><b style="color:var(--amber)">Not covered</b>: Saskatchewan/BC grids, well licences and facility names.</p>
  <p class="dim">Contains information licensed under the Open Government Licence – Alberta. Imagery © Esri, Maxar, Earthstar Geographics. Terrain: AWS Terrain Tiles. Weather: Open-Meteo. Personal-use build — always follow site directions and your company's journey management.</p>`);
}
function resetOdo() { S.odo = { m: 0 }; S.odoLast = S.pos ? [S.pos.lon, S.pos.lat] : null; store.set('odo', S.odo); updateHud(); toast('Trip odometer reset'); }

// ---------------- sheet / toast / busy ----------------
function openSheet(html) { $('#sheetBody').innerHTML = html.replace('</h2>', '</h2>').replace(/<h2>/, '<button class="x sheetX" onclick="document.querySelector(\'#sheetBack\').click()">✕</button><h2>'); $('#sheet').classList.remove('hidden'); $('#sheetBack').classList.remove('hidden'); $('#sheet').scrollTop = 0; }
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBack').classList.add('hidden'); }
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 3200); }
function busy(msg) { $('#busy').classList.toggle('hidden', !msg); if (msg) $('#busyText').textContent = msg; }

// ---------------- helpers ----------------
function fmtDist(m) { return m >= 10000 ? (m / 1000).toFixed(0) + ' km' : m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m'; }
function line(pts) { return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map(p => [p[0], p[1]]) } }; }
function circle(c, r) { const pts = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * 2 * Math.PI; pts.push([c[0] + r / (111320 * Math.cos(c[1] * Math.PI / 180)) * Math.cos(a), c[1] + r / 110574 * Math.sin(a)]); } return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } }; }

// ---------------- wire up ----------------
function initUI() {
  initSearch();
  $('#bFollow').onclick = () => setFollow(S.follow === 'free' ? 'north' : S.follow === 'north' ? 'heading' : 'free');
  $('#bLayers').onclick = showLayers; $('#bRec').onclick = toggleRec; $('#bPacks').onclick = showPacks; $('#bMenu').onclick = showMenu;
  $('#tgClear').onclick = clearTarget; $('#bRoute').onclick = () => doRoute(false); $('#bWx').onclick = showWeather; $('#bShare').onclick = shareTarget; $('#bPin').onclick = pinTarget;
  $('#bLog').onclick = showLog; $('#bEnd').onclick = () => endNav(false);
  $('#roOdoBox').onclick = resetOdo;
  $('#sheetBack').onclick = closeSheet;
  window.addEventListener('online', () => { S.online = true; updateChips(); refreshData(); });
  window.addEventListener('offline', () => { S.online = false; updateChips(); if (S.prefs.terrain) applyPrefs(); });
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && S.nav && !S.wakeLock) { try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { } } });
  updateChips(); drawHSI(); setHudVar();
  // deep link: #lsd=... not allowed in every host; support ?q=
  const q = new URLSearchParams(location.search).get('q'); if (q) setTimeout(() => runQuery(q), 600);
}

window.__LL = S; // debug handle
boot();
