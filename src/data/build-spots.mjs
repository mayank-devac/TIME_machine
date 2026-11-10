// Builds src/data/spots.json by querying the live Mapillary API.
// Run from the repo root:  node src/data/build-spots.mjs
// Reads VITE_MAPILLARY_TOKEN from .env.local by parsing it (never sourced, never printed).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_OFFSET_M = 40; // keep in sync with config.maxYearOffsetMetres
const MIN_YEARS = 3;
const TARGET = 30;
const INTERVAL_MS = 120;

const CANDIDATES = [
  ['Times Square, New York', 40.758, -73.9855],
  ['Shibuya Crossing, Tokyo', 35.6595, 139.7005],
  ['Trafalgar Square, London', 51.508, -0.1281],
  ['Champs-Élysées, Paris', 48.8698, 2.3078],
  ['Brandenburg Gate, Berlin', 52.5163, 13.3777],
  ['Piazza San Marco, Venice', 45.434, 12.3388],
  ['Colosseum, Rome', 41.8902, 12.4922],
  ['Trevi Fountain, Rome', 41.9009, 12.4833],
  ['Las Ramblas, Barcelona', 41.3809, 2.1734],
  ['Puerta del Sol, Madrid', 40.4169, -3.7035],
  ['Dam Square, Amsterdam', 52.3731, 4.8936],
  ['Red Square, Moscow', 55.7539, 37.6208],
  ['Charles Bridge, Prague', 50.0865, 14.4114],
  ['Old Town Square, Prague', 50.0875, 14.4213],
  ['Sydney Opera House forecourt', -33.8568, 151.2153],
  ['Copacabana, Rio de Janeiro', -22.9711, -43.1822],
  ['Zocalo, Mexico City', 19.4326, -99.1332],
  ['Golden Gate Bridge viewpoint, San Francisco', 37.8078, -122.475],
  ['Market Street, San Francisco', 37.7879, -122.4075],
  ['Michigan Avenue, Chicago', 41.8886, -87.6244],
  ['Wall Street, New York', 40.7068, -74.0090],
  ['Washington Square Park, New York', 40.7308, -73.9973],
  ['Piccadilly Circus, London', 51.5099, -0.1337],
  ['Tower Bridge, London', 51.5055, -0.0754],
  ['Place de la Concorde, Paris', 48.8656, 2.3212],
  ['Eiffel Tower, Champ de Mars', 48.8558, 2.2986],
  ['Marienplatz, Munich', 48.1374, 11.5755],
  ['Stephansplatz, Vienna', 48.2086, 16.3733],
  ['Gamla Stan, Stockholm', 59.3251, 18.0711],
  ['Nyhavn, Copenhagen', 55.6798, 12.5906],
  ['Senso-ji, Asakusa, Tokyo', 35.7147, 139.7966],
  ['Myeongdong, Seoul', 37.5636, 126.9826],
  ['Orchard Road, Singapore', 1.3036, 103.8318],
  ['Khao San Road, Bangkok', 13.7589, 100.4974],
  ['Gateway of India, Mumbai', 18.9220, 72.8347],
  ['Pioneer Square, Portland', 45.5190, -122.6794],
  ['Pike Place Market, Seattle', 47.6097, -122.3425],
  ['Bourbon Street, New Orleans', 29.9584, -90.0652],
  ['Plaza de Armas, Cusco', -13.5167, -71.9786],
  ['Avenida de Mayo, Buenos Aires', -34.6091, -58.3837],
  ['Trg bana Jelacica, Zagreb', 45.8131, 15.9772],
  ['Rynek Glowny, Krakow', 50.0617, 19.9373],
  ['Grand Place, Brussels', 50.8467, 4.3525],
  ['Federation Square, Melbourne', -37.8180, 144.9691],
  ['Queen Street, Auckland', -36.8485, 174.7633],
  ['Cape Town Waterfront', -33.9036, 18.4207],
  ['Taksim Square, Istanbul', 41.0370, 28.9850],
  ['Piazza del Duomo, Milan', 45.4642, 9.1916],
  ['Plaza Mayor, Madrid', 40.4155, -3.7074],
  ['Union Square, San Francisco', 37.7879, -122.4074],
];

