// The map: a flat base map of Europe (Natural Earth shapes and relief
// shading from map/, if present), journeys as straight lines coloured by
// type (flights as a gentle arc), stations as dots showing the days at their
// place, and labels drawn by the browser: place names when zoomed out,
// station names as well when zoomed in.

import * as ml from 'maplibre-gl';
const maplibregl = ml.default || ml;

// The library's background worker sits next to it in vendor/. Tell the
// library where it is, if it offers that setting; otherwise it finds it itself.
try {
  if (typeof maplibregl.setWorkerUrl === 'function') {
    maplibregl.setWorkerUrl(new URL('../vendor/maplibre-gl-worker.mjs', import.meta.url).href);
  }
} catch (e) { /* leave the library's own choice in place */ }

const STATION_ZOOM = 9;

// Map area: west, south, east, north. Must match tools/build_basemap.py
// and tools/check_basemap.py.
const AREA = [-12, 34, 45, 72];
const RELIEF_FILE = /^relief-\d-\d\.jpg$/;

const mapUrl = file => new URL('map/' + file, document.baseURI).href;

// All journeys are solid lines, coloured by type, 60% solid.
const COLOURS = {
  train: '#762a83',
  ferry: '#1b7837',
  flight: '#8c510a',
  car: '#74add1'
};
const LINE_WIDTH = 5;
const LINE_OPACITY = 0.6;

// Station dots. Places with a stay get a bigger dot with the days in the
// centre; transit places and the trip's start and end keep the original
// small, empty dot. Labels sit clear of the dot either way.
const DOT_RADIUS = 9;
const DOT_RADIUS_EMPTY = 4.5;
const DOT_RING = 2;
const DOT_OPACITY = 0.6; // centre and ring, 60% solid like the lines
const GAP_BIG = { place: DOT_RADIUS + DOT_RING + 2, station: DOT_RADIUS + DOT_RING + 2 };
const GAP_EMPTY = { place: 8, station: 7 };

const MAP_COLOURS = {
  bg: '#eef1f0', dot: '#2c2c2a', ring: '#ffffff',
  land: '#f3f0e8', sea: '#cddff0', river: '#9fc4e0', border: '#a8a39a',
  reliefOpacity: 0.45
};

function isCorners(c) {
  return Array.isArray(c) && c.length === 4 && c.every(p =>
    Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v)) &&
    p[0] >= AREA[0] && p[0] <= AREA[2] && p[1] >= AREA[1] && p[1] <= AREA[3]);
}

// A gentle curve between two points, for flights.
function arc(a, b, steps = 32) {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const cx = mx - dy * 0.15;
  const cy = my + dx * 0.15;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
  }
  return pts;
}

function labelEl(text, cls) {
  const el = document.createElement('div');
  el.className = 'lbl ' + cls;
  el.textContent = text;
  return el;
}

