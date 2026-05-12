const { checkRateLimit } = require('./_rateLimit');
const { buildStoUrl } = require('./_sto');

const { createClient } = require('@supabase/supabase-js');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Service role client — only used for safety signal aggregation
const supabaseAdmin = process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const OC_KEY = process.env.OC_TRANSPO_API_KEY;   // VehiclePositions
const OC_TU_KEY = process.env.OC_TRANSPO_TU_KEY; // TripUpdates (separate product)

const GTFS_RT_URL = 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates?format=json';

// Module-level cache for OC Transpo GTFS-RT feed (shared across concurrent requests)
let rtCache = { data: null, ts: 0 };
const RT_TTL = 30000; // 30 seconds

// ── Per-stop stale cache — serves last good arrivals on GTFS-RT failure ──────
// { [stopId]: { arrivals: [...], ts: number } }
const arrivalsStaleCache = new Map();
const STALE_TTL = 2 * 60 * 1000; // 2 minutes

function saveStaleCache(stopId, arrivals) {
  if (arrivals && arrivals.length > 0) {
    arrivalsStaleCache.set(stopId, { arrivals, ts: Date.now() });
  }
}

function getStaleCache(stopId) {
  const entry = arrivalsStaleCache.get(stopId);
  if (!entry) return null;
  const ageMs = Date.now() - entry.ts;
  if (ageMs > STALE_TTL) { arrivalsStaleCache.delete(stopId); return null; }
  return { arrivals: entry.arrivals, staleAgeSeconds: Math.round(ageMs / 1000) };
}

// ── Ghost bus detection: track previous arrivals per stop ──────
// { [stopId]: { arrivals: [{routeId, tripId, minsAway}], ts: timestamp } }
const prevArrivalsCache = {};
const PREV_CACHE_TTL = 300000; // 5 minutes — aligned with ghost detection window (minsAway <= 5)
const PREV_CACHE_MAX = 500; // max stops tracked — prune oldest beyond this

function pruneArrivalsCache() {
  const keys = Object.keys(prevArrivalsCache);
  if (keys.length <= PREV_CACHE_MAX) return;
  const now = Date.now();
  // First pass: remove expired entries
  for (const k of keys) {
    if (now - prevArrivalsCache[k].ts > PREV_CACHE_TTL) delete prevArrivalsCache[k];
  }
  // Second pass: if still over limit, remove oldest
  const remaining = Object.keys(prevArrivalsCache);
  if (remaining.length > PREV_CACHE_MAX) {
    remaining.sort((a, b) => prevArrivalsCache[a].ts - prevArrivalsCache[b].ts);
    for (let i = 0; i < remaining.length - PREV_CACHE_MAX; i++) {
      delete prevArrivalsCache[remaining[i]];
    }
  }
}


// MULTI_PLATFORM_STOPS cleared — OC Transpo renumbered all internal stop IDs.
// Stop routing (OC vs STO) is now handled by resolveStopAgency() via Supabase.
const MULTI_PLATFORM_STOPS = {};

// ── OC stop_code → stop_id[] resolver (Supabase-backed, 24h cache) ──
// OC Transpo renumbered internal stop IDs; users pass stop_codes (e.g. "3000")
// but the GTFS-RT feed uses stop_id (e.g. "3585", "9449"). Look up the mapping.
const ocStopCodeCache = {}; // { [stop_code]: { ids: string[], ts: number } }
const OC_STOP_CODE_TTL = 24 * 60 * 60 * 1000;

async function resolveOCStopIds(stopCode) {
  const hit = ocStopCodeCache[stopCode];
  if (hit && Date.now() - hit.ts < OC_STOP_CODE_TTL) return hit.ids;
  try {
    const { data } = await supabase
      .from('stops')
      .select('stop_id')
      .eq('stop_code', stopCode)
      .eq('agency', 'OC');
    const ids = (data || []).map(r => String(r.stop_id)).filter(Boolean);
    const result = ids.length > 0 ? ids : [stopCode];
    ocStopCodeCache[stopCode] = { ids: result, ts: Date.now() };
    return result;
  } catch {
    return [stopCode];
  }
}