function readToken() {
  const file = fileURLToPath(new URL('../../.env.local', import.meta.url));
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const m = /^\s*VITE_MAPILLARY_TOKEN\s*=\s*(.*)$/u.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/gu, '');
  }
  throw new Error('VITE_MAPILLARY_TOKEN not found in .env.local');
}

const token = readToken();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

async function api(params) {
  const q = new URLSearchParams({ ...params, access_token: token });
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = last + INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(`https://graph.mapillary.com/images?${q}`);
    const body = await res.json().catch(() => ({}));
    if (body.error?.code === 4) {
      await sleep(3000);
      continue;
    }
    if (body.error) throw new Error(`Mapillary error ${body.error.code}: ${body.error.message}`);
    return body.data ?? [];
  }
  throw new Error('rate limited');
}

function dist(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLng - aLng) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

const FIELDS = 'id,captured_at,computed_geometry,geometry';
const thisYear = new Date().getUTCFullYear();
const HALF_BOX_DEG = 0.003; // 0.006 deg box, under Mapillary's 0.01 limit
const MAX_ANCHORS = 400;

// The named coordinate is rarely on a street Mapillary covers, so search a box around it
// and anchor the spot on the panorama that has the most distinct years within MAX_OFFSET_M.
async function check([name, lat0, lng0]) {
  const all = []; // {id, year, lat, lng}
  for (let y = 2014; y <= thisYear; y++) {
    const data = await api({
      fields: FIELDS,
      bbox: [lng0 - HALF_BOX_DEG, lat0 - HALF_BOX_DEG, lng0 + HALF_BOX_DEG, lat0 + HALF_BOX_DEG]
        .map((n) => n.toFixed(6))
        .join(','),
      is_pano: 'true',
      limit: 2000,
      start_captured_at: `${y}-01-01T00:00:00Z`,
      end_captured_at: `${y}-12-31T23:59:59Z`,
    });
    for (const img of data) {
      const c = (img.computed_geometry ?? img.geometry)?.coordinates;
      if (!c) continue;
      all.push({ id: String(img.id), year: new Date(img.captured_at).getUTCFullYear(), lat: c[1], lng: c[0] });
    }
  }
  const stride = Math.max(1, Math.floor(all.length / MAX_ANCHORS));
  let bestAnchor = null;
  for (let i = 0; i < all.length; i += stride) {
    const a = all[i];
    const nearest = new Map(); // year -> {id, d}
    for (const p of all) {
      const d = dist(a.lat, a.lng, p.lat, p.lng);
      if (d > MAX_OFFSET_M) continue;
      const cur = nearest.get(p.year);
      if (!cur || d < cur.d) nearest.set(p.year, { id: p.id, d });
    }
    const score = nearest.size;
    const centre = dist(lat0, lng0, a.lat, a.lng);
    if (!bestAnchor || score > bestAnchor.score || (score === bestAnchor.score && centre < bestAnchor.centre)) {
      bestAnchor = { score, centre, a, nearest };
    }
  }
  if (!bestAnchor) return { name, lat: lat0, lng: lng0, years: [], best: new Map() };
  const years = [...bestAnchor.nearest.keys()].sort((x, y) => x - y);
  const best = new Map();
  for (const y of years) best.set(y, { id: bestAnchor.nearest.get(y).id });
  return { name, lat: bestAnchor.a.lat, lng: bestAnchor.a.lng, years, best, centre: bestAnchor.centre };
}

const accepted = [];
for (const cand of CANDIDATES) {
  if (accepted.length >= TARGET) break;
  let r;
  try {
    r = await check(cand);
  } catch (e) {
    console.log(`ERROR  ${cand[0]}: ${e.message}`);
    continue;
  }
  const ok = r.years.length >= MIN_YEARS;
  console.log(`${ok ? 'OK    ' : 'REJECT'} ${r.name}: ${r.years.length} years [${r.years.join(', ')}] anchor ${Math.round(r.centre ?? 0)} m from named point`);
  if (!ok) continue;
  const latest = r.best.get(r.years[r.years.length - 1]);
  accepted.push({ name: r.name, lat: +r.lat.toFixed(6), lng: +r.lng.toFixed(6), panoId: latest.id, years: r.years });
}

writeFileSync(
  fileURLToPath(new URL('./spots.json', import.meta.url)),
  JSON.stringify(accepted, null, 2) + '\n',
);
console.log(`\nWrote ${accepted.length} spots to src/data/spots.json`);
