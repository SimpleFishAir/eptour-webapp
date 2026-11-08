// Setup, loading from Baserow, the journey list and the tap cards.
// All text from Baserow is shown with textContent, never as page code.

import { findTables, listRows, BaserowError } from './baserow.js';
import { parsePlaces, parseJourneys, placeDays, fmtDate, fmtTime, fmtDuration } from './data.js';
import { createMap } from './mapview.js';

const KEY_TOKEN = 'eptour.token';
const KEY_TABLES = 'eptour.tables';

const $ = id => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* nothing to do */ } }
};

let token = store.get(KEY_TOKEN);
let tables = readTables();
let map = null;
let stations = new Map();
let journeys = [];

function readTables() {
  try {
    const t = JSON.parse(store.get(KEY_TABLES) || 'null');
    return t && Number.isInteger(t.places) && Number.isInteger(t.journey) ? t : null;
  } catch (e) { return null; }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function errorText(err) {
  if (!(err instanceof BaserowError)) return 'Something went wrong. Try again.';
  switch (err.kind) {
    case 'network': return 'Couldn\'t reach Baserow. Check your connection and try again.';
    case 'refused': return 'Baserow refused the token. Check it was copied in full and has read access.';
    case 'not-found': return 'Baserow couldn\'t find a table. It may have been deleted or renamed.';
    default: return `Baserow returned an error${err.status ? ` (${err.status})` : ''}. Try again.`;
  }
}

/* ---------- screens ---------- */

function showSetup(message) {
  $('app').hidden = true;
  $('setup').hidden = false;
  $('setup-msg').textContent = message || '';
  $('token-input').value = '';
  $('token-input').focus();
}

function showApp() {
  $('setup').hidden = true;
  $('app').hidden = false;
  if (!map) {
    map = createMap($('map'), {
      onStation: showStationCard,
      onJourney: id => showJourneyCard(id, false),
      onEmpty: closeCard
    });
  }
}

/* ---------- setup ---------- */

$('setup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const t = $('token-input').value.trim();
  if (!t) { $('setup-msg').textContent = 'Paste your token first.'; return; }
  const btn = $('setup-save');
  btn.disabled = true;
  $('setup-msg').textContent = 'Checking…';
  try {
    let found = null;
    if (!$('ids-fallback').hidden) {
      const p = $('places-id').value.trim();
      const j = $('journey-id').value.trim();
      if (!/^\d+$/.test(p) || !/^\d+$/.test(j)) { $('setup-msg').textContent = 'Table IDs should be numbers only.'; return; }
      found = { places: parseInt(p, 10), journey: parseInt(j, 10) };
    } else {
      found = await findTables(t);
      if (!found) {
        $('ids-fallback').hidden = false;
        $('setup-msg').textContent = 'Couldn\'t find tables named exactly Places and Journey. Enter their IDs instead.';
        return;
      }
    }
    token = t;
    tables = found;
    const saved = store.set(KEY_TOKEN, token) && store.set(KEY_TABLES, JSON.stringify(tables));
    $('token-input').value = '';
    $('ids-fallback').hidden = true;
    showApp();
    if (!saved) showNotice(['This browser didn\'t allow saving, so you\'ll need to enter the token again next time.']);
    load();
  } catch (err) {
    $('setup-msg').textContent = errorText(err);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- loading ---------- */

async function load() {
  $('loading').hidden = false;
  try {
    if (!tables) {
      tables = await findTables(token);
      if (!tables) { forget('Couldn\'t find tables named exactly Places and Journey. Enter your token and the table IDs.'); $('ids-fallback').hidden = false; return; }
      store.set(KEY_TABLES, JSON.stringify(tables));
    }
    const [placeRows, journeyRows] = await Promise.all([listRows(tables.places, token), listRows(tables.journey, token)]);
    const p = parsePlaces(placeRows);
    const j = parseJourneys(journeyRows, p.stations);
    stations = p.stations;
    journeys = j.journeys;
    map.setData(stations, journeys, placeDays(journeys, stations));
    renderList();
    const problems = [...p.problems, ...j.problems];
    if (problems.length) showNotice(problems); else hideNotice();
    const now = new Date();
    $('updated').textContent = `Updated ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setTimeout(() => map.showAll(), 50);
  } catch (err) {
    if (err instanceof BaserowError && err.kind === 'not-found') {
      store.del(KEY_TABLES);
      tables = null;
    }
    showNotice([errorText(err)]);
  } finally {
    $('loading').hidden = true;
  }
}

function forget(message) {
  store.del(KEY_TOKEN);
  store.del(KEY_TABLES);
  token = null;
  tables = null;
  stations = new Map();
  journeys = [];
  closeCard();
  closeList();
  if (map) map.setData(stations, journeys);
  $('list-body').replaceChildren();
  $('updated').textContent = '';
  hideNotice();
  showSetup(message);
}

/* ---------- notice ---------- */

function showNotice(lines) {
  const box = $('notice-text');
  box.replaceChildren();
  lines.slice(0, 3).forEach(l => box.append(el('div', '', l)));
  if (lines.length > 3) box.append(el('div', '', `And ${lines.length - 3} more.`));
  $('notice').hidden = false;
}
function hideNotice() { $('notice').hidden = true; }
$('notice-close').addEventListener('click', hideNotice);

/* ---------- cards ---------- */

function modeLine(j) {
  return [j.mode.charAt(0).toUpperCase() + j.mode.slice(1), j.num, j.company].filter(Boolean).join(' · ');
}

function openCard(children) {
  const body = $('card-body');
  body.replaceChildren(...children);
  closeList();
  $('card').hidden = false;
}
function closeCard() { $('card').hidden = true; }

function showStationCard(name) {
  const s = stations.get(name);
  if (!s) return;
  const items = [el('h3', '', s.station), el('p', 'sub', [s.place !== s.station ? s.place : '', s.country].filter(Boolean).join(', '))];
  const list = el('ul', 'mini');
  journeys.filter(j => j.from === name || j.to === name).forEach(j => {
    const li = el('li');
    const btn = el('button', 'row');
    btn.type = 'button';
    const leaving = j.from === name;
    btn.append(
      el('span', 'when', `${fmtDate(j.date)} ${fmtTime(leaving ? j.dep : j.arr)}`),
      el('span', 'what', leaving ? `To ${j.to}` : `From ${j.from}`),
      el('span', 'meta', modeLine(j))
    );
    btn.addEventListener('click', () => showJourneyCard(j.id, true));
    li.append(btn);
    list.append(li);
  });
  items.push(list);
  openCard(items);
}

function showJourneyCard(id, zoom) {
  const j = journeys.find(x => x.id === id);
  if (!j) return;
  const items = [
    el('h3', '', `${j.from} → ${j.to}`),
    el('p', 'sub', `${fmtDate(j.date)}, ${fmtTime(j.dep)} to ${fmtTime(j.arr)}${fmtDuration(j.arrUtc - j.depUtc) ? ` (${fmtDuration(j.arrUtc - j.depUtc)})` : ''}`),
    el('p', 'meta', modeLine(j))
  ];
  openCard(items);
  if (zoom) map.focusJourney(id, $('card').offsetHeight + 20);
}

$('card-close').addEventListener('click', closeCard);

/* ---------- journey list ---------- */

function renderList() {
  const body = $('list-body');
  body.replaceChildren();
  if (!journeys.length) { body.append(el('p', 'sub', 'No journeys to show yet.')); return; }
  let lastDate = null;
  let ul = null;
  for (const j of journeys) {
    if (j.date !== lastDate) {
      body.append(el('h3', 'day', fmtDate(j.date)));
      ul = el('ul', 'mini');
      body.append(ul);
      lastDate = j.date;
    }
    const li = el('li');
    const btn = el('button', 'row');
    btn.type = 'button';
    btn.append(
      el('span', 'when', `${fmtTime(j.dep)} to ${fmtTime(j.arr)}`),
      el('span', 'what', `${j.from} → ${j.to}`),
      el('span', 'meta', modeLine(j))
    );
    btn.addEventListener('click', () => showJourneyCard(j.id, true));
    li.append(btn);
    ul.append(li);
  }
}

function openList() { closeCard(); $('list').hidden = false; }
function closeList() { $('list').hidden = true; }
$('btn-list').addEventListener('click', () => ($('list').hidden ? openList() : closeList()));
$('list-close').addEventListener('click', closeList);

/* ---------- menu ---------- */

let forgetArmed = null;
$('btn-menu').addEventListener('click', () => {
  const open = $('menu').hidden;
  $('menu').hidden = !open;
  $('btn-menu').setAttribute('aria-expanded', String(open));
});
$('btn-refresh').addEventListener('click', () => { $('menu').hidden = true; load(); });
$('btn-showall').addEventListener('click', () => { $('menu').hidden = true; closeCard(); closeList(); map.showAll(); });
$('btn-forget').addEventListener('click', () => {
  const b = $('btn-forget');
  if (!forgetArmed) {
    b.textContent = 'Tap again to forget';
    forgetArmed = setTimeout(() => { b.textContent = 'Forget token'; forgetArmed = null; }, 4000);
    return;
  }
  clearTimeout(forgetArmed);
  forgetArmed = null;
  b.textContent = 'Forget token';
  $('menu').hidden = true;
  forget('Token forgotten. Paste it again to reload your trip.');
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeCard(); closeList(); $('menu').hidden = true; }
});

/* ---------- start ---------- */

if (token) { showApp(); load(); } else { showSetup(); }
