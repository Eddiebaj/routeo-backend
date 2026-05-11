/**
 * RouteO — Bus Route Detail
 * GET /api/route?id=95                — stops, directions, first/last bus
 * GET /api/route?id=95&stop=3017      — frequency at a specific stop
 * GET /api/route?id=95&action=shape   — route polyline shape from OTP
 *
 * All schedule data comes from OTP (no Supabase stop_times queries).
 * Uses /trips/{id}/stoptimes instead of /stops/{id}/stoptimes so that
 * first/last bus and frequency work even when OTP's GTFS calendar has expired.
 */

const { checkRateLimit } = require('./_rateLimit');
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

/**
 * Convert seconds-from-midnight (GTFS convention) to "HH:MM" string.
 * Handles after-midnight trips (values > 86400) by wrapping to 0-23.
 */
function secsToHHMM(secs) {
  const totalMins = Math.floor(secs / 60);
  const h = Math.floor(totalMins / 60) % 24;
  const m = totalMins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Fetch /trips/{tripId}/stoptimes and return the scheduledDeparture
 * at stop index `stopIndex` (0 = first stop of trip).
 * Returns null on failure. Does not filter by calendar date.
 */
async function fetchTripDeparture(tripId, stopIndex) {
  try {
    const r = await fetch(
      `${OTP_BASE}/otp/routers/default/index/trips/${encodeURIComponent(tripId)}/stoptimes`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const st = await r.json();
    if (!Array.isArray(st) || st.length <= stopIndex) return null;
    return st[stopIndex].scheduledDeparture ?? null;
  } catch { return null; }
}

/**
 * Resolve all OTP pattern details for a route.
 * Returns { patterns, feedId, bareId } where each pattern has
 * { id, headsign/desc, stops[], trips[], patternGeometry }.
 * Tries OC feed (2) first then STO (1), unless agency='STO'.
 * Stops at the first feedId that yields valid patterns.
 */
async function resolveRoutePatterns(routeId, agency) {
  const bareId = routeId.split('-')[0];
  const feedIds = agency === 'STO'
    ? [`1:${bareId}`, `2:${bareId}`]
    : [`2:${bareId}`, `1:${bareId}`];

  // Discover extra OTP route IDs by shortName (handles compound IDs like "2:1-350")
  let extraFeedIds = [];
  try {
    const allRoutesResp = await fetch(`${OTP_BASE}/otp/routers/default/index/routes`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
    if (allRoutesResp.ok) {
      const allRoutes = await allRoutesResp.json();
      const matches = allRoutes.filter(r => r.shortName === bareId && !feedIds.includes(r.id));
      if (agency === 'STO') {
        matches.sort((a, b) => (a.id.startsWith('1:') ? -1 : 1) - (b.id.startsWith('1:') ? -1 : 1));
      }
      extraFeedIds = matches.map(r => r.id);
      if (extraFeedIds.length > 0) {
        console.log(`[route] extra OTP IDs for ${bareId}: ${extraFeedIds.join(', ')}`);
      }
    }
  } catch (e) {
    console.warn('[route] route list lookup failed:', e.message);
  }

  for (const fid of [...feedIds, ...extraFeedIds]) {
    try {
      const pResp = await fetch(
        `${OTP_BASE}/otp/routers/default/index/routes/${encodeURIComponent(fid)}/patterns`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
      );
      if (!pResp.ok) { console.log(`[route] patterns for ${fid}: HTTP ${pResp.status}`); continue; }

      const patternList = await pResp.json();
      if (!Array.isArray(patternList) || patternList.length === 0) {
        console.log(`[route] 0 patterns for ${fid}`);
        continue;
      }
      console.log(`[route] ${fid}: ${patternList.length} patterns`);

      // Fetch all pattern details in parallel
      const details = await Promise.all(patternList.map(async (p) => {
        try {
          const dResp = await fetch(
            `${OTP_BASE}/otp/routers/default/index/patterns/${encodeURIComponent(p.id)}`,
            { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
          );
          if (!dResp.ok) return null;
          return await dResp.json();
        } catch { return null; }
      }));

      const valid = details.filter(d => d && Array.isArray(d.stops) && d.stops.length >= 2);
      if (valid.length > 0) {
        console.log(`[route] ${fid}: ${valid.length} valid patterns`);
        return { patterns: valid, feedId: fid, bareId };
      }
    } catch (e) {
      console.warn(`[route] ${fid} error:`, e.message);
    }
  }

  console.log(`[route] no patterns found for ${bareId}`);
  return { patterns: [], feedId: null, bareId };
}

module.exports = async (req, res) => {
  if (await checkRateLimit(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600');

  const routeId = (req.query.id || '').trim();
  if (!routeId) return res.status(400).json({ error: 'Missing id param' });

  const stopId = (req.query.stop || '').trim();
  const action = (req.query.action || '').trim();
  const agency = (req.query.agency || '').trim();

  try {
    if (action === 'shape') {
      return await handleRouteShape(res, routeId, agency);
    }
    if (stopId) {
      return await handleStopFrequency(res, routeId, stopId);
    }
    return await handleRouteDetail(res, routeId, agency);
  } catch (err) {
    console.error('Route API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Full route detail: all stops grouped by direction, first/last bus, avg frequency.
 *
 * For first/last bus and frequency: fetches /trips/{id}/stoptimes for the first
 * and last trip in each pattern. These calls return times regardless of GTFS
 * calendar expiry. Frequency is estimated as span / (tripCount - 1).
 */
async function handleRouteDetail(res, routeId, agency) {
  const { patterns, bareId } = await resolveRoutePatterns(routeId, agency);
  if (!patterns.length) {
    return res.json({ routeId, directions: [], frequency: null });
  }

  // For each pattern, compute direction info in parallel
  const patternData = await Promise.all(patterns.map(async (pattern) => {
    const headsign = pattern.headsign || pattern.desc || pattern.name || `Route ${bareId}`;
    const stops = (pattern.stops || []).map(s => String(s.id || '').split(':').pop());
    const trips = Array.isArray(pattern.trips) ? pattern.trips : [];
    const tripCount = trips.length;

    let firstBus = null, lastBus = null, avgFrequencyMin = null;

    if (trips.length >= 1) {
      // OTP does not sort pattern.trips by departure time, so we must sample
      // across the full array to find the actual first/last of the day.
      // Cap at 20 evenly-spaced trips; frequency = span / (totalTripCount - 1).
      const MAX_SAMPLE = 20;
      const sampleTrips = trips.length <= MAX_SAMPLE
        ? trips
        : Array.from({ length: MAX_SAMPLE }, (_, i) =>
            trips[Math.round(i * (trips.length - 1) / (MAX_SAMPLE - 1))]
          );

      const departures = (await Promise.all(
        sampleTrips.map(t => fetchTripDeparture(t.id, 0))
      )).filter(t => t != null && t >= 0).sort((a, b) => a - b);

      if (departures.length > 0) {
        firstBus = secsToHHMM(departures[0]);
        lastBus  = secsToHHMM(departures[departures.length - 1]);
        if (departures.length >= 2 && tripCount >= 2) {
          // Use true span / actualTripCount for accurate average headway
          const span = departures[departures.length - 1] - departures[0];
          avgFrequencyMin = Math.round(span / 60 / (tripCount - 1));
        }
      }
    }

    return { headsign, stops, tripCount, firstBus, lastBus, avgFrequencyMin };
  }));

  // Group patterns by headsign: keep longest stop list, sum trip counts
  const byHeadsign = {};
  for (const pd of patternData) {
    const hs = pd.headsign;
    if (!byHeadsign[hs]) {
      byHeadsign[hs] = { ...pd };
    } else {
      if (pd.stops.length > byHeadsign[hs].stops.length) byHeadsign[hs].stops = pd.stops;
      byHeadsign[hs].tripCount += pd.tripCount;
      // Take the earlier firstBus and later lastBus across variants
      if (pd.firstBus && (!byHeadsign[hs].firstBus || pd.firstBus < byHeadsign[hs].firstBus)) {
        byHeadsign[hs].firstBus = pd.firstBus;
      }
      if (pd.lastBus && (!byHeadsign[hs].lastBus || pd.lastBus > byHeadsign[hs].lastBus)) {
        byHeadsign[hs].lastBus = pd.lastBus;
      }
      // Average the frequency estimates
      if (pd.avgFrequencyMin && byHeadsign[hs].avgFrequencyMin) {
        byHeadsign[hs].avgFrequencyMin = Math.round(
          (byHeadsign[hs].avgFrequencyMin + pd.avgFrequencyMin) / 2
        );
      }
    }
  }

  const directions = Object.values(byHeadsign).filter(d => d.stops.length > 0);
  res.json({ routeId, directions });
}

/**
 * Frequency at a specific stop for a given route.
 *
 * Resolves patterns for the route, finds patterns that serve the stop,
 * then fetches /trips/{id}/stoptimes for first + last trip to get departure
 * times at the stop. Computes window frequency (±1h around now) and all-day
 * frequency using trip count and span. Works regardless of GTFS calendar expiry.
 */
async function handleStopFrequency(res, routeId, stopId) {
  const bareRouteId = routeId.split('-')[0];

  // Current Ottawa time as seconds from midnight (for window filtering)
  const ottawaTime = new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });
  const [h, m, s] = ottawaTime.split(':').map(Number);
  const nowSecs = h * 3600 + m * 60 + (s || 0);

  // Auto-detect agency from stop ID: STO stops start with letters, OC stops are numeric
  const isSTO = /^[A-Za-z]/.test(String(stopId));
  const { patterns } = await resolveRoutePatterns(routeId, isSTO ? 'STO' : '');

  if (!patterns.length) return res.json({ routeId, stopId, frequency: null });

  // Find patterns that serve this stop (match by stripped stop code)
  const stopCode = String(stopId);
  const matchingPatterns = patterns.filter(p =>
    Array.isArray(p.stops) && p.stops.some(s => s.id.split(':').pop() === stopCode)
  );

  if (!matchingPatterns.length) return res.json({ routeId, stopId, frequency: null });

  let allSpanFirsts = []; // first-departure seconds at this stop per pattern
  let allSpanLasts  = []; // last-departure seconds at this stop per pattern
  let totalTrips = 0;

  for (const pattern of matchingPatterns) {
    const trips = Array.isArray(pattern.trips) ? pattern.trips : [];
    if (!trips.length) continue;

    // Find this stop's index in the pattern stop sequence
    const stopIndex = pattern.stops.findIndex(s => s.id.split(':').pop() === stopCode);
    if (stopIndex < 0) continue;

    // Sample up to 20 evenly-spaced trips to find actual first/last departure
    const MAX_SAMPLE = 20;
    const sampleTrips = trips.length <= MAX_SAMPLE
      ? trips
      : Array.from({ length: MAX_SAMPLE }, (_, i) =>
          trips[Math.round(i * (trips.length - 1) / (MAX_SAMPLE - 1))]
        );

    const departures = (await Promise.all(
      sampleTrips.map(t => fetchTripDeparture(t.id, stopIndex))
    )).filter(t => t != null && t >= 0).sort((a, b) => a - b);

    if (departures.length > 0) {
      allSpanFirsts.push(departures[0]);
      allSpanLasts.push(departures[departures.length - 1]);
      totalTrips += trips.length;
    }
  }

  if (!allSpanFirsts.length) return res.json({ routeId, stopId, frequency: null });

  const spanFirst = Math.min(...allSpanFirsts);
  const spanLast  = Math.max(...allSpanLasts);

  // All-day frequency: span divided by total trips across all matching patterns
  let allDayFreq = null;
  if (totalTrips >= 2) {
    allDayFreq = Math.round((spanLast - spanFirst) / 60 / (totalTrips - 1));
  }

  // Current-window frequency: if now falls within the service span, use all-day estimate
  // (exact per-trip window data would require fetching all trips, not just first/last)
  let frequencyMin = null;
  const inServiceNow = nowSecs >= spanFirst && nowSecs <= spanLast;
  if (inServiceNow && allDayFreq !== null) {
    frequencyMin = allDayFreq;
  }

  res.json({
    routeId,
    stopId,
    frequency: {
      currentMin: frequencyMin,
      allDayMin: allDayFreq,
      tripsInWindow: inServiceNow ? 1 : 0, // approximate
      totalTrips,
    },
  });
}

/**
 * Snap stop coordinates to actual roads using OSRM.
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
      if (allPoints.length > 0 && snapped.length > 0) snapped.shift();
      allPoints.push(...snapped);
    }

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
 * Route shape: polyline for rendering on the map.
 * Uses resolveRoutePatterns and picks the pattern with the most stops.
 */
async function handleRouteShape(res, routeId, agency) {
  const { patterns, bareId } = await resolveRoutePatterns(routeId, agency);

  if (!patterns.length) {
    console.log(`[shape] ${routeId}: no patterns found`);
    return res.json({ routeId: bareId, shape: [] });
  }

  // Pick the pattern with the most stops
  let best = null;
  let bestCount = 0;
  for (const p of patterns) {
    const count = Array.isArray(p.stops) ? p.stops.length : 0;
    if (count > bestCount) { best = p; bestCount = count; }
  }

  if (!best) return res.json({ routeId: bareId, shape: [] });

  console.log(`[shape] ${bareId}: best pattern ${best.id} has ${bestCount} stops`);

  // Try encoded polyline geometry first
  const encoded = best?.patternGeometry?.points;
  if (encoded) {
    const shape = decodePolyline(encoded);
    if (shape.length > 0) {
      console.log(`[shape] ${bareId}: using encoded polyline (${shape.length} points)`);
      return res.json({ routeId: bareId, shape });
    }
  }

  // Fall back to stop coordinates + OSRM road snapping
  if (Array.isArray(best.stops) && best.stops.length >= 2) {
    const stopCoords = best.stops
      .filter(s => s.lat && s.lon)
      .map(s => ({ latitude: s.lat, longitude: s.lon }));
    if (stopCoords.length >= 2) {
      console.log(`[shape] ${bareId}: snapping ${stopCoords.length} stops via OSRM`);
      const snapped = await snapToRoads(stopCoords);
      console.log(`[shape] ${bareId}: returning ${snapped.length} points (${snapped === stopCoords ? 'raw stops' : 'OSRM snapped'})`);
      return res.json({ routeId: bareId, shape: snapped });
    }
  }

  console.log(`[shape] ${bareId}: no usable geometry`);
  res.json({ routeId: bareId, shape: [] });
}
