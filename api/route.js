/**
 * RouteO — Bus Route Detail
 * GET /api/route?id=95                — stops, directions, first/last bus
 * GET /api/route?id=95&stop=3017      — frequency at a specific stop
 * GET /api/route?id=95&action=shape   — route polyline shape from OTP
 */

const OTP_BASE = 'https://routeo-otp-production.up.railway.app';

/** Decode Google encoded polyline string into [{latitude, longitude}] */
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://bzvkadttywgszovbowch.supabase.co',
  'sb_publishable_UQXeqJ_OE-Zhl51qrHVF3w_UXOxKk2O'
);

function timeToMins(t) {
  if (!t) return 9999;
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

function minsToTime(m) {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Determine the current OC Transpo service_id pattern.
 * Weekday services typically contain schedule codes like 'JAN25-...-Weekday-01'.
 */
function getDayType() {
  const dayName = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto', weekday: 'long' }).toLowerCase();
  if (dayName === 'sunday') return 'Sunday';
  if (dayName === 'saturday') return 'Saturday';
  return 'Weekday';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600');

  const routeId = (req.query.id || '').trim();
  if (!routeId) return res.status(400).json({ error: 'Missing id param' });

  const stopId = (req.query.stop || '').trim();
  const action = (req.query.action || '').trim();

  try {
    if (action === 'shape') {
      const agency = (req.query.agency || '').trim();
      return await handleRouteShape(res, routeId, agency);
    }

    // If a specific stop is requested, return frequency at that stop
    if (stopId) {
      return await handleStopFrequency(res, routeId, stopId);
    }

    return await handleRouteDetail(res, routeId);
  } catch (err) {
    console.error('Route API error:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Full route detail: all stops grouped by direction, first/last bus, avg frequency.
 */
async function handleRouteDetail(res, routeId) {
  const dayType = getDayType();

  // Get all stop_times for this route, ordered by trip + arrival
  const { data: stopTimes, error } = await supabase
    .from('stop_times')
    .select('stop_id, trip_id, arrival_time, headsign, service_id')
    .eq('route_id', routeId)
    .order('trip_id')
    .order('arrival_time')
    .limit(10000);

  if (error) throw new Error(error.message);
  if (!stopTimes || stopTimes.length === 0) {
    return res.json({ routeId, directions: [], frequency: null });
  }

  // Filter to current day type service IDs
  const dayFiltered = stopTimes.filter(st =>
    st.service_id && st.service_id.includes(dayType)
  );
  const rows = dayFiltered.length > 0 ? dayFiltered : stopTimes;

  // Group by headsign (direction)
  const byHeadsign = {};
  for (const st of rows) {
    const hs = st.headsign || 'Unknown';
    if (!byHeadsign[hs]) byHeadsign[hs] = { trips: {}, stops: new Map() };
    if (!byHeadsign[hs].trips[st.trip_id]) byHeadsign[hs].trips[st.trip_id] = [];
    byHeadsign[hs].trips[st.trip_id].push(st);
  }

  const directions = [];

  for (const [headsign, data] of Object.entries(byHeadsign)) {
    const tripIds = Object.keys(data.trips);

    // Extract ordered stop list from the first trip
    const sampleTrip = data.trips[tripIds[0]].sort((a, b) => timeToMins(a.arrival_time) - timeToMins(b.arrival_time));
    const stopList = sampleTrip.map(st => st.stop_id);

    // Compute first and last bus across all trips
    let firstBus = 9999;
    let lastBus = 0;
    const firstStopTimes = [];

    for (const tripId of tripIds) {
      const tripStops = data.trips[tripId];
      const sorted = tripStops.sort((a, b) => timeToMins(a.arrival_time) - timeToMins(b.arrival_time));
      if (sorted.length > 0) {
        const startMins = timeToMins(sorted[0].arrival_time);
        const endMins = timeToMins(sorted[sorted.length - 1].arrival_time);
        if (startMins < firstBus) firstBus = startMins;
        if (endMins > lastBus) lastBus = endMins;
        firstStopTimes.push(startMins);
      }
    }

    // Average frequency = average gap between consecutive trips at the first stop
    firstStopTimes.sort((a, b) => a - b);
    let avgFreqMin = null;
    if (firstStopTimes.length >= 2) {
      let totalGap = 0;
      for (let i = 1; i < firstStopTimes.length; i++) {
        totalGap += firstStopTimes[i] - firstStopTimes[i - 1];
      }
      avgFreqMin = Math.round(totalGap / (firstStopTimes.length - 1));
    }

    directions.push({
      headsign,
      tripCount: tripIds.length,
      stops: stopList,
      firstBus: minsToTime(firstBus),
      lastBus: minsToTime(lastBus),
      avgFrequencyMin: avgFreqMin,
    });
  }

  res.json({ routeId, directions });
}

/**
 * Frequency at a specific stop for a given route.
 * Returns average headway for the current time period (peak/off-peak).
 */
async function handleStopFrequency(res, routeId, stopId) {
  const dayType = getDayType();

  const { data, error } = await supabase
    .from('stop_times')
    .select('arrival_time, service_id')
    .eq('route_id', routeId)
    .eq('stop_id', stopId)
    .limit(500);

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    return res.json({ routeId, stopId, frequency: null });
  }

  // Filter to current day type
  const dayFiltered = data.filter(st => st.service_id && st.service_id.includes(dayType));
  const rows = dayFiltered.length > 0 ? dayFiltered : data;

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  // Get times within a 2-hour window around now
  const windowStart = nowMins - 60;
  const windowEnd = nowMins + 60;

  const times = rows
    .map(r => timeToMins(r.arrival_time))
    .filter(m => m >= windowStart && m <= windowEnd)
    .sort((a, b) => a - b);

  let frequencyMin = null;
  if (times.length >= 2) {
    let totalGap = 0;
    for (let i = 1; i < times.length; i++) {
      totalGap += times[i] - times[i - 1];
    }
    frequencyMin = Math.round(totalGap / (times.length - 1));
  }

  // Also get all-day frequency
  const allTimes = rows.map(r => timeToMins(r.arrival_time)).sort((a, b) => a - b);
  let allDayFreq = null;
  if (allTimes.length >= 2) {
    let totalGap = 0;
    for (let i = 1; i < allTimes.length; i++) {
      totalGap += allTimes[i] - allTimes[i - 1];
    }
    allDayFreq = Math.round(totalGap / (allTimes.length - 1));
  }

  res.json({
    routeId,
    stopId,
    frequency: {
      currentMin: frequencyMin,
      allDayMin: allDayFreq,
      tripsInWindow: times.length,
      totalTrips: allTimes.length,
    },
  });
}

/**
 * Snap stop coordinates to actual roads using OSRM.
 * OSRM has a ~100 waypoint limit per request, so chunk if needed.
 * Falls back to raw stop coordinates on failure.
 */
async function snapToRoads(stopCoords) {
  try {
    const CHUNK_SIZE = 100;
    const allPoints = [];

    for (let i = 0; i < stopCoords.length; i += CHUNK_SIZE - 1) {
      const chunk = stopCoords.slice(i, i + CHUNK_SIZE);
      if (chunk.length < 2) {
        allPoints.push(...chunk);
        continue;
      }

      // OSRM uses lon,lat order
      const coordStr = chunk.map(c => `${c.longitude},${c.latitude}`).join(';');
      const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) {
        console.log(`[shape] OSRM returned ${resp.status}, falling back to stops`);
        return stopCoords;
      }
      const data = await resp.json();

      const geom = data?.routes?.[0]?.geometry?.coordinates;
      if (!Array.isArray(geom) || geom.length === 0) {
        console.log('[shape] OSRM returned no geometry, falling back to stops');
        return stopCoords;
      }

      const snapped = geom.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));

      // Avoid duplicating the join point between chunks
      if (allPoints.length > 0 && snapped.length > 0) {
        snapped.shift();
      }
      allPoints.push(...snapped);
    }

    // If OSRM returned too few points, prefer raw stops
    if (allPoints.length < 5) {
      console.log(`[shape] OSRM returned only ${allPoints.length} points, falling back to stops`);
      return stopCoords;
    }
    return allPoints;
  } catch (err) {
    console.log('[shape] OSRM error:', err?.message || err);
    return stopCoords;
  }
}

/**
 * Route shape: fetch pattern stop coordinates from OTP.
 * OTP feed IDs: 1 = STO, 2 = OC Transpo.
 * Fetches all pattern details and picks the one with the most stops.
 */
async function handleRouteShape(res, routeId, agency) {
  const bareId = routeId.split('-')[0];
  const feedIds = agency === 'STO'
    ? [`1:${bareId}`, `2:${bareId}`]
    : [`2:${bareId}`, `1:${bareId}`];

  // Some OTP routes have compound IDs (e.g. 2:1-350 for route 1).
  // If direct lookup fails, search by shortName as fallback.
  let extraFeedIds = [];
  try {
    const allRoutesResp = await fetch(`${OTP_BASE}/otp/routers/default/index/routes`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000)
    });
    if (allRoutesResp.ok) {
      const allRoutes = await allRoutesResp.json();
      const matches = allRoutes.filter(r => r.shortName === bareId && !feedIds.includes(r.id));
      if (agency === 'STO') {
        // Prefer feed 1 (STO) first
        matches.sort((a, b) => (a.id.startsWith('1:') ? -1 : 1) - (b.id.startsWith('1:') ? -1 : 1));
      }
      extraFeedIds = matches.map(r => r.id);
      if (extraFeedIds.length > 0) {
        console.log(`[shape] found extra OTP IDs for route ${bareId}: ${extraFeedIds.join(', ')}`);
      }
    }
  } catch { /* ignore */ }

  const allFeedIds = [...feedIds, ...extraFeedIds];

  for (const fid of allFeedIds) {
    try {
      // Step 1: get pattern list
      const url = `${OTP_BASE}/otp/routers/default/index/routes/${encodeURIComponent(fid)}/patterns`;
      const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) {
        console.log(`[shape] OTP patterns for ${fid}: HTTP ${resp.status}`);
        continue;
      }
      const patterns = await resp.json();
      if (!Array.isArray(patterns) || patterns.length === 0) {
        console.log(`[shape] OTP returned 0 patterns for ${fid}`);
        continue;
      }
      console.log(`[shape] ${fid}: ${patterns.length} patterns found (${patterns.map(p => p.id).join(', ')})`);

      // Step 2: fetch ALL pattern details in parallel, pick the one with most stops
      const details = await Promise.all(
        patterns.map(async (p) => {
          try {
            const dUrl = `${OTP_BASE}/otp/routers/default/index/patterns/${encodeURIComponent(p.id)}`;
            const dResp = await fetch(dUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            if (!dResp.ok) return null;
            return await dResp.json();
          } catch { return null; }
        })
      );

      // Pick pattern with most stops
      let best = null;
      let bestStopCount = 0;
      for (const d of details) {
        if (!d) continue;
        const count = Array.isArray(d.stops) ? d.stops.length : 0;
        if (count > bestStopCount) { best = d; bestStopCount = count; }
      }

      if (!best) {
        console.log(`[shape] ${fid}: all pattern details failed`);
        continue;
      }
      console.log(`[shape] ${fid}: best pattern ${best.id} has ${bestStopCount} stops`);

      // Step 3: try encoded polyline geometry first
      const encoded = best?.patternGeometry?.points;
      if (encoded) {
        const shape = decodePolyline(encoded);
        if (shape.length > 0) {
          console.log(`[shape] ${fid}: using encoded polyline (${shape.length} points)`);
          return res.json({ routeId: bareId, shape });
        }
      }

      // Step 4: extract stop coordinates and snap to roads
      const stops = best.stops;
      if (Array.isArray(stops) && stops.length >= 2) {
        const stopCoords = stops
          .filter(s => s.lat && s.lon)
          .map(s => ({ latitude: s.lat, longitude: s.lon }));
        if (stopCoords.length >= 2) {
          console.log(`[shape] ${fid}: snapping ${stopCoords.length} stops via OSRM`);
          const snapped = await snapToRoads(stopCoords);
          console.log(`[shape] ${fid}: returning ${snapped.length} points (${snapped === stopCoords ? 'raw stops' : 'OSRM snapped'})`);
          return res.json({ routeId: bareId, shape: snapped });
        }
      }

      console.log(`[shape] ${fid}: pattern had no usable stops`);
    } catch (err) {
      console.log(`[shape] ${fid}: error:`, err?.message || err);
      continue;
    }
  }

  console.log(`[shape] ${bareId}: no shape found from any feed`);
  res.json({ routeId: bareId, shape: [] });
}
