// Builds src/data/spots.json by querying the live Mapillary API.
// Run from the repo root:  node src/data/build-spots.mjs
// Reads VITE_MAPILLARY_TOKEN from .env.local by parsing it (never sourced, never printed).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Single source of truth: read the limit the runtime enforces straight from src/config.ts.
const MAX_OFFSET_M = (() => {
  const src = readFileSync(fileURLToPath(new URL('../config.ts', import.meta.url)), 'utf8');
  const m = /maxYearOffsetMetres:\s*(\d+(?:\.\d+)?)/u.exec(src);
  if (!m) throw new Error('maxYearOffsetMetres not found in src/config.ts');
  return Number(m[1]);
})();
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
  ['Dundas Square, Toronto', 43.6561, -79.3802],
  ['Place Jacques-Cartier, Montreal', 45.5081, -73.5524],
  ['Unter den Linden, Berlin', 52.517, 13.3889],
  ['Alexanderplatz, Berlin', 52.5219, 13.4132],
  ['Karlsplatz, Vienna', 48.2005, 16.3714],
  ['Piazza Navona, Rome', 41.8992, 12.4731],
  ['Ponte Vecchio, Florence', 43.768, 11.2531],
  ['Plaza de Espana, Seville', 37.3772, -5.9869],
  ['Rossio Square, Lisbon', 38.7139, -9.1394],
  ['Temple Bar, Dublin', 53.3455, -6.2644],
  ['Royal Mile, Edinburgh', 55.9502, -3.1875],
  ['Rynek, Wroclaw', 51.11, 17.0326],
  ['Vaclavske namesti, Prague', 50.081, 14.4264],
  ['Helsinki Senate Square', 60.1698, 24.9522],
  ['Dotonbori, Osaka', 34.6687, 135.5013],
  ['Kiyomizu-dera approach, Kyoto', 34.9949, 135.785],
  ['Hongdae, Seoul', 37.5563, 126.9236],
  ['Hanoi Old Quarter', 21.034, 105.851],
  ['Jemaa el-Fnaa, Marrakech', 31.6258, -7.9891],
  ['Mission District, San Francisco', 37.7599, -122.4148],
  ['Jackson Square, New Orleans', 29.9574, -90.0629],
  ['Faneuil Hall, Boston', 42.36, -71.0568],
  ['Lincoln Road, Miami Beach', 25.7906, -80.1401],
  ['Congress Avenue, Austin', 30.2672, -97.7431],
  ['Gastown, Vancouver', 49.2837, -123.1088],
  ['Bondi Beach, Sydney', -33.8908, 151.2743],
  ['Kennedy Park, Miraflores, Lima', -12.1219, -77.0297],
  ['Plaza de Mayo, Buenos Aires', -34.6083, -58.3712],
  ['Union Station, Washington DC', 38.8977, -77.0063],
  ['Lincoln Memorial, Washington DC', 38.8893, -77.0502],
  ['Harvard Square, Cambridge', 42.3736, -71.1190],
  ['Pennsylvania Avenue, Washington DC', 38.8951, -77.0364],
  ['Millennium Park, Chicago', 41.8826, -87.6226],
  ['Navy Pier, Chicago', 41.8917, -87.6039],
  ['Broadway, Nashville', 36.1612, -86.7775],
  ['Peachtree Street, Atlanta', 33.7590, -84.3880],
  ['Rittenhouse Square, Philadelphia', 39.9496, -75.1718],
  ['Independence Hall, Philadelphia', 39.9489, -75.1500],
  ['Granville Street, Vancouver', 49.2827, -123.1207],
  ['Rue Sainte-Catherine, Montreal', 45.5088, -73.5673],
  ['Old Port, Quebec City', 46.8123, -71.2058],
  ['Stortorget, Malmo', 55.6050, 13.0000],
  ['Rathausplatz, Vienna', 48.2108, 16.3589],
  ['Grote Markt, Antwerp', 51.2211, 4.3997],
  ['Markt, Bruges', 51.2093, 3.2247],
  ['Neumarkt, Dresden', 51.0515, 13.7415],
  ['Domplatz, Cologne', 50.9413, 6.9583],
  ['Place Bellecour, Lyon', 45.7578, 4.8320],
  ['Vieux Port, Marseille', 43.2951, 5.3744],
  ['Ghent Korenmarkt', 51.0538, 3.7219],
  ['Tallinn Town Hall Square', 59.4372, 24.7454],
  ['Riga Dome Square', 56.9496, 24.1052],
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
  for (let attempt = 0; attempt < 4; attempt++) {
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
const HALF_BOX_DEG = 0.0012; // about 270 m box; larger boxes make dense cities fail with "reduce the amount of data"

// The named coordinate is rarely on a street Mapillary covers, so search a box around it
// and anchor the spot on a panorama. Years are measured from that panorama's own position, which
// is what the runtime does (yearsAt at the shown pano), so a spot that passes here opens with the
// same years. Every panorama is tried as an anchor. Among anchors with at least MIN_YEARS the
// newest capture wins (the spot opens on current imagery), then most years, then nearest the name.
async function check([name, lat0, lng0]) {
  const all = []; // {id, year, lat, lng}
  const queryYears = [];
  for (let y = 2014; y <= thisYear; y++) queryYears.push(y);
  const perYear = await Promise.all(
    queryYears.map((y) =>
      api({
        fields: FIELDS,
        bbox: [lng0 - HALF_BOX_DEG, lat0 - HALF_BOX_DEG, lng0 + HALF_BOX_DEG, lat0 + HALF_BOX_DEG]
          .map((n) => n.toFixed(6))
          .join(','),
        is_pano: 'true',
        limit: 500,
        start_captured_at: `${y}-01-01T00:00:00Z`,
        end_captured_at: `${y}-12-31T23:59:59Z`,
      }),
    ),
  );
  for (const data of perYear) {
    for (const img of data) {
      const c = (img.computed_geometry ?? img.geometry)?.coordinates;
      if (!c) continue;
      all.push({ id: String(img.id), year: new Date(img.captured_at).getUTCFullYear(), lat: c[1], lng: c[0] });
    }
  }
  const latTol = MAX_OFFSET_M / 111_000; // cheap reject before the haversine
  const rank = (x) => [x.score >= MIN_YEARS ? 1 : 0, x.score >= MIN_YEARS ? x.a.year : 0, x.score, -x.centre];
  const better = (x, y) => {
    const rx = rank(x);
    const ry = rank(y);
    for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i] > ry[i];
    return false;
  };
  let bestAnchor = null;
  for (const a of all) {
    const years = new Set();
    for (const p of all) {
      if (Math.abs(p.lat - a.lat) > latTol) continue;
      if (dist(a.lat, a.lng, p.lat, p.lng) <= MAX_OFFSET_M) years.add(p.year);
    }
    const cand = { score: years.size, centre: dist(lat0, lng0, a.lat, a.lng), a, years };
    if (!bestAnchor || better(cand, bestAnchor)) bestAnchor = cand;
  }
  if (!bestAnchor) return { name, lat: lat0, lng: lng0, years: [] };
  const { a } = bestAnchor;
  const years = [...bestAnchor.years].sort((x, y) => x - y);
  return { name, lat: a.lat, lng: a.lng, panoId: a.id, years, centre: bestAnchor.centre };
}

