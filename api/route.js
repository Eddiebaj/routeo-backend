/**
 * RouteO — Bus Route Detail
 * GET /api/route?id=95                — stops, directions, first/last bus
 * GET /api/route?id=95&stop=3017      — frequency at a specific stop
 * GET /api/route?id=95&action=shape   — route polyline shape from OTP
 *
 * All schedule data comes from OTP (no Supabase stop_times queries).
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

/** Convert Unix epoch seconds to "HH:MM" in Ottawa local time. */
function epochToHHMM(epochSecs) {
  return new Date(epochSecs * 1000).toLocaleTimeString('en-CA', {
    timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** Unix epoch seconds for midnight today in Ottawa (DST-safe). */
function ottawaMidnightEpoch() {
  const now = Math.floor(Date.now() / 1000);
  const ottawaTime = new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });
  const [h, m, s] = ottawaTime.split(':').map(Number);
  return now - (h * 3600 + m * 60 + (s || 0));
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
 * Uses OTP pattern + stoptimes APIs — no Supabase stop_times dependency.
 */
async function handleRouteDetail(res, routeId, agency) {
  const { patterns, bareId } = await resolveRoutePatterns(routeId, agency);
  if (!patterns.length) {
    return res.json({ routeId, directions: [], frequency: null });
  }

  const midnightEpoch = ottawaMidnightEpoch();

  // Fetch stoptimes at each pattern's first stop in parallel (full-day window)
  const patternData = await Promise.all(patterns.map(async (pattern) => {
    // OTP pattern headsign: try multiple field names across OTP versions
    const headsign = pattern.headsign || pattern.desc || pattern.name || `Route ${bareId}`;
    // Strip feed prefix from stop IDs ("2:3017" → "3017")
    const stops = (pattern.stops || []).map(s => String(s.id || '').split(':').pop());
    const tripCount = Array.isArray(pattern.trips) ? pattern.trips.length : 0;

    if (!pattern.stops?.length) return { headsign, stops, tripCount, departures: [] };

    const firstOtpStopId = pattern.stops[0].id; // e.g. "2:3017"
    let departures = [];

    try {
      const url =
        `${OTP_BASE}/otp/routers/default/index/stops/${encodeURIComponent(firstOtpStopId)}/stoptimes` +
        `?startTime=${midnightEpoch}&timeRange=86400&numberOfDepartures=200&omitNonPickups=true`;
      const stResp = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (stResp.ok) {
        const stData = await stResp.json();
        const entry = Array.isArray(stData)
          ? (stData.find(e => e.pattern?.id === pattern.id) || null)
          : null;
        if (entry?.times) {
          departures = entry.times
            .map(t => (t.serviceDay || 0) + (t.scheduledDeparture ?? t.scheduledArrival ?? 0))
            .filter(t => t > 0)
            .sort((a, b) => a - b);
        }
      }
    } catch (e) {
      console.warn(`[route] stoptimes for pattern ${pattern.id} (stop ${firstOtpStopId}):`, e.message);
    }

    return { headsign, stops, tripCount, departures };
  }));

  // Group patterns by headsign: keep longest stop list, merge departures
  const byHeadsign = {};
  for (const pd of patternData) {
    const hs = pd.headsign;
    if (!byHeadsign[hs]) {
      byHeadsign[hs] = { stops: pd.stops, tripCount: pd.tripCount, departures: [...pd.departures] };
    } else {
      if (pd.stops.length > byHeadsign[hs].stops.length) byHeadsign[hs].stops = pd.stops;
      byHeadsign[hs].tripCount += pd.tripCount;
      byHeadsign[hs].departures.push(...pd.departures);
    }
  }

  const directions = Object.entries(byHeadsign)
    .filter(([, data]) => data.stops.length > 0)
    .map(([headsign, data]) => {
      const deps = data.departures.sort((a, b) => a - b);
      const firstBus = deps.length > 0 ? epochToHHMM(deps[0]) : null;
      const lastBus  = deps.length > 0 ? epochToHHMM(deps[deps.length - 1]) : null;
      let avgFrequencyMin = null;
      if (deps.length >= 2) {
        avgFrequencyMin = Math.round((deps[deps.length - 1] - deps[0]) / 60 / (deps.length - 1));
      }
      return {
        headsign,
        tripCount: data.tripCount || deps.length,
        stops: data.stops,
        firstBus,
        lastBus,
        avgFrequencyMin,
      };
    });

  res.json({ routeId, directions });
}

/**
 * Frequency at a specific stop for a given route.
 * Uses OTP stoptimes API — no Supabase stop_times dependency.
 */
async function handleStopFrequency(res, routeId, stopId) {
  const bareRouteId = routeId.split('-')[0];
  const nowEpoch = Math.floor(Date.now() / 1000);
  const windowStart = nowEpoch - 3600;

  // Auto-detect agency from stop ID format: STO stops start with letters, OC stops are numeric
  const isSTO = /^[A-Za-z]/.test(String(stopId));
  const otpStopIds = isSTO ? [`1:${stopId}`, `2:${stopId}`] : [`2:${stopId}`, `1:${stopId}`];

  let allTimes = [];

  for (const otpStopId of otpStopIds) {
    try {
      const url =
        `${OTP_BASE}/otp/routers/default/index/stops/${encodeURIComponent(otpStopId)}/stoptimes` +
        `?startTime=${windowStart}&timeRange=7200&numberOfDepartures=50&omitNonPickups=true`;
      const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) continue;
      const data = await resp.json();

      for (const entry of (Array.isArray(data) ? data : [])) {
        if ((entry.pattern?.route?.shortName || '') !== bareRouteId) continue;
        for (const t of (entry.times || [])) {
          const epoch = (t.serviceDay || 0) + (t.scheduledDeparture ?? t.scheduledArrival ?? 0);
          if (epoch > 0) allTimes.push(epoch);
        }
      }
      if (allTimes.length > 0) break;
    } catch (e) {
      console.warn(`[route] stoptimes for stop ${otpStopId}:`, e.message);
    }
  }

  if (!allTimes.length) {
    return res.json({ routeId, stopId, frequency: null });
  }

  allTimes.sort((a, b) => a - b);
  const windowTimes = allTimes.filter(t => t >= windowStart && t <= nowEpoch + 3600);

  let frequencyMin = null;
  if (windowTimes.length >= 2) {
    frequencyMin = Math.round((windowTimes[windowTimes.length - 1] - windowTimes[0]) / 60 / (windowTimes.length - 1));
  }

  let allDayFreq = null;
  if (allTimes.length >= 2) {
    allDayFreq = Math.round((allTimes[allTimes.length - 1] - allTimes[0]) / 60 / (allTimes.length - 1));
  }

  res.json({
    routeId,
    stopId,
    frequency: {
      currentMin: frequencyMin,
      allDayMin: allDayFreq,
      tripsInWindow: windowTimes.length,
      totalTrips: allTimes.length,
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
