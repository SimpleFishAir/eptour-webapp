// Reading, checking and preparing the Places and Journey rows.
// Times in the Journey table are local to each station; the station's
// time zone (from Places) turns them into exact moments for comparison.

export const TRIP_YEAR = 2026;

export const MODES = ['train', 'ferry', 'flight', 'car'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Baserow values can be plain text, numbers, linked rows or select options.
export function val(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(x => val(x && typeof x === 'object' && 'value' in x ? x.value : x)).filter(Boolean).join(', ');
  if (typeof v === 'object' && 'value' in v) return val(v.value);
  return '';
}

const formatters = new Map();
function formatterFor(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
  }
  return formatters.get(tz);
}

export function isValidTimeZone(tz) {
  if (!tz) return false;
  try { formatterFor(tz); return true; } catch (e) { return false; }
}

function localParts(utcMs, tz) {
  const parts = {};
  for (const p of formatterFor(tz).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  return parts;
}

// Calendar day number (days since 1 Jan 1970) of a moment, in a time zone.
function localDayNumber(utcMs, tz) {
  const p = localParts(utcMs, tz);
  return Math.round(Date.UTC(+p.year, +p.month - 1, +p.day) / 86400000);
}

function offsetMs(utcMs, tz) {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - utcMs;
}

// Local wall-clock time in a time zone -> exact moment (milliseconds since 1970, UTC).
export function zonedToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(guess, tz);
  let t = guess - first;
  const second = offsetMs(t, tz);
  if (second !== first) t = guess - second;
  return t;
}

export function fmtDate(dateText) {
  const m = /^(\d{2})-(\d{2})$/.exec(dateText);
  if (!m) return dateText;
  return `${parseInt(m[1], 10)} ${MONTHS[parseInt(m[2], 10) - 1]}`;
}

export function fmtTime(hhmm) {
  return /^\d{4}$/.test(hhmm) ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : hhmm;
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function parsePlaces(rows) {
  const stations = new Map();
  const problems = [];
  for (const r of rows) {
    const station = val(r.station);
    if (!station) continue;
    const lat = parseFloat(val(r.latitude));
    const lon = parseFloat(val(r.longitude));
    const tz = val(r.time_zone);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      problems.push(`Places: "${station}" has invalid coordinates.`);
      continue;
    }
    if (!isValidTimeZone(tz)) {
      problems.push(`Places: "${station}" has an unknown time zone.`);
      continue;
    }
    if (stations.has(station)) {
      problems.push(`Places: "${station}" appears more than once; the first row is used.`);
      continue;
    }
    stations.set(station, {
      station,
      place: val(r.place) || station,
      country: val(r.country),
      lat, lon, tz,
      type: val(r.type)
    });
  }
  return { stations, problems };
}

export function parseJourneys(rows, stations) {
  const journeys = [];
  const problems = [];
  rows.forEach((r, i) => {
    const mode = val(r.type).toLowerCase();
    const from = val(r.location_start);
    const to = val(r.location_end);
    const dep = val(r.departure);
    const arr = val(r.arrival);
    const date = val(r.date);
    const label = from && to ? `${from} to ${to}` : `row ${i + 1}`;

    if (!MODES.includes(mode)) { problems.push(`Journey ${label}: unknown type "${val(r.type)}".`); return; }
    const a = stations.get(from);
    const b = stations.get(to);
    if (!a) { problems.push(`Journey ${label}: station "${from}" is not in Places.`); return; }
    if (!b) { problems.push(`Journey ${label}: station "${to}" is not in Places.`); return; }
    const dm = /^(\d{2})-(\d{2})$/.exec(date);
    if (!dm) { problems.push(`Journey ${label}: date "${date}" is not in dd-mm format.`); return; }
    const tDep = /^([01]\d|2[0-3])([0-5]\d)$/.exec(dep);
    const tArr = /^([01]\d|2[0-3])([0-5]\d)$/.exec(arr);
    if (!tDep || !tArr) { problems.push(`Journey ${label}: times must be four digits (HHMM).`); return; }

    const day = parseInt(dm[1], 10);
    const month = parseInt(dm[2], 10);
    const depUtc = zonedToUtc(TRIP_YEAR, month, day, +tDep[1], +tDep[2], a.tz);
    let arrUtc = zonedToUtc(TRIP_YEAR, month, day, +tArr[1], +tArr[2], b.tz);
    if (arrUtc <= depUtc) arrUtc = zonedToUtc(TRIP_YEAR, month, day + 1, +tArr[1], +tArr[2], b.tz);

    journeys.push({
      id: i,
      mode, from, to,
      dep, arr, date,
      num: val(r.num),
      company: val(r.company),
      depUtc, arrUtc
    });
  });
  journeys.sort((x, y) => x.depUtc - y.depUtc);
  return { journeys, problems };
}

// Days at each place, worked out from the journeys (sorted by departure).
// A stay is an arrival at a place followed by the next journey leaving the
// same place (from any of its stations) on a later calendar day. It counts
// every calendar day, including the arrival and departure days: arriving
// 17 Oct and leaving 20 Oct is 4 days. Changes on the same day, and the
// trip's first departure and last arrival, are not stays. Repeat visits to
// a place add up, but each calendar day is counted once: leaving for a day
// trip and coming back the same day doesn't count that day twice (Basel
// 24 to 26 Oct with a day trip to Zurich on 25 Oct is 3 days, not 4).
// Returns a Map of place name to days.
export function placeDays(journeys, stations) {
  const daysAt = new Map();
  for (let i = 0; i + 1 < journeys.length; i++) {
    const a = stations.get(journeys[i].to);
    const b = stations.get(journeys[i + 1].from);
    if (!a || !b || a.place !== b.place) continue;
    const arrived = localDayNumber(journeys[i].arrUtc, a.tz);
    const left = localDayNumber(journeys[i + 1].depUtc, b.tz);
    if (left <= arrived) continue;
    if (!daysAt.has(a.place)) daysAt.set(a.place, new Set());
    const set = daysAt.get(a.place);
    for (let d = arrived; d <= left; d++) set.add(d);
  }
  return new Map([...daysAt].map(([place, set]) => [place, set.size]));
}

// The station first arrived at in each place (by arrival time). For a place
// with several stations, the day number is shown on this one only.
// Returns a Map of place name to station name.
export function firstArrivals(journeys, stations) {
  const first = new Map();
  for (const j of [...journeys].sort((x, y) => x.arrUtc - y.arrUtc)) {
    const s = stations.get(j.to);
    if (s && !first.has(s.place)) first.set(s.place, j.to);
  }
  return first;
}