// Every run re-checks every candidate, so the whole file is verified at the current limit.
// Pass --resume to continue an interrupted run; it is refused if the limit changed in between.
const SPOTS_FILE = fileURLToPath(new URL('./spots.json', import.meta.url));
const META_FILE = fileURLToPath(new URL('./spots.meta.json', import.meta.url));
const args = process.argv.slice(2);
let accepted = [];
if (args.includes('--resume')) {
  const meta = JSON.parse(readFileSync(META_FILE, 'utf8'));
  if (meta.maxOffsetM !== MAX_OFFSET_M) {
    throw new Error(`spots.json was built at ${meta.maxOffsetM} m, config says ${MAX_OFFSET_M} m; run without --resume`);
  }
  accepted = JSON.parse(readFileSync(SPOTS_FILE, 'utf8'));
}
const have = new Set(accepted.map((s) => s.name));
// Optional numeric argument: index of the first candidate to check (skip ones already rejected in earlier runs).
const START = Number(args.find((x) => /^\d+$/u.test(x)) ?? 0);
const queue = CANDIDATES.slice(START).filter((c) => !have.has(c[0]));
const save = () => {
  writeFileSync(SPOTS_FILE, JSON.stringify(accepted, null, 2) + '\n');
  writeFileSync(META_FILE, JSON.stringify({ maxOffsetM: MAX_OFFSET_M, minYears: MIN_YEARS }, null, 2) + '\n');
};
async function worker() {
  while (queue.length && accepted.length < TARGET) {
    const cand = queue.shift();
    let r;
    try {
      r = await check(cand);
    } catch (e) {
      console.log(`ERROR  ${cand[0]}: ${e.message}`);
      continue;
    }
    const ok = r.years.length >= MIN_YEARS;
    console.log(`${ok ? 'OK    ' : 'REJECT'} ${r.name}: ${r.years.length} years [${r.years.join(', ')}] anchor ${Math.round(r.centre ?? 0)} m from named point`);
    if (!ok || accepted.length >= TARGET) continue;
    accepted.push({ name: r.name, lat: +r.lat.toFixed(6), lng: +r.lng.toFixed(6), panoId: r.panoId, years: r.years });
    save(); // keep progress if the run is interrupted
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

// Keep the candidate order so the file does not depend on which worker finished first.
const order = new Map(CANDIDATES.map((c, i) => [c[0], i]));
accepted.sort((x, y) => order.get(x.name) - order.get(y.name));
save();
console.log(`\nWrote ${accepted.length} spots to src/data/spots.json`);
