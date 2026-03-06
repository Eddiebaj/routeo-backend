const OC_API_KEY = 'e85c07c79cfc45f1b429ce62dcfbab30';
const TRIP_UPDATES_URL = 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates?format=json';
const STOPS_URL = 'https://raw.githubusercontent.com/Eddiebaj/routeo-backend/main/api/stops.txt';

let stopsCache = null;

async function loadStops() {
  if (stopsCache) return stopsCache;
  const resp = await fetch(STOPS_URL);
  const txt = await resp.text();
  const lines = txt.split('\n');
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim().replace(/\r/g, '');
    if (!line) continue;
    const cols = line.split(',');
    const stopId = cols[0] ? cols[0].trim() : '';
    const lat = parseFloat(cols[4]);
    const lng = parseFloat(cols[5]);
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const now = Math.floor(Date.now() / 1000);
    const isDebug = req.query.debug === '1';

    const [stopsMap, tuData] = await Promise.all([
      loadStops(),
      fetch(TRIP_UPDATES_URL, {
        headers: { 'Ocp-Apim-Subscription-Key': OC_API_KEY },
      }).then(r => r.json()),
    ]);

    const entities = tuData.Entity || [];
    const seen = new Set();
    const vehicles = [];
    let noSegment = 0, noStopCoords = 0;

    for (const ent of entities) {
      const tu = ent.TripUpdate;
      if (!tu) continue;

      const trip = tu.Trip || {};
      const routeId = String(trip.RouteId || '?');
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
      });
    }

    const resp = { vehicles, count: vehicles.length, source: 'gtfs-rt-interpolated' };
    if (isDebug) {
      resp.debug = {
        totalEntities: entities.length,
        stopsLoaded: Object.keys(stopsMap).length,
        noSegment,
        noStopCoords,
        sampleStopIds: entities.slice(0, 3).map(e => e.TripUpdate && e.TripUpdate.StopTimeUpdate && e.TripUpdate.StopTimeUpdate[0] ? e.TripUpdate.StopTimeUpdate[0].StopId : null),
        sampleStopsMapKeys: Object.keys(stopsMap).slice(0, 5),
      };
    }

    res.json(resp);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
