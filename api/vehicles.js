const { checkRateLimit } = require('./_rateLimit');
const { buildStoUrl } = require('./_sto');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── OC Transpo config ────────────────────────────────────────
const OC_API_KEY = process.env.OC_TRANSPO_TU_KEY; // TripUpdates subscription
const TRIP_UPDATES_URL = 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates?format=json';

let stopsCache = null;
let stopsCacheTs = 0;
const STOPS_TTL = 24 * 60 * 60 * 1000;

async function loadStops() {
  if (stopsCache && Date.now() - stopsCacheTs < STOPS_TTL) return stopsCache;
  const { data, error } = await supabase
    .from('stops')
    .select('stop_id, stop_lat, stop_lon')
    .eq('agency', 'OC');
  if (error) {
    if (stopsCache) { console.warn('Stops load failed, using stale cache:', error.message); return stopsCache; }
    throw new Error(`Stops load failed: ${error.message}`);
  }
  const map = {};
  for (const row of (data || [])) {
    if (row.stop_id && row.stop_lat != null && row.stop_lon != null) {
      map[String(row.stop_id)] = { lat: row.stop_lat, lng: row.stop_lon };
    }
  }
  stopsCache = map;
  stopsCacheTs = Date.now();
  return map;
}

function getTime(stu) {
  const arr = stu.Arrival;
  const dep = stu.Departure;
  if (arr && arr.HasTime && arr.Time) return parseInt(arr.Time);
  if (dep && dep.HasTime && dep.Time) return parseInt(dep.Time);
  return 0;
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

  for (let idx = 0; idx < entities.length; idx++) {
    const ent = entities[idx];
    const tu = ent.TripUpdate;
    if (!tu) continue;

    const trip = tu.Trip || {};
    const routeId = trip.RouteId ? String(trip.RouteId) : '';
    if (!routeId) continue; // skip trips with no route ID
    const tripId = String(trip.TripId || ent.Id || 'unknown-' + (ent.vehicle?.vehicle?.id || ent.id || idx));
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

    const progress = (toTime === fromTime) ? 0.5 : Math.min(1, Math.max(0, (now - fromTime) / (toTime - fromTime)));

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
  if (await checkRateLimit(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  try {
    const now = Math.floor(Date.now() / 1000);
    const auth = req.headers['authorization'];
    const isDebug = req.query.debug === '1' && process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;

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
        stoEnabled: !!(process.env.STO_API_KEY && process.env.STO_PRIVATE_KEY),
        stoVehiclesSample: stoVehicles.slice(0, 3),
      };
    }

    res.json(resp);
  } catch (err) {
    console.error('vehicles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
