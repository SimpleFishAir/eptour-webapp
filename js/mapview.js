// The map: journeys as straight lines styled by type (flights as a gentle
// arc), stations as dots, and labels drawn by the browser: place names
// when zoomed out, station names as well when zoomed in.

import * as ml from 'maplibre-gl';
const maplibregl = ml.default || ml;

const STATION_ZOOM = 9;

const COLOURS = {
  train: '#1D9E75',
  ferry: '#378ADD',
  sleeper: '#7F77DD',
  flight: '#D85A30',
  car: '#BA7517'
};
const DASHES = {
  ferry: [2, 2],
  sleeper: [0.5, 2],
  car: [4, 2, 1, 2]
};

function palette() {
  const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark
    ? { bg: '#1f2023', dot: '#ecebe6', ring: '#1f2023', past: '#6b6b66' }
    : { bg: '#eef1f0', dot: '#2c2c2a', ring: '#ffffff', past: '#a9a8a2' };
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

  map.on('load', () => {
    map.addSource('journeys', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    for (const mode of Object.keys(COLOURS)) {
      const paint = {
        'line-color': ['case', ['get', 'past'], colours.past, COLOURS[mode]],
        'line-width': ['case', ['get', 'today'], 4.5, 2.5]
      };
      if (DASHES[mode]) paint['line-dasharray'] = DASHES[mode];
      map.addLayer({
        id: 'j-' + mode,
        type: 'line',
        source: 'journeys',
        filter: ['==', ['get', 'mode'], mode],
        layout: { 'line-cap': mode === 'sleeper' ? 'round' : 'butt', 'line-join': 'round' },
        paint
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