// ── Stop agency resolver (Supabase-backed, 24h cache) ──────────
// Determines whether a stop is OC or STO via the agency column.
// Falls back to letter-prefix heuristic if Supabase is unavailable.
const stopAgencyCache = {}; // { [stopCode]: { agency: string, ts: number } }

async function resolveStopAgency(stopCode) {
  const hit = stopAgencyCache[stopCode];
  if (hit && Date.now() - hit.ts < OC_STOP_CODE_TTL) return hit.agency;
  try {
    const { data } = await supabase
      .from('stops')
      .select('agency')
      .or(`stop_code.eq.${stopCode},stop_id.eq.${stopCode}`)
      .limit(1)
      .maybeSingle();
    const agency = data?.agency ?? (/^[A-Za-z]/.test(String(stopCode)) ? 'STO' : 'OC');
    stopAgencyCache[stopCode] = { agency, ts: Date.now() };
    return agency;
  } catch {
    return /^[A-Za-z]/.test(String(stopCode)) ? 'STO' : 'OC';
  }
}

function cleanHeadsign(headsign, routeId) {
  if (!headsign || headsign.trim() === '') return `Route ${routeId}`;
  const cleaned = headsign.replace(/^\d+\s*[-–]\s*/, '').trim();
  return cleaned || `Route ${routeId}`;
}

