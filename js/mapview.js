// The map: a flat base map of Europe (Natural Earth shapes and relief
// shading from map/, if present), journeys as straight lines styled by type
// (flights as a gentle arc), stations as dots, and labels drawn by the
// browser: place names when zoomed out, station names as well when zoomed in.

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

// All journeys are solid lines, coloured by type.
const COLOURS = {
  train: '#40004b',
  ferry: '#00441b',
  sleeper: '#7F77DD',
  flight: '#543005',
  car: '#053061'
};

function palette() {
  const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark
    ? {
        bg: '#1f2023', dot: '#ecebe6', ring: '#1f2023', past: '#6b6b66',
        land: '#2c2d2a', sea: '#17222d', river: '#2c4a63', border: '#5d5b55',
        reliefOpacity: 0.5, reliefMax: 0.45
      }
    : {
        bg: '#eef1f0', dot: '#2c2c2a', ring: '#ffffff', past: '#a9a8a2',
        land: '#f3f0e8', sea: '#cddff0', river: '#9fc4e0', border: '#a8a39a',
        reliefOpacity: 0.45, reliefMax: 1
      };
}

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
  const colours = palette();
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
              'raster-brightness-max': colours.reliefMax,
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
          'line-color': ['case', ['get', 'past'], colours.past, COLOURS[mode]],
          'line-width': ['case', ['get', 'today'], 4.5, 2.5]
        }
      });
    }
    map.addLayer({
      id: 'stations-dot',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-radius': 4.5,
        'circle-color': colours.dot,
        'circle-stroke-width': 2,
        'circle-stroke-color': colours.ring
      }
    });
    loaded = true;
    if (pendingData) { const d = pendingData; pendingData = null; apply(d.stations, d.journeys); }
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

  let frame = 0;
  const scheduleLabels = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; layoutLabels(); });
  };
  map.on('move', scheduleLabels);
  map.on('moveend', scheduleLabels);
  map.on('resize', scheduleLabels);

  function layoutLabels() {
    const zoom = map.getZoom();
    const placed = [];
    const W = container.clientWidth;
    const H = container.clientHeight;
    for (const l of labels) {
      const wanted = l.kind === 'place' || zoom >= STATION_ZOOM;
      let show = false;
      if (wanted) {
        const pt = map.project(l.lngLat);
        const w = l.text.length * (l.kind === 'place' ? 7.5 : 6.5) + 6;
        const h = 16;
        const box = l.kind === 'place'
          ? { x1: pt.x - w / 2, x2: pt.x + w / 2, y1: pt.y - 8 - h, y2: pt.y - 8 }
          : { x1: pt.x - w / 2, x2: pt.x + w / 2, y1: pt.y + 7, y2: pt.y + 7 + h };
        const onScreen = box.x2 > 0 && box.x1 < W && box.y2 > 0 && box.y1 < H;
        const clash = placed.some(b => box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1);
        if (onScreen && !clash) { placed.push(box); show = true; }
      }
      l.el.style.display = show ? '' : 'none';
    }
  }

  function apply(stations, journeys) {
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
        properties: { id: j.id, mode: j.mode, past: j.past, today: j.today },
        geometry: { type: 'LineString', coordinates: j.mode === 'flight' ? arc(A, B) : [A, B] }
      };
    });
    const dotFeatures = [...used].map(name => {
      const s = stations.get(name);
      return { type: 'Feature', properties: { station: name }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } };
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
    const placeList = [...places.entries()].sort((x, y) => (y[1].city - x[1].city));
    for (const [name, p] of placeList) {
      const lon = p.stations.reduce((t, s) => t + s.lon, 0) / p.stations.length;
      const lat = p.stations.reduce((t, s) => t + s.lat, 0) / p.stations.length;
      addLabel('place', name, [lon, lat]);
    }
    for (const name of used) {
      const s = stations.get(name);
      addLabel('station', s.station, [s.lon, s.lat]);
    }
    layoutLabels();
  }

  function addLabel(kind, text, lngLat) {
    const el = labelEl(text, kind === 'place' ? 'lbl-place' : 'lbl-station');
    const marker = new maplibregl.Marker({
      element: el,
      anchor: kind === 'place' ? 'bottom' : 'top',
      offset: kind === 'place' ? [0, -8] : [0, 7]
    }).setLngLat(lngLat).addTo(map);
    labels.push({ kind, text, lngLat, el, marker });
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
    setData(stations, journeys) {
      if (loaded) apply(stations, journeys);
      else pendingData = { stations, journeys };
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
