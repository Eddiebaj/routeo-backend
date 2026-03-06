const fs = require('fs');
const path = require('path');

const OC_API_KEY = 'e85c07c79cfc45f1b429ce62dcfbab30';
const TRIP_UPDATES_URL = 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates?format=json';

let stopsCache = null;
function getStopsMap() {
  if (stopsCache) return stopsCache;
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', 'stops.txt'), 'utf8');
    const lines = txt.split('\n');
    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim().replace(/\r/g, '');
      if (!line) continue;
      const cols = line.split(',');
      const stopId = cols[0]?.trim();
      const lat = parseFloat(cols[4]);
      const lng = parseFloat(cols[5]);
      if (stopId && !isNaN(lat) && !isNaN(lng)) {
        map[stopId] = { lat, lng };
      }
    }
    stopsCache = map;
    return map;
  } catch (e) {
    console.error('Failed to parse stops.txt:', e.message);
    return {};
  }
}

function getTime(stu) {
  // Try Arrival first, then Departure — either may be null
  const arr = stu.Arrival;
  const dep = stu.Departure;
  if (arr && arr.HasTime && arr.Time) return parseInt(arr.Time);
  if (dep && dep.HasTime && dep.Time) return parseInt(dep.Time);
  return 0;
}

function interpolate(lat1, lon1, lat2, lon2, t) {
  return {
    lat: lat1 + (lat2 - lat1) * t,
    lng: lon1 + (lon2 - lon1) * t,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  const isDebug = req.query.debug === '1';

  try {
    const now = Math.floor(Date.now() / 1000);
    const stopsMap = getStopsMap();
    const stopsCount = Object.keys(stopsMap).length;

    // 1. Fetch TripUpdates
    const tuResp = await fetch(TRIP_UPDATES_URL, {
      headers: { 'Ocp-Apim-Subscription-Key': OC_API_KEY },
    });
    const tuData = await tuResp.json();
    const entities = tuData?.Entity || [];

    const seen = new Set();
    const vehicles = [];
    let noSegment = 0, noStopCoords = 0;

    for (const ent of entities) {
      const tu = ent.TripUpdate;
      if (!tu) continue;

      const trip = tu.Trip || {};
      const routeId = String(trip.RouteId || '?');
      const tripId = String(trip.TripId || ent.Id);
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

      if (!fromStop || !toStop || !fromTime || !toTime) {
        noSegment++;
        continue;
      }

      const from = stopsMap[fromStop];
      const to = stopsMap[toStop];
      if (!from || !to) {
        noStopCoords++;
        continue;
      }

      const key = `${routeId}-${fromStop}-${toStop}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const elapsed = now - fromTime;
      const total = toTime - fromTime;
      const progress = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 0.5;
      const pos = interpolate(from.lat, from.lng, to.lat, to.lng, progress);

      vehicles.push({
        id: tripId,
        routeId,
        lat: pos.lat,
        lng: pos.lng,
        fromStop,
        toStop,
        progress: Math.round(progress * 100),
      });
    }

    const resp = { vehicles, count: vehicles.length, source: 'gtfs-rt-interpolated' };
    if (isDebug) {
      resp.debug = {
        totalEntities: entities.length,
        stopsLoaded: stopsCount,
        noSegment,
        noStopCoords,
        sampleStopIds: entities.slice(0, 3).map(e => e.TripUpdate?.StopTimeUpdate?.[0]?.StopId),
        sampleStopsMapKeys: Object.keys(stopsMap).slice(0, 5),
        now,
      };
    }

    res.json(resp);

  } catch (err) {
    console.error('vehicles error:', err);
    res.status(500).json({ error: err.message });
  }
};