// ── Fetch OC Transpo GTFS-RT feed (cached) ─────────────────────
async function fetchGtfsRtData() {
  if (rtCache.data && Date.now() - rtCache.ts < RT_TTL) {
    return rtCache.data;
  }
  const resp = await fetch(GTFS_RT_URL, {
    headers: { 'Ocp-Apim-Subscription-Key': OC_TU_KEY },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`GTFS-RT ${resp.status}`);
  const data = await resp.json();
  const entities = data?.Entity || [];
  // Only cache if response has actual trip updates — don't poison cache with empty/truncated feeds
  if (entities.length > 0) {
    rtCache = { data, ts: Date.now() };
  }
  return data;
}

// ── Fetch OC Transpo GTFS-RT live predictions ──────────────────
async function fetchRealtime(stopId) {
  if (!OC_TU_KEY) { console.warn('OC_TRANSPO_TU_KEY not set'); return []; }
  const stopIds = await resolveOCStopIds(stopId);
  const stopSet = new Set(stopIds);

  const data = await fetchGtfsRtData();

  const now = Math.floor(Date.now() / 1000);
  const results = [];

  for (const ent of (data?.Entity || [])) {
    const tu = ent.TripUpdate;
    if (!tu) continue;
    for (const stu of (tu.StopTimeUpdate || [])) {
      if (!stopSet.has(String(stu.StopId))) continue;
      const arr = stu.Arrival || stu.Departure || {};
      const t = parseInt(arr.Time || 0);
      if (!t) continue;
      const secsAway = t - now;
      if (secsAway < -600 || secsAway > 5400) continue;
      const trip = tu.Trip || {};
      const entry = {
        stopId,
        routeId: trip.RouteId || '?',
        tripId: String(trip.TripId || ''),
        headsign: '',
        minsAway: Math.max(0, Math.round(secsAway / 60)),
        arrivalTime: t,
        departureTime: parseInt((stu.Departure || {}).Time || 0) || t,
        scheduleRelationship: stu.ScheduleRelationship || 'SCHEDULED',
        agency: 'OC',
      };
      if (secsAway < 0) {
        entry.minutesLate = Math.abs(Math.round(secsAway / 60));
        if (entry.minutesLate >= 4) entry.possiblyLate = true;
      }
      results.push(entry);
    }
  }

  results.sort((a, b) => a.minsAway - b.minsAway);
  const unique = [];
  const seen = new Set();
  for (const r of results) {
    const key = `${r.routeId}-${r.tripId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
    if (unique.length >= 8) break;
  }

  if (unique.length > 0) {
    const tripIds = [...new Set(unique.map(r => r.tripId).filter(Boolean))];
    if (tripIds.length > 0) {
      try {
        const { data: tripData } = await supabase
          .from('trips')
          .select('trip_id, headsign, route_id')
          .in('trip_id', tripIds);
        const tripsMap = {};
        if (tripData) for (const t of tripData) tripsMap[t.trip_id] = t;
        for (const r of unique) {
          const trip = tripsMap[r.tripId];
          if (trip) r.headsign = cleanHeadsign(trip.headsign, r.routeId);
          else r.headsign = `Route ${r.routeId}`;
        }
      } catch {
        for (const r of unique) r.headsign = `Route ${r.routeId}`;
      }
    }
  }

  return unique;
}

// ── Fetch STO GTFS-RT live predictions ────────────────────────
async function fetchSTORealtime(stopId) {
  const stoUrl = buildStoUrl('trip');
  if (!stoUrl) {
    console.warn('STO keys not configured, skipping realtime');
    return [];
  }
  const resp = await fetch(stoUrl, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`STO GTFS-RT ${resp.status}`);

  const buffer = await resp.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
  const now = Math.floor(Date.now() / 1000);
  const results = [];

  for (const entity of (feed.entity || [])) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    for (const stu of (tu.stopTimeUpdate || [])) {
      if (String(stu.stopId) !== String(stopId)) continue;
      const arr = stu.arrival || stu.departure || {};
      const t = arr.time ? Number(arr.time) : 0;
      if (!t) continue;
      const secsAway = t - now;
      if (secsAway < -600 || secsAway > 5400) continue;
      const trip = tu.trip || {};
      const tripId = String(trip.tripId || '');
      const routeId = trip.routeId || '?';
      // Use vehicle label directly if available, Supabase lookup fills the rest
      const headsign = tu.vehicle?.label ? cleanHeadsign(tu.vehicle.label, routeId) : '';
      const stoEntry = { stopId, routeId, tripId, headsign, minsAway: Math.max(0, Math.round(secsAway / 60)), arrivalTime: t, departureTime: t, scheduleRelationship: 'SCHEDULED', agency: 'STO' };
      if (secsAway < 0) {
        stoEntry.minutesLate = Math.abs(Math.round(secsAway / 60));
        if (stoEntry.minutesLate >= 4) stoEntry.possiblyLate = true;
      }
      results.push(stoEntry);
    }
  }

  results.sort((a, b) => a.minsAway - b.minsAway);
  const unique = [];
  const seen = new Set();
  for (const r of results) {
    const key = `${r.routeId}-${r.tripId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
    if (unique.length >= 8) break;
  }

  // Fill missing headsigns from Supabase trips table (replaces zip download)
  const needsHeadsign = unique.filter(r => !r.headsign);
  if (needsHeadsign.length > 0) {
    const tripIds = [...new Set(needsHeadsign.map(r => r.tripId).filter(Boolean))];
    if (tripIds.length > 0) {
      try {
        const { data: tripData } = await supabase.from('trips').select('trip_id, headsign').in('trip_id', tripIds);
        const lookup = {};
        if (tripData) for (const t of tripData) lookup[t.trip_id] = t.headsign;
        for (const r of needsHeadsign) {
          r.headsign = lookup[r.tripId] ? cleanHeadsign(lookup[r.tripId], r.routeId) : `Route ${r.routeId}`;
        }
      } catch {
        for (const r of needsHeadsign) r.headsign = `Route ${r.routeId}`;
      }
    }
  }
  for (const r of unique) { if (!r.headsign) r.headsign = `Route ${r.routeId}`; }

  return unique;
}

// ── Core per-stop logic (returns response object) ─────────
async function fetchArrivalsForStop(stopId, arrivalLimit = 8) {
  const isSTO = (await resolveStopAgency(stopId)) === 'STO';

  // Check GTFS data freshness (non-blocking)
  let dataWarning = null;
  const freshnessPromise = (async () => {
    try {
      const metaKey = isSTO ? 'sto_last_updated' : 'oc_last_updated';
      const { data: meta } = await supabase.from('gtfs_metadata').select('value').eq('key', metaKey).single();
      if (meta?.value) {
        const lastUpdated = new Date(meta.value);
        const hoursAgo = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60);
        if (hoursAgo > 48) dataWarning = 'Schedule data may be outdated';
      }
    } catch (e) { console.warn('Freshness check error:', e.message); }
  })();

  // Look up stop name (best-effort, non-blocking)
  let stopName = null;
  try {
    const { data: stopRow } = await supabase.from('stops').select('stop_name').eq('stop_id', stopId).single();
    if (stopRow) stopName = stopRow.stop_name;
    if (!stopName) {
      const platforms = await resolveOCStopIds(stopId);
      if (platforms.length > 1 || platforms[0] !== stopId) {
        const { data: platRows } = await supabase.from('stops').select('stop_name').in('stop_id', platforms).limit(1);
        if (platRows?.[0]) stopName = platRows[0].stop_name;
      }
    }
  } catch (e) { console.warn('Stop name lookup error:', e.message); }

  // Fetch route reliability stats in parallel (last 30 days)
  let reliability = {};
  const reliabilityPromise = (async () => {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const query = supabase
        .from('route_reliability')
        .select('route_id, delta_minutes')
        .eq('stop_id', stopId)
        .gte('created_at', thirtyDaysAgo)
        .limit(2000)
        .abortSignal(AbortSignal.timeout(4000));
      const { data, error } = await query;
      if (error || !data || data.length === 0) return;
      const grouped = {};
      for (const row of data) {
        if (!grouped[row.route_id]) grouped[row.route_id] = { onTime: 0, total: 0, totalDelay: 0 };
        grouped[row.route_id].total++;
        grouped[row.route_id].totalDelay += (row.delta_minutes || 0);
        if (Math.abs(row.delta_minutes || 0) <= 3) grouped[row.route_id].onTime++;
      }
      for (const [routeId, stats] of Object.entries(grouped)) {
        if (stats.total >= 5) {
          reliability[routeId] = {
            onTimePercent: Math.round((stats.onTime / stats.total) * 100),
            avgDelay: +(stats.totalDelay / stats.total).toFixed(1),
            sampleSize: stats.total,
          };
        }
      }
    } catch (e) { console.warn('reliability query failed:', e.message); }
  })();

  // Fetch safety signal in parallel (service role, night hours only)
  let safetySignal = false;
  const safetyPromise = (async () => {
    if (!supabaseAdmin) return;
    const hour = new Date().getHours();
    const isNight = hour >= 20 || hour < 6;
    if (!isNight) return;
    try {
      const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabaseAdmin
        .from('stop_safety_reports')
        .select('id')
        .eq('stop_id', stopId)
        .gte('created_at', eightHoursAgo)
        .limit(2);
      if (!error && data && data.length >= 2) safetySignal = true;
    } catch (e) { console.warn('safety signal query failed:', e.message); }
  })();

  // Fetch ghost reports in parallel
  let ghostReports = {};
  const ghostPromise = (async () => {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from('stop_reports')
        .select('route_id, category, device_id')
        .eq('stop_id', stopId)
        .gte('created_at', oneHourAgo);
      const byRoute = {};
      for (const row of (data || [])) {
        if (!row.route_id) continue;
        if (!byRoute[row.route_id]) byRoute[row.route_id] = { ghost: 0, confirmed: 0, devices: new Set() };
        if (row.category === 'confirmed_arrived') {
          byRoute[row.route_id].confirmed++;
        } else {
          byRoute[row.route_id].ghost++;
          byRoute[row.route_id].devices.add(row.device_id);
        }
      }
      for (const [rid, d] of Object.entries(byRoute)) {
        const netScore = d.ghost - (d.confirmed * 2);
        ghostReports[rid] = { total: d.ghost, uniqueDevices: d.devices.size, confirmedCount: d.confirmed, netScore, likelyGhost: netScore >= 3 };
      }
    } catch (e) { console.warn('ghost aggregation failed:', e.message); }
  })();

  // Assign confidence level to each arrival based on source + rider verification
  const assignConfidence = (arrivals) => {
    // Count confirmed_arrived reports across all routes at this stop
    let totalConfirmed = 0;
    for (const rid of Object.keys(ghostReports)) {
      totalConfirmed += (ghostReports[rid].confirmedCount || 0);
    }
    const riderVerified = totalConfirmed >= 2;

    for (const a of arrivals) {
      if (riderVerified) {
        a.confidence = 'rider-verified';
      } else if ((a.source === 'gtfs-rt' || a.source === 'sto-gtfs-rt') && rtCache.data && (Date.now() - rtCache.ts) < 60000) {
        a.confidence = 'live';
      } else {
        a.confidence = 'scheduled';
      }
    }
    return arrivals;
  };

  const buildResp = (base) => {
    if (dataWarning) base.dataWarning = dataWarning;
    if (Object.keys(reliability).length > 0) base.reliability = reliability;
    if (safetySignal) base.safetySignal = true;
    assignConfidence(base.arrivals || []);
    // Persist good arrivals for stale fallback (only when not already stale)
    if (!base.stale) saveStaleCache(stopId, base.arrivals);
    // Apply per-user departure cap (free: 2, premium: 20)
    if (Array.isArray(base.arrivals) && base.arrivals.length > arrivalLimit) {
      base.arrivals = base.arrivals.slice(0, arrivalLimit);
    }

    // Ghost bus auto-detection: compare current arrivals to previous snapshot
    const prev = prevArrivalsCache[stopId];
    if (prev && (Date.now() - prev.ts) < PREV_CACHE_TTL) {
      const currentTripIds = new Set((base.arrivals || []).map(a => a.tripId).filter(Boolean));
      const vanished = prev.arrivals.filter(
        p => p.minsAway <= 5 && p.tripId && !currentTripIds.has(p.tripId)
      );
      if (vanished.length > 0) {
        // Find the best next alternative (different route from the vanished one)
        const vanishedRoutes = new Set(vanished.map(v => v.routeId));
        const nextAlt = (base.arrivals || []).find(a => !vanishedRoutes.has(a.routeId));
        base.ghostAlert = {
          vanishedRoutes: vanished.map(v => ({ routeId: v.routeId, tripId: v.tripId, prevMinsAway: v.minsAway })),
          nextAlternative: nextAlt ? { routeId: nextAlt.routeId, minsAway: nextAlt.minsAway, headsign: nextAlt.headsign } : null,
        };
      }
    }
    // Snapshot current arrivals for next comparison
    prevArrivalsCache[stopId] = {
      arrivals: (base.arrivals || []).map(a => ({ routeId: a.routeId, tripId: a.tripId, minsAway: a.minsAway })),
      ts: Date.now(),
    };
    pruneArrivalsCache();

    return base;
  };

  // ── STO stop flow ──────────────────────────────────────────
  if (isSTO) {
    try {
      const stoArrivals = await fetchSTORealtime(stopId);
      if (stoArrivals.length > 0) {
        await Promise.all([ghostPromise, freshnessPromise, reliabilityPromise, safetyPromise]);
        const arrivals = stoArrivals.map(a => ({ ...a, source: 'sto-gtfs-rt' }));
        return buildResp({ stop: stopId, stopName, arrivals, source: 'sto-gtfs-rt', agency: 'STO', ghostReports });
      }
      // STO GTFS-RT empty
    } catch (err) {
      console.warn(`[arrivals] STO GTFS-RT failed for stop ${stopId}:`, err.message);
      const stale = getStaleCache(stopId);
      if (stale) {
        await Promise.all([ghostPromise, freshnessPromise, reliabilityPromise, safetyPromise]);
        return buildResp({ stop: stopId, stopName, arrivals: stale.arrivals, source: 'stale', agency: 'STO', ghostReports, stale: true, staleAgeSeconds: stale.staleAgeSeconds });
      }
    }
    await Promise.all([ghostPromise, freshnessPromise, reliabilityPromise, safetyPromise]);
    return buildResp({ stop: stopId, stopName, arrivals: [], source: 'sto-gtfs-rt-empty', agency: 'STO', ghostReports });
  }

  // ── OC Transpo stop flow ───────────────────────────────────
  // Skip realtime entirely if API key is missing — go straight to static
  if (OC_TU_KEY) {
    try {
      const rtArrivals = await fetchRealtime(stopId);
      if (rtArrivals.length > 0) {
        await Promise.all([ghostPromise, freshnessPromise, reliabilityPromise, safetyPromise]);
        const arrivals = rtArrivals.map(a => ({ ...a, source: 'gtfs-rt' }));
        return buildResp({ stop: stopId, stopName, arrivals, source: 'gtfs-rt', ghostReports });
      }
      // OC GTFS-RT empty
    } catch (err) {
      console.warn(`[arrivals] GTFS-RT failed for stop ${stopId}:`, err.message);
      const stale = getStaleCache(stopId);
      if (stale) {
        await Promise.all([ghostPromise, freshnessPromise, reliabilityPromise, safetyPromise]);
        return buildResp({ stop: stopId, stopName, arrivals: stale.arrivals, source: 'stale', agency: 'OC', ghostReports, stale: true, staleAgeSeconds: stale.staleAgeSeconds });
      }
    }
  } else {
    console.warn(`[arrivals] OC_TRANSPO_TU_KEY not set, skipping realtime for stop ${stopId}`);
  }

  await Promise.all([ghostPromise, freshnessPromise, reliabilityPromise, safetyPromise]);
  return buildResp({ stop: stopId, stopName, arrivals: [], source: 'gtfs-rt-empty', ghostReports });
}

