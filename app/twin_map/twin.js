/* Baghdad digital twin: interactive 3D map (MapLibre basemap + deck.gl layers).
 *
 * Runs on its own (open twin_map/index.html through any web server) or inside the Streamlit
 * app (app.py), which sends the simulated scenario through the Streamlit component protocol.
 * Data comes from twin_map/data/, written by build_twin_data.py.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ constants
  const KX = 111320 * Math.cos(33.3 * Math.PI / 180);   // meters per degree (same as simulate.py)
  const KY = 110574;
  const LAT0 = 33.29 * Math.PI / 180;
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const CARTO = (style) => ['a', 'b', 'c'].map(s => `https://${s}.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`);
  const ROOF_ZOOM = 16;           // ~2 m per pixel at Baghdad: enough for a roof's average color
  const ROOF_CACHE = 'twin-roofs-v2';
  const START_VIEW = { center: [44.405, 33.283], zoom: 13.55, pitch: 52, bearing: 18 };

  const HEAT = [[49, 54, 149], [69, 117, 180], [116, 173, 209], [171, 217, 233], [254, 224, 144], [253, 174, 97], [244, 109, 67], [215, 48, 39], [165, 0, 38]];
  const TRAFFIC = [[40, 200, 120], [150, 215, 70], [250, 215, 60], [248, 140, 45], [230, 60, 55], [140, 15, 45]];
  const AIR = [[60, 200, 140], [190, 220, 80], [250, 200, 60], [245, 120, 50], [210, 40, 70], [120, 30, 110]];
  const POWER = [[40, 30, 110], [100, 40, 170], [170, 50, 170], [230, 80, 120], [250, 150, 60], [250, 230, 100]];
  const NDVI = [[150, 110, 70], [200, 170, 110], [210, 210, 130], [140, 190, 90], [40, 130, 60]];
  const SIZE = [[70, 120, 235], [150, 80, 225], [230, 75, 160], [250, 145, 60], [250, 230, 90]];
  const DIVERGE = [[40, 100, 220], [140, 180, 240], [235, 235, 235], [250, 160, 110], [215, 40, 40]];
  const CONCRETE = [[214, 205, 188], [200, 190, 172], [188, 180, 166], [222, 214, 200], [205, 188, 160], [180, 172, 160]];
  const NODATA = [125, 132, 145];

  // metric: key in the zone profiles; scale: value -> shown unit
  const MODES = [
    { id: 'real', label: 'Realistic', tag: 'satellite' },
    { id: 'temp', label: 'Air temperature', tag: 'sim', metric: 'temp', unit: '°C', domain: [28, 56], ramp: HEAT, delta: 4, fmt: v => v.toFixed(1) },
    { id: 'traffic', label: 'Traffic', tag: 'sim', metric: 'traffic', unit: 'index', domain: [0, 1.2], ramp: TRAFFIC, delta: 0.4, fmt: v => v.toFixed(2) },
    { id: 'elec', label: 'Electricity', tag: 'sim', metric: 'elec_m2', scale: 1000, unit: 'Wh per m² per hour', domain: [15, 75], ramp: POWER, delta: 12, fmt: v => v.toFixed(0) },
    { id: 'no2', label: 'Air quality (NO₂)', tag: 'sim', metric: 'no2', unit: 'µg/m³', domain: [10, 110], ramp: AIR, delta: 30, fmt: v => v.toFixed(0) },
    { sep: true },
    { id: 'lst', label: 'Surface temp', tag: 'real', unit: '°C', domain: [44, 56], ramp: HEAT, fmt: v => v.toFixed(1) },
    { id: 'ndvi', label: 'Vegetation', tag: 'real', unit: 'NDVI', domain: [-0.05, 0.6], ramp: NDVI, fmt: v => v.toFixed(2) },
    { id: 'size', label: 'Building size', tag: '', unit: 'm² footprint', domain: [Math.log10(50), Math.log10(5000)], ramp: SIZE },
  ];
  const ROAD = {   // width m, cars per km at traffic index 1, free speed m/s
    motorway: [16, 60, 25], trunk: [14, 52, 22], primary: [11, 42, 16], secondary: [9, 32, 14],
    tertiary: [7, 20, 11], residential: [5, 7, 8], living_street: [4, 3, 5], service: [3.5, 3, 6],
    unclassified: [5, 6, 8],
  };
  const QUALITY = {
    high: { label: 'High', dpr: () => window.devicePixelRatio || 1, trees: 'mesh', cars: 1, maxCars: 9000, wire: true },
    medium: { label: 'Medium', dpr: () => Math.min(window.devicePixelRatio || 1, 1.25), trees: 'column', cars: 0.6, maxCars: 4500, wire: false },
    low: { label: 'Low', dpr: () => 1, trees: 'dots', cars: 0.35, maxCars: 1800, wire: false },
  };
  const LEVELS = ['high', 'medium', 'low'];

  // ------------------------------------------------------------------ state
  const S = {
    // Land cover first: every open space is filled (green plants, sand, built-up, water);
    // the Satellite photo is one click away
    mode: 'real', basemap: 'landcover', hour: 15, playing: false, delta: false,
    traffic: true, trees: true, cells: false, labels: true,
    qualityPick: store('twin-quality') || 'auto', quality: 'high',
    prof: null, base: null, scenario: { traffic_mult: 1, heat_delta: 0 },
    sel: null, orbit: true, isolate: false, colorVersion: 0, roadVersion: 0, dayF: 1,
  };
  let B, R, T, Z, G, W, SCENE;          // buildings, roads, trees, zones, green, water, scene
  let map, overlay, colorBuf, roofBuf, roofDone = 0, roofTotal = 0;
  let cars = null, lastCarHour = -1, rafId = 0, lastFrame = 0, userBusy = false;

  // ------------------------------------------------------------------ helpers
  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* private mode */ }
    return null;
  }
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  function ramp(stops, t) {
    t = clamp(t, 0, 1) * (stops.length - 1);
    const i = Math.min(Math.floor(t), stops.length - 2), f = t - i;
    return [0, 1, 2].map(k => Math.round(lerp(stops[i][k], stops[i + 1][k], f)));
  }
  const css = (stops) => `linear-gradient(90deg, ${stops.map((c, i) => `rgb(${c}) ${(i / (stops.length - 1) * 100).toFixed(0)}%`).join(', ')})`;
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const modeInfo = () => MODES.find(m => m.id === S.mode);
  const fmtHour = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

  /** Simulated value for zone z at the current (fractional) hour. */
  function zoneValue(prof, z, metric, hour = S.hour) {
    const p = prof && prof[Z.id[z]];
    if (!p) return null;
    const arr = p[metric], h0 = Math.floor(hour) % 24, h1 = (h0 + 1) % 24;
    return lerp(arr[h0], arr[h1], hour - Math.floor(hour));
  }

  // ------------------------------------------------------------------ sun and day/night
  /** Sun direction for Baghdad on 15 July at local clock hour h (UTC+3). */
  function sun(h) {
    const decl = 21.5 * Math.PI / 180;
    const H = (h - 12.13) * 15 * Math.PI / 180;          // solar noon is about 12:08 local
    const sinEl = Math.sin(LAT0) * Math.sin(decl) + Math.cos(LAT0) * Math.cos(decl) * Math.cos(H);
    const el = Math.asin(sinEl);
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT0) - Math.tan(decl) * Math.cos(LAT0)) + Math.PI;
    return { el, az, deg: el * 180 / Math.PI };
  }
  function lighting() {
    const s = sun(S.hour);
    S.dayF = clamp((s.deg + 6) / 14, 0, 1);               // 0 at night, 1 once the sun is 8 degrees up
    const low = clamp(1 - s.deg / 25, 0, 1);               // warm light near sunrise/sunset
    const toSun = [Math.sin(s.az) * Math.cos(s.el), Math.cos(s.az) * Math.cos(s.el), Math.max(Math.sin(s.el), 0.05)];
    const sunColor = [255, Math.round(lerp(248, 190, low)), Math.round(lerp(235, 140, low))];
    return new deck.LightingEffect({
      ambient: new deck.AmbientLight({ color: S.dayF > 0.5 ? [255, 255, 255] : [160, 178, 255], intensity: lerp(0.6, 1.0, S.dayF) }),
      sun: new deck.DirectionalLight({ color: sunColor, intensity: 1.9 * S.dayF, direction: toSun.map(v => -v) }),
      sky: new deck.DirectionalLight({ color: [160, 190, 255], intensity: lerp(0.35, 0.45, S.dayF), direction: [0.4, -0.6, -1] }),
    });
  }
  function applyDayNight() {
    if (!map || !map.isStyleLoaded()) return;
    const d = S.dayF;
    for (const id of ['sat', 'lc', 'carto-light', 'carto-dark']) {
      if (map.getLayer(id)) {
        map.setPaintProperty(id, 'raster-brightness-max', lerp(0.33, 1, d));
        map.setPaintProperty(id, 'raster-saturation', lerp(-0.45, id === 'sat' ? 0.08 : 0, d));
      }
    }
    const mix = (a, b) => `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], d))).join(',')})`;
    try {
      map.setSky({
        'sky-color': mix([8, 14, 36], [96, 160, 235]), 'horizon-color': mix([30, 42, 80], [230, 238, 248]),
        'fog-color': mix([18, 26, 50], [220, 228, 238]), 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7,
        'fog-ground-blend': 0.9, 'atmosphere-blend': 0,
      });
    } catch (e) { /* older MapLibre without sky */ }
    $('sun').textContent = d > 0.5 ? '☀' : d > 0.05 ? '🌅' : '🌙';
  }

  // ------------------------------------------------------------------ building colors
  function realColor(i) {
    if (roofBuf && roofBuf[i * 4 + 3]) return [roofBuf[i * 4], roofBuf[i * 4 + 1], roofBuf[i * 4 + 2]];
    return CONCRETE[hash(B.id[i]) % CONCRETE.length];
  }
  function colorFor(i) {
    const m = modeInfo();
    if (S.mode === 'real') return realColor(i);
    if (S.mode === 'size') return ramp(SIZE, (Math.log10(Math.max(B.a[i], 1)) - m.domain[0]) / (m.domain[1] - m.domain[0]));
    if (S.mode === 'lst' || S.mode === 'ndvi') {
      const v = B[S.mode][i];
      return v == null ? NODATA : ramp(m.ramp, (v - m.domain[0]) / (m.domain[1] - m.domain[0]));
    }
    const k = m.scale || 1;
    const v = zoneValue(S.prof, B.z[i], m.metric);
    if (v == null) return NODATA;
    if (S.delta && S.base) {
      const d = (v - zoneValue(S.base, B.z[i], m.metric)) * k;
      return ramp(DIVERGE, 0.5 + d / (2 * m.delta));
    }
    return ramp(m.ramp, (v * k - m.domain[0]) / (m.domain[1] - m.domain[0]));
  }
  function recolor() {
    const n = B.id.length;
    if (!colorBuf) colorBuf = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const c = colorFor(i);
      colorBuf[i * 4] = c[0]; colorBuf[i * 4 + 1] = c[1]; colorBuf[i * 4 + 2] = c[2];
      colorBuf[i * 4 + 3] = S.isolate && S.sel != null && i !== S.sel ? 45 : 255;
    }
    S.colorVersion++;
    S.roadVersion++;
  }

  // ------------------------------------------------------------------ real roof colors from satellite
  function tileOf(lon, lat, z) {
    const n = 2 ** z, r = lat * Math.PI / 180;
    return [(lon + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n];
  }
  async function sampleRoofs() {
    const n = B.id.length;
    roofBuf = new Uint8ClampedArray(n * 4);
    const key = `${ROOF_CACHE}-${n}`;
    const cached = store(key);
    if (cached) {
      try {
        const bin = atob(cached);
        for (let i = 0; i < bin.length && i < roofBuf.length; i++) roofBuf[i] = bin.charCodeAt(i);
        roofDone = roofTotal = 1; setPerf(); recolor(); render(); return;
      } catch (e) { /* bad cache: resample */ }
    }
    const byTile = new Map();
    const mPerPx = 156543.03 * Math.cos(LAT0) / 2 ** ROOF_ZOOM;
    for (let i = 0; i < n; i++) {
      const [tx, ty] = tileOf(B.c[i][0], B.c[i][1], ROOF_ZOOM);
      const k = `${Math.floor(tx)}/${Math.floor(ty)}`;
      if (!byTile.has(k)) byTile.set(k, []);
      byTile.get(k).push([i, (tx % 1) * 256, (ty % 1) * 256]);
    }
    const tiles = [...byTile.entries()];
    roofTotal = tiles.length; roofDone = 0;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let failed = 0, lastPaint = 0;
    const work = async ([k, items]) => {
      const [x, y] = k.split('/');
      try {
        const res = await fetch(ESRI.replace('{z}', ROOF_ZOOM).replace('{x}', x).replace('{y}', y), { mode: 'cors' });
        if (!res.ok) throw new Error(res.status);
        const bmp = await createImageBitmap(await res.blob());
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, 256, 256).data;
        for (const [i, cx, cy] of items) {
          // Look at the middle 60% of the roof: edges pick up shadows and the street
          const half = clamp(Math.round(Math.sqrt(B.a[i]) / 2 / mPerPx * 0.6), 1, 12);
          const r = [], g = [], b = [];
          for (let yy = Math.max(0, Math.round(cy) - half); yy <= Math.min(255, Math.round(cy) + half); yy++) {
            for (let xx = Math.max(0, Math.round(cx) - half); xx <= Math.min(255, Math.round(cx) + half); xx++) {
              const o = (yy * 256 + xx) * 4; r.push(px[o]); g.push(px[o + 1]); b.push(px[o + 2]);
            }
          }
          const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
          // Imagery is a bit hazy: add a little contrast so walls and roofs read clearly in 3D
          const lift = (v) => clamp((v - 128) * 1.15 + 136, 0, 255);
          let rgb = [lift(med(r)), lift(med(g)), lift(med(b))];
          // Tall buildings lean in the photo, so their footprint often lands on their own shadow:
          // blend very dark samples toward concrete instead of drawing black towers
          const lum = 0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2];
          if (lum < 95) { const c = CONCRETE[hash(B.id[i]) % CONCRETE.length], k = (95 - lum) / 95; rgb = rgb.map((v, j) => lerp(v, c[j] * 0.8, Math.min(1, k * 1.4))); }
          roofBuf[i * 4] = rgb[0]; roofBuf[i * 4 + 1] = rgb[1]; roofBuf[i * 4 + 2] = rgb[2]; roofBuf[i * 4 + 3] = 1;
        }
      } catch (e) { failed++; }
      roofDone++;
      if (performance.now() - lastPaint > 700) { lastPaint = performance.now(); setPerf(); if (S.mode === 'real') { recolor(); render(); } }
    };
    const queue = tiles.slice();
    await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) await work(queue.shift()); }));
    setPerf(failed === roofTotal ? 'Roof colors need internet (satellite unavailable)' : null);
    if (failed < roofTotal * 0.2) {
      let bin = ''; for (let i = 0; i < roofBuf.length; i++) bin += String.fromCharCode(roofBuf[i]);
      store(key, btoa(bin));
    }
    recolor(); render();
  }

  // ------------------------------------------------------------------ traffic (moving cars)
  function prepRoads() {
    // cumulative length (m) along each road, its zone and class settings
    R.cum = R.path.map(p => {
      const c = new Float64Array(p.length);
      for (let k = 1; k < p.length; k++) c[k] = c[k - 1] + Math.hypot((p[k][0] - p[k - 1][0]) * KX, (p[k][1] - p[k - 1][1]) * KY);
      return c;
    });
    const zc = Z.cell.map(c => [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2]);
    R.zone = R.path.map(p => {
      const m = p[p.length >> 1];
      let best = 0, bd = Infinity;
      zc.forEach((c, z) => { const d = ((c[0] - m[0]) * KX) ** 2 + ((c[1] - m[1]) * KY) ** 2; if (d < bd) { bd = d; best = z; } });
      return best;
    });
    R.cfg = R.cls.map(c => ROAD[c] || ROAD.unclassified);
    R.list = R.path.map((path, i) => ({ i, path }));
  }
  function roadTraffic(i) { return zoneValue(S.prof, R.zone[i], 'traffic') ?? 0.2; }
  function buildCars() {
    const q = QUALITY[S.quality];
    const rand = rng(7);
    const road = [], s0 = [], dir = [], speed = [], tail = [];
    for (let i = 0; i < R.path.length; i++) {
      const L = R.cum[i][R.cum[i].length - 1];
      if (L < 15) continue;
      const tr = roadTraffic(i), [, perKm, vmax] = R.cfg[i];
      const expected = L / 1000 * perKm * tr * q.cars;
      const count = Math.floor(expected + rand());
      // Congestion: the busier the road, the slower the cars (shown 4x faster than real time)
      const v = vmax * clamp(1 - 0.55 * tr, 0.15, 1) * 4;
      for (let k = 0; k < count; k++) {
        road.push(i); s0.push(rand() * L); dir.push(rand() < 0.5 ? 1 : -1); speed.push(v * lerp(0.85, 1.15, rand()));
        tail.push(clamp(6 + v * 0.35, 6, 40));
      }
      if (road.length >= q.maxCars) break;
    }
    const n = road.length;
    cars = { n, road: Int32Array.from(road), s0: Float64Array.from(s0), dir: Int8Array.from(dir), speed: Float32Array.from(speed),
      tail: Float32Array.from(tail), src: new Float64Array(n * 2), dst: new Float64Array(n * 2), col: new Uint8ClampedArray(n * 4) };
    colorCars();
    lastCarHour = Math.floor(S.hour);
  }
  function colorCars() {
    if (!cars) return;
    const night = 1 - S.dayF;
    for (let c = 0; c < cars.n; c++) {
      // White headlights one way, red tail lights the other at night; in Traffic mode the roads
      // already carry the congestion colors, so cars stay bright white to stand out on them
      let col;
      if (S.mode === 'traffic') col = [255, 255, 255];
      else col = cars.dir[c] > 0 ? [lerp(240, 255, night), lerp(245, 236, night), lerp(255, 190, night)] : [255, lerp(240, 70, night), lerp(240, 60, night)];
      cars.col.set([col[0], col[1], col[2], 235], c * 4);
    }
  }
  function pointAt(i, s, out, o) {
    const cum = R.cum[i], p = R.path[i];
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const seg = cum[hi] - cum[lo] || 1, f = (s - cum[lo]) / seg;
    out[o] = lerp(p[lo][0], p[hi][0], f); out[o + 1] = lerp(p[lo][1], p[hi][1], f);
  }
  function moveCars(t) {
    for (let c = 0; c < cars.n; c++) {
      const i = cars.road[c], L = R.cum[i][R.cum[i].length - 1];
      let s = (cars.s0[c] + cars.dir[c] * cars.speed[c] * t) % L; if (s < 0) s += L;
      const back = clamp(s - cars.dir[c] * cars.tail[c], 0, L);
      pointAt(i, s, cars.dst, c * 2);
      pointAt(i, back, cars.src, c * 2);
    }
  }

  // ------------------------------------------------------------------ 3D tree mesh
  function icosphere() {
    const t = (1 + Math.sqrt(5)) / 2;
    let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const mid = {}; const m = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (mid[k] == null) { v.push(v[a].map((x, i) => (x + v[b][i]) / 2)); mid[k] = v.length - 1; } return mid[k]; };
    f = f.flatMap(([a, b, c]) => { const ab = m(a, b), bc = m(b, c), ca = m(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
    v = v.map(p => { const l = Math.hypot(...p); return p.map(x => x / l); });
    const pos = new Float32Array(v.flat()), idx = new Uint16Array(f.flat());
    return { attributes: { POSITION: { value: pos, size: 3 }, NORMAL: { value: pos, size: 3 } }, indices: { value: idx, size: 1 }, topology: 'triangle-list' };
  }
  const SPHERE = icosphere();

  // ------------------------------------------------------------------ layers
  function layers() {
    const q = QUALITY[S.quality], m = modeInfo(), night = 1 - S.dayF;
    const sim = m.tag === 'sim';
    const out = [];
    const ground = S.basemap !== 'satellite';

    if (ground) {
      out.push(new deck.SolidPolygonLayer({ id: 'water', data: W.poly, getPolygon: d => d, getFillColor: [45, 110, 175, 235] }));
      out.push(new deck.SolidPolygonLayer({ id: 'green', data: G.poly, getPolygon: d => d, getFillColor: [112, 176, 80, 210] }));
    }
    if (S.cells && sim) {
      out.push(new deck.SolidPolygonLayer({
        id: 'cells', data: Z.cell.map((c, z) => ({ c, z })), getPolygon: d => d.c,
        getFillColor: d => {
          const v = zoneValue(S.prof, d.z, m.metric);
          if (S.delta && S.base) return [...ramp(DIVERGE, 0.5 + (v - zoneValue(S.base, d.z, m.metric)) * (m.scale || 1) / (2 * m.delta)), 120];
          return [...ramp(m.ramp, (v * (m.scale || 1) - m.domain[0]) / (m.domain[1] - m.domain[0])), 110];
        },
        updateTriggers: { getFillColor: S.colorVersion },
      }));
    }
    // roads: congestion colors in traffic mode, warm street lights at night
    out.push(new deck.PathLayer({
      id: 'roads', data: R.list, getPath: d => d.path, widthUnits: 'meters', widthMinPixels: 1,
      getWidth: d => R.cfg[d.i][0] * (S.mode === 'traffic' ? 1 : 0.55), capRounded: true, jointRounded: true,
      getColor: d => {
        if (S.mode === 'traffic') return [...ramp(TRAFFIC, roadTraffic(d.i) / 1.2), 230];
        if (night > 0.3) return [255, 180, 95, Math.round(70 + 110 * night)];
        return S.basemap === 'satellite' ? [255, 255, 255, 55] : S.basemap === 'dark' ? [70, 110, 150, 180] : [92, 92, 100, 200];
      },
      updateTriggers: { getColor: [S.roadVersion, S.mode, S.basemap, Math.round(night * 10)], getWidth: S.mode },
    }));
    if (S.traffic && cars && cars.n) {
      out.push(new deck.LineLayer({
        id: 'cars', data: { length: cars.n, attributes: {
          getSourcePosition: { value: cars.src, size: 2 }, getTargetPosition: { value: cars.dst, size: 2 },
          getColor: { value: cars.col, size: 4 } } },
        widthUnits: 'pixels', getWidth: night > 0.4 ? 3 : 2.4, parameters: { depthWriteEnabled: false },
      }));
    }
    // study area rings
    out.push(new deck.PathLayer({
      id: 'rings', data: Object.values(SCENE.districts).map(d => ring(d.center, d.radius_m)), getPath: d => d,
      getColor: [61, 214, 255, 170], widthUnits: 'pixels', getWidth: 1.6,
      extensions: [new deck.PathStyleExtension({ dash: true })], getDashArray: [7, 5], dashJustified: true,
    }));
    if (S.trees) out.push(...treeLayers(q));
    out.push(new deck.SolidPolygonLayer({
      id: 'buildings', data: B.list, getPolygon: d => d.poly, extruded: true, getElevation: d => d.h,
      wireframe: q.wire, getLineColor: [20, 26, 38, 70], pickable: true, autoHighlight: true, highlightColor: [61, 214, 255, 110],
      getFillColor: d => colorBuf.subarray(d.i * 4, d.i * 4 + 4),
      updateTriggers: { getFillColor: S.colorVersion },
      material: { ambient: 0.42, diffuse: 0.62, shininess: 22, specularColor: [55, 60, 70] },
      transitions: { getFillColor: 400 },
    }));
    if (S.sel != null) out.push(...selectionLayers());
    if (S.labels) out.push(...labelLayers());
    return out;
  }
  function treeLayers(q) {
    // Deep, slightly varied greens: under full sun lighter greens wash out to a pale blur
    const crown = d => { const k = hash(String(d[0])) % 5; return [28 + k * 6, 74 + k * 8, 30 + k * 4]; };
    const leaf = { ambient: 0.38, diffuse: 0.5, shininess: 4, specularColor: [20, 30, 20] };
    // Each tree style has its own layer id: deck.gl must not reuse one layer's state for another type
    if (q.trees === 'dots') {
      return [new deck.ScatterplotLayer({ id: 'trees-dots', data: T, getPosition: d => d, getRadius: 2.8, radiusMinPixels: 1, getFillColor: crown })];
    }
    const out = [];
    if (q.trees === 'mesh') {
      out.push(new deck.ColumnLayer({ id: 'trees-trunks', data: T, getPosition: d => [d[0], d[1]], radius: 0.35, diskResolution: 6,
        extruded: true, getElevation: d => d[2] * 0.45, getFillColor: [105, 78, 52] }));
      out.push(new deck.SimpleMeshLayer({ id: 'trees-mesh', data: T, mesh: SPHERE, getPosition: d => [d[0], d[1], d[2] * 0.45 + 2.2],
        getScale: d => { const r = d[2] > 10 ? 3.1 : 2.8; return [r, r, r * 0.85]; }, getColor: crown, material: leaf }));
    } else {
      out.push(new deck.ColumnLayer({ id: 'trees-columns', data: T, getPosition: d => [d[0], d[1], d[2] * 0.45], radius: 2.8,
        diskResolution: 8, extruded: true, getElevation: d => d[2] * 0.55, getFillColor: crown, material: leaf }));
    }
    return out;
  }
  function ring(center, r) {
    const out = [];
    for (let k = 0; k <= 96; k++) { const a = k / 96 * 2 * Math.PI; out.push([center[0] + Math.cos(a) * r / KX, center[1] + Math.sin(a) * r / KY]); }
    return out;
  }
  function selectionLayers() {
    const i = S.sel, h = B.h[i], rings = B.poly[i];
    const t = (performance.now() % 2400) / 2400;
    return [
      new deck.PathLayer({ id: 'sel-top', data: rings.map(r => r.map(p => [p[0], p[1], h + 0.4])), getPath: d => d,
        getColor: [61, 214, 255, 255], widthUnits: 'pixels', getWidth: 2.5 }),
      new deck.PathLayer({ id: 'sel-base', data: rings.map(r => r.map(p => [p[0], p[1], 0.3])), getPath: d => d,
        getColor: [61, 214, 255, 200], widthUnits: 'pixels', getWidth: 2 }),
      new deck.ScatterplotLayer({ id: 'sel-pulse', data: [B.c[i]], getPosition: d => d, stroked: true, filled: false,
        getRadius: Math.sqrt(B.a[i]) * (0.8 + t * 1.6) + 6, getLineColor: [61, 214, 255, Math.round(220 * (1 - t))],
        lineWidthUnits: 'pixels', getLineWidth: 2, updateTriggers: { getRadius: t, getLineColor: t } }),
    ];
  }
  let LABELS = null;
  function labelLayers() {
    if (!LABELS) {
      const best = new Map();
      R.name.forEach((n, i) => {
        if (!n || !['motorway', 'trunk', 'primary', 'secondary'].includes(R.cls[i])) return;
        const L = R.cum[i][R.cum[i].length - 1];
        if (!best.has(n) || best.get(n).L < L) best.set(n, { L, i });
      });
      const streets = [...best.entries()].sort((a, b) => b[1].L - a[1].L).slice(0, 14).map(([n, { i }]) => {
        const p = new Float64Array(2); pointAt(i, R.cum[i][R.cum[i].length - 1] / 2, p, 0);
        return { text: n, position: [p[0], p[1], 6] };
      });
      const districts = Object.values(SCENE.districts).map(d => ({ text: d.name.toUpperCase(), position: [...d.center, 140] }));
      LABELS = { streets, districts };
    }
    const common = { getText: d => d.text, getPosition: d => d.position, fontFamily: 'Inter, system-ui, sans-serif', billboard: true,
      outlineWidth: 2, fontSettings: { sdf: true } };
    return [
      new deck.TextLayer({ id: 'street-labels', data: LABELS.streets, ...common, getSize: 12, getColor: [255, 255, 255, 230],
        outlineColor: [0, 0, 0, 200], fontWeight: 500 }),
      new deck.TextLayer({ id: 'district-labels', data: LABELS.districts, ...common, getSize: 22, getColor: [61, 214, 255, 255],
        outlineColor: [4, 10, 24, 230], fontWeight: 700, characterSet: 'auto' }),
    ];
  }

  // ------------------------------------------------------------------ rendering loop
  function render() { if (overlay) overlay.setProps({ layers: layers() }); }
  function needsLoop() { return S.playing || (S.traffic && cars && cars.n) || (S.sel != null) || objDeck; }
  function loop(now) {
    rafId = 0;
    const dt = Math.min((now - (lastFrame || now)) / 1000, 0.1); lastFrame = now;
    if (S.playing) {
      setHour((S.hour + dt * 24 / 45) % 24);   // one day in 45 seconds
    }
    if (S.sel != null && S.orbit && !userBusy && !map.isMoving()) map.setBearing(map.getBearing() + dt * 6);
    if (S.traffic && cars && cars.n) moveCars(now / 1000);
    if (objDeck) spinObject(dt);
    render();
    countFrame(now);
    if (needsLoop()) rafId = requestAnimationFrame(loop);
    else lastFrame = 0;
  }
  function kick() { if (!rafId && needsLoop()) rafId = requestAnimationFrame(loop); else if (!needsLoop()) render(); }

  // ------------------------------------------------------------------ quality and frame rate
  let frames = 0, fpsT0 = 0, slowSecs = 0, fastSecs = 0, fps = 0, autoDowngraded = false, lastUpgrade = 0;
  let cooldown = performance.now() + 8000;   // let loading settle first
  function countFrame(now) {
    if (!fpsT0) fpsT0 = now;
    frames++;
    if (now - fpsT0 >= 1000) {
      fps = Math.round(frames * 1000 / (now - fpsT0)); frames = 0; fpsT0 = now;
      // Only judge the graphics card while someone is using the map: browsers slow down hidden,
      // background and unfocused pages, and roof sampling keeps the CPU busy right after loading
      const fair = document.visibilityState === 'visible' && document.hasFocus() && fps >= 4 && roofDone >= roofTotal;
      if (S.qualityPick === 'auto' && now > cooldown && fair) {
        slowSecs = fps < 24 ? slowSecs + 1 : 0;
        fastSecs = fps >= 50 ? fastSecs + 1 : 0;
        if (slowSecs >= 4 && S.quality !== 'low') {
          setQuality(LEVELS[LEVELS.indexOf(S.quality) + 1]); autoDowngraded = true; slowSecs = 0; cooldown = now + 5000;
        } else if (autoDowngraded && fastSecs >= 6 && S.quality !== 'high' && now - lastUpgrade > 60000) {
          // A step down that turns out smooth was a false alarm: go back up (at most once a minute)
          setQuality(LEVELS[LEVELS.indexOf(S.quality) - 1]); fastSecs = 0; lastUpgrade = now; cooldown = now + 5000;
        }
      }
      setPerf();
    }
  }
  function startQuality() {
    if (S.qualityPick !== 'auto') return S.qualityPick;
    let renderer = '';
    try {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    } catch (e) { /* no info */ }
    // Only clear cases start lower; everything else starts at full quality and the frame-rate
    // check steps down only if the machine really cannot keep up
    if (/swiftshader|llvmpipe|basic render|software/i.test(renderer)) return 'low';
    if ((navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2)) return 'medium';
    return 'high';
  }
  function setQuality(level) {
    S.quality = level;
    const dpr = QUALITY[level].dpr();
    overlay && overlay.setProps({ useDevicePixels: dpr });
    if (map && map.setPixelRatio) map.setPixelRatio(dpr);
    buildCars();
    drawSegs(); setPerf(); kick();
  }
  function setPerf(msg) {
    const q = QUALITY[S.quality].label;
    const pick = S.qualityPick === 'auto' ? `Auto → ${q}` : q;
    const roofs = roofTotal ? (roofDone >= roofTotal ? 'roof colors ready' : `roof colors ${Math.round(roofDone / roofTotal * 100)}%`) : '';
    $('perf').innerHTML = `${pick}${fps ? ` · ${fps} fps` : ''}<br>${cars ? cars.n.toLocaleString() + ' cars' : ''}${roofs ? ' · ' + roofs : ''}${msg ? '<br>' + msg : ''}`;
  }

  // ------------------------------------------------------------------ UI
  function drawSegs() {
    $('modes').innerHTML = MODES.map(m => m.sep ? '<span class="sep"></span>' :
      `<button data-mode="${m.id}" class="${m.id === S.mode ? 'on' : ''}">${m.label}${m.tag ? `<span class="tag">${m.tag}</span>` : ''}</button>`).join('');
    placeChips();
    $('basemaps').innerHTML = [['satellite', 'Satellite'], ['landcover', 'Land cover'], ['dark', 'Dark']]
      .map(([k, l]) => `<button data-base="${k}" class="${k === S.basemap ? 'on' : ''}">${l}</button>`).join('');
    $('quality').innerHTML = [['auto', 'Auto'], ['high', 'High'], ['medium', 'Med'], ['low', 'Low']]
      .map(([k, l]) => `<button data-q="${k}" class="${k === S.qualityPick ? 'on' : ''}">${l}</button>`).join('');
    $('tog-delta-wrap').classList.toggle('disabled', modeInfo().tag !== 'sim');
    $('tog-cells').parentElement.classList.toggle('disabled', modeInfo().tag !== 'sim');
  }
  function drawLegend() {
    const m = modeInfo();
    let html;
    if (S.mode === 'real') {
      html = `<div class="lg-title">Realistic view</div><div class="lg-sub">Roof colors sampled from satellite imagery${S.basemap === 'landcover' ? '; ground from ESA WorldCover' : ''}</div>`;
    } else if (S.delta && m.tag === 'sim') {
      html = `<div class="lg-title">${m.label}: change vs baseline</div><div class="lg-sub">Your scenario minus traffic ×1.0, no heatwave</div>
        <div class="bar" style="background:${css(DIVERGE)}"></div>
        <div class="lg-ticks"><span>−${m.delta}</span><span>no change</span><span>+${m.delta} ${m.unit}</span></div>`;
    } else {
      const ticks = S.mode === 'size' ? ['50', '160', '500', '1.6k', '5k+'] :
        [0, 1, 2, 3, 4].map(k => { const v = m.domain[0] + (m.domain[1] - m.domain[0]) * k / 4; return Math.abs(v) < 10 && v % 1 ? v.toFixed(2) : v.toFixed(0); });
      html = `<div class="lg-title">${m.label}${m.tag === 'sim' ? ' · simulated' : m.tag === 'real' ? ' · satellite data' : ''}</div>
        <div class="lg-sub">${m.unit}${m.tag === 'sim' ? ` at ${fmtHour(S.hour)}, per 250 m zone` : ''}</div>
        <div class="bar" style="background:${css(m.ramp)}"></div><div class="lg-ticks">${ticks.map(t => `<span>${t}</span>`).join('')}</div>`;
    }
    if (S.basemap === 'landcover' && SCENE.landcover) {
      html += `<div class="cats">${SCENE.landcover.legend.map(c => `<div class="cat"><span class="sw" style="background:rgb(${c.rgb})"></span>${c.name}</div>`).join('')}</div>`;
    }
    $('legend').innerHTML = html;
  }
  function drawScenario() {
    const s = S.scenario, chips = [];
    chips.push(`<span class="chip ${s.traffic_mult !== 1 ? 'hot' : ''}">🚗 Traffic ×${(+s.traffic_mult).toFixed(1)}</span>`);
    chips.push(`<span class="chip ${s.heat_delta > 0 ? 'hot' : ''}">🌡 Heatwave +${(+s.heat_delta).toFixed(1)} °C</span>`);
    $('scenario').innerHTML = chips.join('');
    placeChips();
  }
  /** Keep the scenario chips just under the mode buttons, however many rows those wrap to. */
  function placeChips() {
    const m = $('modes');
    $('scenario').style.top = `${m.offsetTop + m.offsetHeight + 8}px`;
  }
  window.addEventListener('resize', placeChips);
  function setHour(h) {
    S.hour = h;
    $('hour').value = h; $('clock').textContent = fmtHour(h);
    overlay.setProps({ effects: [lighting()] });
    applyDayNight();
    if (modeInfo().tag === 'sim') recolor(); else S.roadVersion++;
    if (Math.floor(h) !== lastCarHour) buildCars(); else colorCars();
    if (modeInfo().tag === 'sim') drawLegend();
    if (S.sel != null) drawCard();
    if (!rafId) render();
  }
  function bindUI() {
    $('modes').addEventListener('click', e => {
      const b = e.target.closest('button[data-mode]'); if (!b) return;
      S.mode = b.dataset.mode; recolor(); colorCars(); drawSegs(); drawLegend(); if (S.sel != null) drawCard(); kick();
    });
    $('basemaps').addEventListener('click', e => {
      const b = e.target.closest('button[data-base]'); if (!b) return;
      S.basemap = b.dataset.base; setBasemap(); drawSegs(); drawLegend(); kick();
    });
    $('quality').addEventListener('click', e => {
      const b = e.target.closest('button[data-q]'); if (!b) return;
      S.qualityPick = b.dataset.q; store('twin-quality', S.qualityPick); fps = 0;
      setQuality(S.qualityPick === 'auto' ? startQuality() : S.qualityPick);
    });
    const tog = (id, key, after) => $(id).addEventListener('change', e => { S[key] = e.target.checked; after && after(); kick(); });
    tog('tog-traffic', 'traffic'); tog('tog-trees', 'trees'); tog('tog-cells', 'cells'); tog('tog-labels', 'labels');
    tog('tog-delta', 'delta', () => { recolor(); drawLegend(); });
    $('hour').addEventListener('input', e => setHour(+e.target.value));
    $('play').addEventListener('click', () => { S.playing = !S.playing; $('play').classList.toggle('on', S.playing); $('play').textContent = S.playing ? '❚❚' : '▶'; kick(); });
    $('card-close').addEventListener('click', () => select(null));
    $('back-btn').addEventListener('click', () => { select(null); map.flyTo({ ...START_VIEW, duration: 2200 }); });
    $('orbit-btn').addEventListener('click', () => { S.orbit = !S.orbit; $('orbit-btn').classList.toggle('on', S.orbit); kick(); });
    $('isolate-btn').addEventListener('click', () => { S.isolate = !S.isolate; $('isolate-btn').classList.toggle('on', S.isolate); recolor(); kick(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') select(null); });
  }

  // ------------------------------------------------------------------ basemap
  function style() {
    const lc = SCENE.landcover, [w, s, e, n] = lc.bounds;
    let maxTex = 4096;
    try { const gl = document.createElement('canvas').getContext('webgl'); maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE); } catch (err) { /* keep default */ }
    return {
      version: 8,
      sources: {
        sat: { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
        light: { type: 'raster', tiles: CARTO('light_nolabels'), tileSize: 256, attribution: '© CARTO © OpenStreetMap contributors' },
        dark: { type: 'raster', tiles: CARTO('dark_nolabels'), tileSize: 256, attribution: '© CARTO © OpenStreetMap contributors' },
        lc: { type: 'image', url: `data/${lc.size_px[0] > maxTex ? 'landcover_small' : 'landcover'}.png`,
          coordinates: [[w, n], [e, n], [e, s], [w, s]] },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } },
        { id: 'carto-light', type: 'raster', source: 'light', layout: { visibility: 'none' } },
        { id: 'carto-dark', type: 'raster', source: 'dark', layout: { visibility: 'none' } },
        { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 150 } },
        { id: 'lc', type: 'raster', source: 'lc', layout: { visibility: 'none' }, paint: { 'raster-resampling': 'linear', 'raster-opacity': 1 } },
      ],
    };
  }
  function setBasemap() {
    // Land cover keeps the satellite photo around its edges, so the scene has no hard border
    const vis = { sat: S.basemap !== 'dark', 'carto-light': false, 'carto-dark': S.basemap === 'dark', lc: S.basemap === 'landcover' };
    for (const [id, on] of Object.entries(vis)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    applyDayNight();
  }

  // ------------------------------------------------------------------ selection, card, 3D object
  function select(i) {
    const prev = S.sel;
    S.sel = i;
    if (i == null) {
      $('card').classList.add('hidden');
      if (objDeck) { objDeck.finalize(); objDeck = null; }
      if (S.isolate) recolor();
      kick();
      return;
    }
    if (S.isolate || prev != null) recolor();
    $('card').classList.remove('hidden');
    $('hint').classList.add('gone');
    drawCard();
    showObject(i);
    const size = Math.max(Math.sqrt(B.a[i]), B.h[i] * 0.8, 12);
    map.flyTo({ center: B.c[i], zoom: clamp(19.6 - Math.log2(size / 10), 16.4, 19.3), pitch: 62,
      bearing: map.getBearing() + 35, duration: 2400, essential: true,
      padding: { top: 0, bottom: 0, left: 0, right: window.innerWidth > 900 ? 320 : 0 } });
    kick();
  }
  function drawCard() {
    const i = S.sel, m = modeInfo(), floors = Math.max(1, Math.round(B.h[i] / 3));
    const floor = B.a[i] * floors, z = B.z[i];
    const srcName = { osm: 'OpenStreetMap', satellite: 'Satellite footprint (Microsoft)' }[B.src[i]] || B.src[i];
    $('card-kicker').textContent = `${SCENE.districts[B.d[i]] ? SCENE.districts[B.d[i]].name : 'Between the districts'} · ${srcName}`;
    $('card-title').textContent = B.id[i];
    const t = zoneValue(S.prof, z, 'temp'), tr = zoneValue(S.prof, z, 'traffic'), e = zoneValue(S.prof, z, 'elec_m2'), no2 = zoneValue(S.prof, z, 'no2');
    const kv = (k, v, sim) => `<div class="kv ${sim ? 'sim' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const real = (v, f, u) => v == null ? '<small>no data</small>' : `${f(v)} <small>${u}</small>`;
    $('card-grid').innerHTML = [
      kv('Height', `${B.h[i].toFixed(0)} <small>m · ${floors} fl</small>`),
      kv('Footprint', `${Math.round(B.a[i]).toLocaleString()} <small>m²</small>`),
      kv('Floor area', `${Math.round(floor).toLocaleString()} <small>m²</small>`),
      kv('Surface temp', real(B.lst[i], v => v.toFixed(1), '°C')),
      kv('Vegetation', real(B.ndvi[i], v => v.toFixed(2), 'NDVI')),
      kv('Residents', real(B.pop[i], v => v.toFixed(0), 'est.')),
      kv('Air temp', t == null ? '–' : `${t.toFixed(1)} <small>°C</small>`, true),
      kv('Electricity', e == null ? '–' : `${(e * floor).toFixed(0)} <small>kWh/h</small>`, true),
      kv('Traffic', tr == null ? '–' : `${tr.toFixed(2)} <small>index</small>`, true),
      kv('NO₂', no2 == null ? '–' : `${no2.toFixed(0)} <small>µg/m³</small>`, true),
    ].join('');
    $('card-note').textContent = `Simulated values at ${fmtHour(S.hour)} for ${B.near[i] ? 'the nearest' : 'its'} 250 m zone (${Z.id[z]}), scenario: traffic ×${(+S.scenario.traffic_mult).toFixed(1)}, heatwave +${(+S.scenario.heat_delta).toFixed(1)} °C.`;
    drawSpark(z, m.tag === 'sim' ? m : MODES[1]);
  }
  function drawSpark(z, m) {
    const k = m.scale || 1, scen = S.prof && S.prof[Z.id[z]], base = S.base && S.base[Z.id[z]];
    if (!scen) { $('spark').innerHTML = ''; return; }
    const a = scen[m.metric].map(v => v * k), b = base ? base[m.metric].map(v => v * k) : null;
    const all = b ? a.concat(b) : a, lo = Math.min(...all), hi = Math.max(...all) || 1;
    const pts = (arr) => arr.map((v, h) => `${(h / 23 * 236 + 2).toFixed(1)},${(60 - (v - lo) / (hi - lo || 1) * 54).toFixed(1)}`).join(' ');
    const x = S.hour / 24 * 236 + 2;
    $('spark-metric').textContent = `· ${m.label} (${m.unit})`;
    $('spark').innerHTML = `${b ? `<polyline points="${pts(b)}" fill="none" stroke="#8ca3bf" stroke-width="1.2" stroke-dasharray="3 3"/>` : ''}
      <polyline points="${pts(a)}" fill="none" stroke="#3dd6ff" stroke-width="2"/>
      <line x1="${x}" x2="${x}" y1="0" y2="64" stroke="#ffb547" stroke-width="1"/>
      <text x="4" y="10" fill="#8ca3bf" font-size="8">${hi.toFixed(m.metric === 'traffic' ? 2 : 0)}</text>
      <text x="4" y="62" fill="#8ca3bf" font-size="8">${lo.toFixed(m.metric === 'traffic' ? 2 : 0)}</text>`;
  }

  let objDeck = null, objView = null, objDrag = 0;
  function showObject(i) {
    const [cx, cy] = B.c[i], h = B.h[i];
    const rings = B.poly[i].map(r => r.map(([x, y]) => [(x - cx) * KX, (y - cy) * KY]));
    const ext = Math.max(...rings[0].map(p => Math.hypot(p[0], p[1])), 6);
    const floors = Math.max(1, Math.round(h / 3));
    const floorLines = [];
    for (let f = 1; f < floors; f++) floorLines.push(...rings.map(r => r.map(p => [p[0], p[1], f * h / floors])));
    const circle = (r) => Array.from({ length: 65 }, (_, k) => [Math.cos(k / 64 * 2 * Math.PI) * r, Math.sin(k / 64 * 2 * Math.PI) * r]);
    const c = colorFor(i), CART = deck.COORDINATE_SYSTEM.CARTESIAN;
    const canvas = $('object3d'), size = Math.max(ext * 3.4, h * 1.9);
    objView = { target: [0, 0, h * 0.42], zoom: Math.log2(Math.min(canvas.clientWidth || 268, canvas.clientHeight || 190) / size), rotationX: 28, rotationOrbit: 25, minZoom: -6, maxZoom: 8 };
    const layersObj = [
      new deck.SolidPolygonLayer({ id: 'pad', data: [circle(ext * 1.7)], getPolygon: d => d, coordinateSystem: CART, getFillColor: [26, 44, 74] }),
      new deck.PathLayer({ id: 'radar', data: [circle(ext * 0.9), circle(ext * 1.3), circle(ext * 1.7)], getPath: d => d, coordinateSystem: CART,
        getColor: [61, 214, 255, 70], widthUnits: 'pixels', getWidth: 1 }),
      new deck.SolidPolygonLayer({ id: 'obj', data: [rings], getPolygon: d => d, coordinateSystem: CART, extruded: true, getElevation: h,
        getFillColor: c, wireframe: true, getLineColor: [255, 255, 255, 120],
        material: { ambient: 0.45, diffuse: 0.65, shininess: 30, specularColor: [70, 80, 90] } }),
      new deck.PathLayer({ id: 'floors', data: floorLines, getPath: d => d, coordinateSystem: CART, getColor: [255, 255, 255, 80], widthUnits: 'pixels', getWidth: 1 }),
    ];
    const fx = new deck.LightingEffect({
      a: new deck.AmbientLight({ intensity: 0.9 }),
      d1: new deck.DirectionalLight({ color: [255, 245, 230], intensity: 1.6, direction: [-1, -2, -2] }),
      d2: new deck.DirectionalLight({ color: [120, 180, 255], intensity: 0.6, direction: [2, 1, -1] }),
    });
    if (objDeck) objDeck.setProps({ layers: layersObj, viewState: objView, effects: [fx] });
    else {
      objDeck = new deck.Deck({
        canvas, views: new deck.OrbitView({ orbitAxis: 'Z', fovy: 35 }), viewState: objView, controller: true, layers: layersObj, effects: [fx],
        useDevicePixels: QUALITY[S.quality].dpr(),
        onViewStateChange: ({ viewState }) => { objView = viewState; objDrag = performance.now(); objDeck.setProps({ viewState }); },
      });
    }
  }
  function spinObject(dt) {
    if (performance.now() - objDrag < 2500) return;     // let people look after dragging
    objView = { ...objView, rotationOrbit: objView.rotationOrbit + dt * 22 };
    objDeck.setProps({ viewState: objView });
  }

  // ------------------------------------------------------------------ Streamlit bridge
  const inFrame = window.parent !== window;
  let gotArgs = false, lastArgsKey = '';
  function send(type, data) { if (inFrame) window.parent.postMessage({ isStreamlitMessage: true, type, ...data }, '*'); }
  function onArgs(args) {
    gotArgs = true;
    if (args.height) { document.body.style.height = args.height + 'px'; send('streamlit:setFrameHeight', { height: args.height }); }
    // Streamlit re-sends the same args on every rerun: only react to a new scenario
    const key = JSON.stringify(args.scenario || {}) + (args.version || '');
    if (key === lastArgsKey) return;
    lastArgsKey = key;
    if (args.profiles) S.prof = args.profiles;
    if (args.baseline) S.base = args.baseline;
    if (args.scenario) S.scenario = args.scenario;
    if (!B) return;   // data still loading: applied in start()
    applyScenario();
  }
  function applyScenario() {
    drawScenario(); recolor(); buildCars(); drawLegend(); if (S.sel != null) drawCard(); setPerf(); kick();
  }
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'streamlit:render') onArgs(e.data.args || {}); });
  send('streamlit:componentReady', { apiVersion: 1 });

  // ------------------------------------------------------------------ start
  async function getJSON(name) {
    const res = await fetch(`data/${name}.json`);
    if (!res.ok) throw new Error(`data/${name}.json: ${res.status}`);
    return res.json();
  }
  async function start() {
    const sub = $('loader-sub');
    sub.textContent = 'loading buildings, roads and trees…';
    let baseline;
    [B, R, T, Z, G, W, SCENE, baseline] = await Promise.all(
      ['buildings', 'roads', 'trees', 'zones', 'green', 'water', 'scene', 'baseline_profiles'].map(getJSON));
    B.list = B.poly.map((poly, i) => ({ i, poly, h: B.h[i] }));
    if (!S.prof) { S.prof = baseline; }
    if (!S.base) { S.base = baseline; }
    prepRoads();
    S.quality = startQuality();
    sub.textContent = `${B.id.length.toLocaleString()} buildings · ${R.path.length.toLocaleString()} roads · ${T.length.toLocaleString()} trees`;

    // START_VIEW fits both districts in a ~1200 px wide map: zoom out on smaller screens
    const box = $('map').getBoundingClientRect();
    START_VIEW.zoom = clamp(13.55 + Math.log2(Math.min(box.width || 1200, (box.height || 760) * 1.6) / 1200), 12, 14.5);
    map = new maplibregl.Map({ container: 'map', style: style(), ...START_VIEW, maxPitch: 80, pixelRatio: QUALITY[S.quality].dpr(),
      attributionControl: { compact: true, customAttribution: 'Land cover © ESA WorldCover 2021 · Buildings © OpenStreetMap, Microsoft' } });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    overlay = new deck.MapboxOverlay({
      interleaved: false, layers: [], useDevicePixels: QUALITY[S.quality].dpr(), pickingRadius: 3,
      onClick: (info) => { if (info.layer && info.layer.id === 'buildings') select(info.index); else if (!info.picked && S.sel != null) select(null); },
      getTooltip: ({ object, layer, index }) => {
        if (!layer || layer.id !== 'buildings' || index < 0) return null;
        const m = modeInfo();
        let val = '';
        if (m.tag === 'sim') { const v = zoneValue(S.prof, B.z[index], m.metric); val = v == null ? '' : `<br>${m.label}: <b>${m.fmt(v * (m.scale || 1))}</b> ${m.unit}`; }
        else if (m.tag === 'real') { const v = B[S.mode][index]; val = `<br>${m.label}: <b>${v == null ? 'no data' : m.fmt(v)}</b> ${v == null ? '' : m.unit}`; }
        return { html: `<b>${B.id[index]}</b><br>${B.h[index].toFixed(0)} m tall · ${Math.round(B.a[index]).toLocaleString()} m²${val}<br><span style="color:#8ca3bf">click to fly in</span>`,
          style: { background: 'rgba(10,16,30,.92)', color: '#e6f1ff', border: '1px solid rgba(61,214,255,.4)', borderRadius: '10px', fontSize: '12px', padding: '8px 10px' } };
      },
    });
    map.addControl(overlay);
    map.on('load', setBasemap);
    const busy = () => { userBusy = true; clearTimeout(busy.t); busy.t = setTimeout(() => { userBusy = false; }, 4000); };
    ['mousedown', 'touchstart', 'wheel', 'dragstart'].forEach(ev => map.on(ev, busy));

    drawSegs(); drawLegend(); drawScenario(); bindUI();
    recolor(); buildCars(); setHour(S.hour);
    setQuality(S.quality);
    $('loader').classList.add('done');
    setTimeout(() => $('hint').classList.add('gone'), 7000);
    sampleRoofs();
    window.twin = { S, map, select, setHour, buildings: B };   // handy from the browser console
  }
  start().catch(err => {
    console.error(err);
    $('loader-sub').textContent = `Could not load the map: ${err.message}`;
  });
  // Outside Streamlit nothing sends a scenario: keep the bundled baseline
  setTimeout(() => { if (!gotArgs && B) applyScenario(); }, 1500);
})();
