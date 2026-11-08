// Read-only access to Baserow. The token is sent only to api.baserow.io,
// never put in a URL, and requests carry no cookies or referrer.

const API = 'https://api.baserow.io';

export class BaserowError extends Error {
  constructor(kind, status) {
    super(kind);
    this.kind = kind;     // 'network' | 'refused' | 'not-found' | 'http' | 'bad-reply'
    this.status = status || 0;
  }
}

async function get(url, token) {
  if (!url.startsWith(API + '/api/')) throw new BaserowError('bad-reply');
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Token ' + token },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
  } catch (e) {
    throw new BaserowError('network');
  }
  if (res.status === 401 || res.status === 403) throw new BaserowError('refused', res.status);
  if (res.status === 404) throw new BaserowError('not-found', 404);
  if (!res.ok) throw new BaserowError('http', res.status);
  try {
    return await res.json();
  } catch (e) {
    throw new BaserowError('bad-reply', res.status);
  }
}

// Finds the tables named exactly "Places" and "Journey". Returns null if
// either is missing or appears more than once.
export async function findTables(token) {
  const list = await get(API + '/api/database/tables/all-tables/', token);
  if (!Array.isArray(list)) throw new BaserowError('bad-reply');
  const named = name => list.filter(t => t && t.name === name && Number.isInteger(t.id));
  const places = named('Places');
  const journey = named('Journey');
  if (places.length !== 1 || journey.length !== 1) return null;
  return { places: places[0].id, journey: journey[0].id };
}

export async function listRows(tableId, token) {
  if (!Number.isInteger(tableId)) throw new BaserowError('bad-reply');
  const prefix = `${API}/api/database/rows/table/${tableId}/`;
  let url = `${prefix}?user_field_names=true&size=200`;
  const rows = [];
  for (let page = 0; url && page < 25; page++) {
    const body = await get(url, token);
    if (!body || !Array.isArray(body.results)) throw new BaserowError('bad-reply');
    rows.push(...body.results);
    url = typeof body.next === 'string' && body.next.startsWith(prefix) ? body.next : null;
  }
  return rows;
}