// ── Fire-and-forget request logging ───────────────────────
function logRequest(stopId, source, latencyMs) {
  supabase
    .from('api_logs')
    .insert({ endpoint: 'arrivals', stop_id: stopId, source, latency_ms: latencyMs, created_at: new Date().toISOString() })
    .abortSignal(AbortSignal.timeout(3000))
    .then(() => {})
    .catch(() => {});
}

// ── Main handler ──────────────────────────────────────────
module.exports = async (req, res) => {
  const startTime = Date.now();
  if (await checkRateLimit(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  // Premium departure cap: free=2, premium=20.
  // PREMIUM_ENABLED is currently false — all users get premium access.
  // When the flag is turned on, verify device_id against push_tokens.is_premium
  // (populated by RevenueCat webhook) instead of trusting a client-supplied param.
  let arrivalLimit = 20; // default: all users premium while flag is off
  const deviceId = req.query.device_id;
  if (deviceId && /^[a-zA-Z0-9_-]{8,64}$/.test(deviceId)) {
    const { data: tokenRow } = await supabase
      .from('push_tokens')
      .select('is_premium')
      .eq('device_id', deviceId)
      .maybeSingle();
    // is_premium column does not exist yet — tokenRow will be null or lack the field.
    // Safe default: treat as premium while PREMIUM_ENABLED=false.
    if (tokenRow?.is_premium === false) arrivalLimit = 2;
  }

  // ── Batch mode: ?stops=3017,3000,9942 ───────────────────
  const stopsParam = req.query.stops;
  if (stopsParam) {
    const ids = stopsParam.split(',').map(s => (s.trim().replace(/^0+/, '') || s.trim())).filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: 'stops param empty' });
    if (ids.length > 10) return res.status(400).json({ error: 'Too many stops', max: 10, received: ids.length });

    // Pre-resolve all stop metadata in two queries to avoid N+1 inside fetchArrivalsForStop
    await Promise.all([
      (async () => {
        try {
          const { data } = await supabase.from('stops').select('stop_id, stop_code').eq('agency', 'OC').in('stop_code', ids);
          const byCode = {};
          for (const row of (data || [])) {
            if (!byCode[row.stop_code]) byCode[row.stop_code] = [];
            byCode[row.stop_code].push(String(row.stop_id));
          }
          for (const id of ids) {
            if (byCode[id]) ocStopCodeCache[id] = { ids: byCode[id], ts: Date.now() };
          }
        } catch {}
      })(),
      (async () => {
        try {
          const orFilter = ids.map(id => `stop_code.eq.${id},stop_id.eq.${id}`).join(',');
          const { data } = await supabase.from('stops').select('stop_id, stop_code, agency').or(orFilter);
          for (const row of (data || [])) {
            const key = row.stop_code || row.stop_id;
            if (key) stopAgencyCache[key] = { agency: row.agency, ts: Date.now() };
          }
        } catch {}
      })(),
    ]);

    const results = await Promise.all(ids.map(id => fetchArrivalsForStop(id, arrivalLimit)));
    res.json({ results });
    logRequest(ids.join(','), 'batch', Date.now() - startTime);
    return;
  }

  // ── Single stop mode: ?stop=3017 ───────────────────────
  const rawStopId = req.query.stop || req.query.stopId;
  if (!rawStopId) return res.status(400).json({ error: 'stop param required' });
  const stopId = rawStopId.replace(/^0+/, '') || rawStopId;

  const result = await fetchArrivalsForStop(stopId, arrivalLimit);
  if (result.error) return res.status(500).json(result);
  res.json(result);
  logRequest(stopId, result.source || 'unknown', Date.now() - startTime);
};