export function createMap(container, handlers) {
  const colours = MAP_COLOURS;
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': colours.bg } }]
    },
    center: [15, 54],
    zoom: 3.5,
    minZoom: 3,
    maxZoom: 11,
    maxBounds: [[AREA[0], AREA[1]], [AREA[2], AREA[3]]],
    renderWorldCopies: false,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false
  });
  if (map.touchZoomRotate && map.touchZoomRotate.disableRotation) map.touchZoomRotate.disableRotation();
  if (maplibregl.NavigationControl) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  const lineLayers = Object.keys(COLOURS).map(m => 'j-' + m);
  let labels = [];
  let numbers = [];
  let dots = []; // every station dot, so names can keep clear of them

  // Thin grey lines from moved names of places stayed back to their dots.
  // Drawn under the labels, over the map.
  const leaders = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  leaders.setAttribute('class', 'leaders');
  (map.getCanvasContainer ? map.getCanvasContainer() : container).appendChild(leaders);
  let pendingData = null;
  let loaded = false;
  let stationsByName = new Map();
  let journeysById = new Map();

  // Base map layers go first, so they sit under the journeys. If the files
  // aren't there, these layers stay empty and the plain background shows.
  function addBaseMap() {
    const shapes = (id, file) => map.addSource(id, { type: 'geojson', data: mapUrl(file), maxzoom: 10 });
    shapes('map-land', 'land.json');
    shapes('map-ocean', 'ocean.json');
    shapes('map-lakes', 'lakes.json');
    shapes('map-rivers', 'rivers.json');
    shapes('map-borders', 'borders.json');
    map.addLayer({ id: 'map-land', type: 'fill', source: 'map-land', paint: { 'fill-color': colours.land } });
    // relief pieces are added here, under the sea, once index.json has loaded
    map.addLayer({ id: 'map-ocean', type: 'fill', source: 'map-ocean', paint: { 'fill-color': colours.sea } });
    map.addLayer({ id: 'map-lakes', type: 'fill', source: 'map-lakes', paint: { 'fill-color': colours.sea } });
    map.addLayer({
      id: 'map-rivers',
      type: 'line',
      source: 'map-rivers',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': colours.river,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.2, 11, 2],
        // larger rivers first; smaller ones appear as you zoom in
        'line-opacity': ['step', ['zoom'],
          ['case', ['<=', ['get', 'r'], 4], 1, 0],
          5, ['case', ['<=', ['get', 'r'], 6], 1, 0],
          7, 1]
      }
    });
    map.addLayer({
      id: 'map-borders',
      type: 'line',
      source: 'map-borders',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': colours.border,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 1.2]
      }
    });

    fetch(mapUrl('index.json'))
      .then(r => (r.ok ? r.json() : null))
      .then(index => {
        if (!index || !Array.isArray(index.relief)) return;
        index.relief.forEach((piece, i) => {
          if (!piece || typeof piece.file !== 'string' || !RELIEF_FILE.test(piece.file) || !isCorners(piece.coordinates)) return;
          const id = 'relief-' + i;
          map.addSource(id, { type: 'image', url: mapUrl(piece.file), coordinates: piece.coordinates });
          map.addLayer({
            id,
            type: 'raster',
            source: id,
            paint: {
              'raster-opacity': colours.reliefOpacity,
              'raster-fade-duration': 0
            }
          }, 'map-ocean');
        });
      })
      .catch(() => { /* no relief: the map still works without it */ });
  }

  map.on('load', () => {
    addBaseMap();
    map.addSource('journeys', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    for (const mode of Object.keys(COLOURS)) {
      map.addLayer({
        id: 'j-' + mode,
        type: 'line',
        source: 'journeys',
        filter: ['==', ['get', 'mode'], mode],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': COLOURS[mode],
          'line-width': LINE_WIDTH,
          'line-opacity': LINE_OPACITY
        }
      });
    }
    map.addLayer({
      id: 'stations-dot',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-radius': ['case', ['>', ['get', 'days'], 0], DOT_RADIUS, DOT_RADIUS_EMPTY],
        'circle-color': colours.dot,
        'circle-opacity': DOT_OPACITY,
        'circle-stroke-width': DOT_RING,
        'circle-stroke-color': colours.ring,
        'circle-stroke-opacity': DOT_OPACITY
      }
    });
    loaded = true;
    if (pendingData) { const d = pendingData; pendingData = null; apply(d.stations, d.journeys, d.days); }
  });

  map.on('click', e => {
    const p = e.point;
    const box = [[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]];
    const st = map.queryRenderedFeatures(box, { layers: ['stations-dot'] });
    if (st.length) { handlers.onStation(st[0].properties.station); return; }
    const lines = map.queryRenderedFeatures(box, { layers: lineLayers });
    if (lines.length) { handlers.onJourney(Number(lines[0].properties.id)); return; }
    handlers.onEmpty();
  });

  // While the map moves, names keep their place relative to their dots;
  // once it stops, the names of places stayed are arranged again.
  let frame = 0;
  let rearrange = false;
  const scheduleLabels = again => {
    rearrange = rearrange || again;
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; const r = rearrange; rearrange = false; layoutLabels(r); });
  };
  map.on('move', () => scheduleLabels(false));
  map.on('moveend', () => scheduleLabels(true));
  map.on('resize', () => scheduleLabels(true));

  const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  const boxAt = (cx, cy, w, h) => ({ x1: cx - w / 2, x2: cx + w / 2, y1: cy - h / 2, y2: cy + h / 2 });
  const padded = (b, p) => ({ x1: b.x1 - p, x2: b.x2 + p, y1: b.y1 - p, y2: b.y2 + p });
  // Where to try a name that doesn't fit above its dot: rings of growing
  // distance, starting straight up and working round.
  const DIRS = [-90, -60, -120, -30, -150, 0, 180, 30, 150, 60, 120, 90].map(d => d * Math.PI / 180);
  const RINGS = [24, 40, 60, 85, 115, 150];

  function placeStay(l, pt, usual, free) {
    if (free(boxAt(pt.x + usual[0], pt.y + usual[1], l.w, l.h))) return { offset: usual, moved: false };
    for (const r of RINGS) {
      for (const a of DIRS) {
        const dx = Math.round(Math.cos(a) * (r + l.w / 2));
        const dy = Math.round(Math.sin(a) * (r + l.h / 2));
        if (free(boxAt(pt.x + dx, pt.y + dy, l.w, l.h))) return { offset: [dx, dy], moved: true };
      }
    }
    return { offset: usual, moved: false }; // nowhere free: keep the usual spot
  }

  // A line from the edge of the dot to the nearest edge of its name.
  function leader(pt, box, dotR) {
    const qx = Math.min(Math.max(pt.x, box.x1), box.x2);
    const qy = Math.min(Math.max(pt.y, box.y1), box.y2);
    const d = Math.hypot(qx - pt.x, qy - pt.y);
    if (d <= dotR) return null;
    return [pt.x + (qx - pt.x) * dotR / d, pt.y + (qy - pt.y) * dotR / d, qx, qy];
  }

  function drawLeaders(segs, W, H) {
    leaders.setAttribute('width', W);
    leaders.setAttribute('height', H);
    leaders.replaceChildren(...segs.map(([x1, y1, x2, y2]) => {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x1.toFixed(1));
      line.setAttribute('y1', y1.toFixed(1));
      line.setAttribute('x2', x2.toFixed(1));
      line.setAttribute('y2', y2.toFixed(1));
      return line;
    }));
  }

  function layoutLabels(again) {
    const zoom = map.getZoom();
    const W = container.clientWidth;
    const H = container.clientHeight;
    const top = (handlers.topInset ? handlers.topInset() : 0) + 4;
    const inView = b => b.x1 >= 4 && b.x2 <= W - 4 && b.y1 >= top && b.y2 <= H - 4;
    const dotBoxes = dots.map(d => { const p = map.project(d.lngLat); return boxAt(p.x, p.y, d.r * 2, d.r * 2); });
    const placed = [];
    const segs = [];

    // Names of places stayed: always shown. Above the dot if there's room,
    // otherwise moved to the nearest free spot with a line back to the dot.
    for (const l of labels) {
      if (l.kind !== 'stay') continue;
      const pt = map.project(l.lngLat);
      const usual = [0, -(l.gap + l.h / 2)];
      const onScreen = pt.x >= 0 && pt.x <= W && pt.y >= 0 && pt.y <= H;
      if (again || !l.spot) {
        const free = b => inView(b) && !placed.some(p => overlaps(b, padded(p, 2))) && !dotBoxes.some(d => overlaps(b, d));
        l.spot = onScreen ? placeStay(l, pt, usual, free) : { offset: usual, moved: false };
        l.marker.setOffset(l.spot.offset);
      }
      l.el.style.display = '';
      if (!onScreen) continue;
      const box = boxAt(pt.x + l.spot.offset[0], pt.y + l.spot.offset[1], l.w, l.h);
      placed.push(box);
      if (l.spot.moved) {
        const seg = leader(pt, box, DOT_RADIUS + DOT_RING);
        if (seg) segs.push(seg);
      }
    }

    // Other place names, then station names from STATION_ZOOM: shown only
    // where they don't overlap a name already shown.
    for (const l of labels) {
      if (l.kind === 'stay') continue;
      const wanted = l.kind === 'place' || zoom >= STATION_ZOOM;
      let show = false;
      if (wanted) {
        const pt = map.project(l.lngLat);
        const box = l.kind === 'place'
          ? { x1: pt.x - l.w / 2, x2: pt.x + l.w / 2, y1: pt.y - l.gap - l.h, y2: pt.y - l.gap }
          : { x1: pt.x - l.w / 2, x2: pt.x + l.w / 2, y1: pt.y + l.gap, y2: pt.y + l.gap + l.h };
        const onScreen = box.x2 > 0 && box.x1 < W && box.y2 > 0 && box.y1 < H;
        const clash = placed.some(b => overlaps(box, b));
        if (onScreen && !clash) { placed.push(box); show = true; }
      }
      l.el.style.display = show ? '' : 'none';
    }
    drawLeaders(segs, W, H);
  }

  function apply(stations, journeys, days) {
    stationsByName = stations;
    journeysById = new Map(journeys.map(j => [j.id, j]));

    const used = new Set();
    journeys.forEach(j => { used.add(j.from); used.add(j.to); });

    const lineFeatures = journeys.map(j => {
      const a = stations.get(j.from);
      const b = stations.get(j.to);
      const A = [a.lon, a.lat];
      const B = [b.lon, b.lat];
      return {
        type: 'Feature',
        properties: { id: j.id, mode: j.mode },
        geometry: { type: 'LineString', coordinates: j.mode === 'flight' ? arc(A, B) : [A, B] }
      };
    });
    const daysAt = s => days.get(s.place) || 0;
    const dotFeatures = [...used].map(name => {
      const s = stations.get(name);
      return { type: 'Feature', properties: { station: name, days: daysAt(s) }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } };
    });
    map.getSource('journeys').setData({ type: 'FeatureCollection', features: lineFeatures });
    map.getSource('stations').setData({ type: 'FeatureCollection', features: dotFeatures });

    labels.forEach(l => l.marker.remove());
    labels = [];
    const places = new Map();
    for (const name of used) {
      const s = stations.get(name);
      if (!places.has(s.place)) places.set(s.place, { stations: [], city: false });
      const p = places.get(s.place);
      p.stations.push(s);
      if (s.type === 'city') p.city = true;
    }
    const centre = p => [
      p.stations.reduce((t, s) => t + s.lon, 0) / p.stations.length,
      p.stations.reduce((t, s) => t + s.lat, 0) / p.stations.length
    ];
    // Places stayed first (in trip order), then the other places, then stations.
    for (const [name, p] of places) {
      if (daysAt(p.stations[0]) > 0) addLabel('stay', name, centre(p), true);
    }
    const others = [...places.entries()].filter(([, p]) => !(daysAt(p.stations[0]) > 0))
      .sort((x, y) => (y[1].city - x[1].city));
    for (const [name, p] of others) addLabel('place', name, centre(p), false);
    for (const name of used) {
      const s = stations.get(name);
      addLabel('station', s.station, [s.lon, s.lat], daysAt(s) > 0);
    }
    dots = [...used].map(name => {
      const s = stations.get(name);
      return { lngLat: [s.lon, s.lat], r: (daysAt(s) > 0 ? DOT_RADIUS : DOT_RADIUS_EMPTY) + DOT_RING };
    });

    // Days at the place, in the centre of each of its station dots. Places
    // with no stay keep an empty dot.
    numbers.forEach(m => m.remove());
    numbers = [];
    for (const name of used) {
      const s = stations.get(name);
      const n = days.get(s.place);
      if (!n) continue;
      const el = document.createElement('div');
      el.className = 'dot-num';
      el.textContent = String(n);
      numbers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([s.lon, s.lat]).addTo(map));
    }
    layoutLabels(true);
  }

  // Names of places stayed ('stay') are placed by layoutLabels, centred on
  // an offset from their dot; other place names sit above the dot and
  // station names below it.
  function addLabel(kind, text, lngLat, bigDot) {
    const isPlace = kind !== 'station';
    const el = labelEl(text, isPlace ? 'lbl-place' : 'lbl-station');
    const gap = (bigDot ? GAP_BIG : GAP_EMPTY)[isPlace ? 'place' : 'station'];
    const marker = new maplibregl.Marker(kind === 'stay'
      ? { element: el, anchor: 'center', offset: [0, -gap] }
      : { element: el, anchor: kind === 'place' ? 'bottom' : 'top', offset: kind === 'place' ? [0, -gap] : [0, gap] }
    ).setLngLat(lngLat).addTo(map);
    // Measure the name once, as drawn; fall back to an estimate.
    const w = el.offsetWidth || text.length * (isPlace ? 7.5 : 6.5) + 6;
    const h = el.offsetHeight || 16;
    labels.push({ kind, text, lngLat, el, marker, gap, w, h, spot: null });
  }

  function fit(points, bottomPad) {
    if (!points.length) return;
    const bounds = new maplibregl.LngLatBounds(points[0], points[0]);
    points.forEach(p => bounds.extend(p));
    map.fitBounds(bounds, {
      padding: { top: 70, bottom: bottomPad || 40, left: 40, right: 40 },
      maxZoom: 10,
      duration: 600
    });
  }

  return {
    setData(stations, journeys, days = new Map()) {
      if (loaded) apply(stations, journeys, days);
      else pendingData = { stations, journeys, days };
    },
    showAll() {
      const pts = [];
      journeysById.forEach(j => {
        const a = stationsByName.get(j.from);
        const b = stationsByName.get(j.to);
        pts.push([a.lon, a.lat], [b.lon, b.lat]);
      });
      fit(pts, 40);
    },
    focusJourney(id, bottomPad) {
      const j = journeysById.get(id);
      if (!j) return;
      const a = stationsByName.get(j.from);
      const b = stationsByName.get(j.to);
      fit([[a.lon, a.lat], [b.lon, b.lat]], bottomPad);
    },
    resize() { map.resize(); }
  };
}
