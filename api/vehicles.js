const crypto = require('crypto');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

// ── OC Transpo config ────────────────────────────────────────
const OC_API_KEY = process.env.OC_TRANSPO_API_KEY;
const TRIP_UPDATES_URL = 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates?format=json';
const STOPS_URL = 'https://raw.githubusercontent.com/Eddiebaj/routeo-backend/main/api/stops.txt';

// ── STO config ───────────────────────────────────────────────
const STO_HOST = 'https://gtfs.sto.ca/download.php';
const STO_PUBLIC_KEY = process.env.STO_API_KEY;
const STO_PRIVATE_KEY = process.env.STO_PRIVATE_KEY;

let stopsCache = null;

async function loadStops() {
  if (stopsCache) return stopsCache;
  const resp = await fetch(STOPS_URL, { signal: AbortSignal.timeout(10000) });
  const txt = await resp.text();
  const lines = txt.split('\n');
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim().replace(/\r/g, '');
    if (!line) continue;
    const cols = line.split(',');
    const stopId = cols[0] ? cols[0].trim() : '';
    const lat = parseFloat(cols[5]);
    const lng = parseFloat(cols[6]);
    if (stopId && !isNaN(lat) && !isNaN(lng)) {
      map[stopId] = { lat, lng };
    }
  }
  stopsCache = map;
  return map;
}

function getTime(stu) {
  const arr = stu.Arrival;
  const dep = stu.Departure;
  if (arr && arr.HasTime && arr.Time) return parseInt(arr.Time);
  if (dep && dep.HasTime && dep.Time) return parseInt(dep.Time);
  return 0;
}

// ── STO auth: SHA256(private_key + UTC timestamp) ────────────
function buildStoUrl(fileType) {
  if (!STO_PUBLIC_KEY || !STO_PRIVATE_KEY) return null;
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const dateIso = `${y}${mo}${d}T${h}${mi}Z`;
  const salted = STO_PRIVATE_KEY + dateIso;
  const hash = crypto.createHash('sha256').update(salted, 'utf8').digest('hex').toUpperCase();
  return `${STO_HOST}?hash=${hash}&file=${fileType}&key=${STO_PUBLIC_KEY}`;
}

// ── Fetch STO VehiclePositions (protobuf) ────────────────────
async function fetchStoVehicles() {
  const url = buildStoUrl('vehicule');
  if (!url) return [];

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`STO HTTP ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const vehicles = [];
    for (const entity of feed.entity) {
      const vp = entity.vehicle;
      if (!vp || !vp.position) continue;

      const trip = vp.trip || {};
      const routeId = trip.routeId ? String(trip.routeId) : '';
      if (!routeId) continue; // skip vehicles with no route ID
      const tripId = String(trip.tripId || entity.id || '');
      const lat = vp.position.latitude;
      const lng = vp.position.longitude;

      if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) continue;

      vehicles.push({
        id: `STO-${tripId || entity.id}`,
        routeId,
        lat,
        lng,
        fromStop: String(vp.stopId || ''),
        toStop: '',
        progress: 0,
        agency: 'STO',
      });
    }
    return vehicles;
  } catch (err) {
    console.warn('STO vehicles fetch failed:', err.message);
    return [];
  }
}

// ── Fetch OC Transpo vehicles (JSON TripUpdates + interpolation) ──
async function fetchOcVehicles(stopsMap, now, isDebug) {
  if (!OC_API_KEY) { console.warn('OC_TRANSPO_API_KEY not set'); return { vehicles: [], debug: null }; }
  const tuResp = await fetch(TRIP_UPDATES_URL, {
    headers: { 'Ocp-Apim-Subscription-Key': OC_API_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!tuResp.ok) throw new Error(`OC HTTP ${tuResp.status}`);
  const tuData = await tuResp.json();

  const entities = tuData.Entity || [];
  const seen = new Set();
  const vehicles = [];
  let noSegment = 0, noStopCoords = 0;

  for (const ent of entities) {
    const tu = ent.TripUpdate;
    if (!tu) continue;

    const trip = tu.Trip || {};
    const routeId = trip.RouteId ? String(trip.RouteId) : '';
    if (!routeId) continue; // skip trips with no route ID
    const tripId = String(trip.TripId || ent.Id || Math.random());
    const updates = tu.StopTimeUpdate || [];

    let fromStop = null, toStop = null, fromTime = null, toTime = null;

    for (let i = 0; i < updates.length; i++) {
      const stu = updates[i];
      const stopId = String(stu.StopId || '');
      const t = getTime(stu);
      if (!t || !stopId) continue;

      if (t <= now) {
        fromStop = stopId;
        fromTime = t;
      } else if (!toStop) {
        toStop = stopId;
        toTime = t;
        break;
      }
    }

    if (!fromStop || !toStop || !fromTime || !toTime) { noSegment++; continue; }

    const from = stopsMap[fromStop];
    const to = stopsMap[toStop];
    if (!from || !to) { noStopCoords++; continue; }

    const key = `${routeId}-${fromStop}-${toStop}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const progress = Math.min(1, Math.max(0, (now - fromTime) / (toTime - fromTime)));

    vehicles.push({
      id: tripId,
      routeId,
      lat: from.lat + (to.lat - from.lat) * progress,
      lng: from.lng + (to.lng - from.lng) * progress,
      fromStop,
      toStop,
      progress: Math.round(progress * 100),
      agency: 'OC_TRANSPO',
    });
  }

  const debug = isDebug ? {
    totalEntities: entities.length,
    stopsLoaded: Object.keys(stopsMap).length,
    noSegment,
    noStopCoords,
    sampleStopIds: entities.slice(0, 3).map(e => e.TripUpdate && e.TripUpdate.StopTimeUpdate && e.TripUpdate.StopTimeUpdate[0] ? e.TripUpdate.StopTimeUpdate[0].StopId : null),
    sampleStopsMapKeys: Object.keys(stopsMap).slice(0, 5),
  } : null;

  return { vehicles, debug };
}

// ── Main handler ─────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const now = Math.floor(Date.now() / 1000);
    const isDebug = req.query.debug === '1';

    // Fetch OC Transpo + STO in parallel
    const [stopsMap, stoVehicles] = await Promise.all([
      loadStops(),
      fetchStoVehicles(),
    ]);

    const { vehicles: ocVehicles, debug: ocDebug } = await fetchOcVehicles(stopsMap, now, isDebug);

    let allVehicles = [...ocVehicles, ...stoVehicles];

    // Filter by route IDs if ?routes= param provided
    const routesParam = req.query.routes;
    if (routesParam) {
      const wanted = new Set(routesParam.split(',').map(r => r.trim()));
      allVehicles = allVehicles.filter(v => wanted.has(v.routeId));
    }

    const resp = {
      vehicles: allVehicles,
      count: allVehicles.length,
      ocCount: ocVehicles.length,
      stoCount: stoVehicles.length,
      source: 'gtfs-rt-interpolated',
    };

    if (isDebug) {
      resp.debug = {
        ...ocDebug,
        stoEnabled: !!(STO_PUBLIC_KEY && STO_PRIVATE_KEY),
        stoVehiclesSample: stoVehicles.slice(0, 3),
      };
    }

    res.json(resp);
  } catch (err) {
    console.error('vehicles error:', err);
    res.status(500).json({ error: err.message });
  }
};
