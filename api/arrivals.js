const { checkRateLimit } = require('./_rateLimit');
const { buildStoUrl } = require('./_sto');

const { createClient } = require('@supabase/supabase-js');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const OC_KEY = process.env.OC_TRANSPO_API_KEY;   // VehiclePositions
const OC_TU_KEY = process.env.OC_TRANSPO_TU_KEY; // TripUpdates (separate product)

const AdmZip = require('adm-zip');

const GTFS_RT_URL = 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates?format=json';
const STO_GTFS_ZIP_URL = 'https://www.contenu.sto.ca/GTFS/GTFS.zip';

// Module-level cache for OC Transpo GTFS-RT feed (shared across concurrent requests)
let rtCache = { data: null, ts: 0 };
const RT_TTL = 30000; // 30 seconds

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

// ── STO headsign lookup (cached in module scope, refreshed daily) ──
let stoTripsMap = {};      // { [trip_id]: headsign }
let stoTripsLoadedAt = 0;  // timestamp of last load
let stoTripsLoading = false; // lock: prevents concurrent zip downloads
const STO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { fields.push(current); current = ''; }
    else { current += ch; }
  }
  fields.push(current);
  return fields;
}

async function getSTOTripsMap() {
  if (Object.keys(stoTripsMap).length > 0 && Date.now() - stoTripsLoadedAt < STO_CACHE_TTL) {
    return stoTripsMap;
  }
  // Lock: if another request is already downloading, return stale cache immediately
  if (stoTripsLoading) return stoTripsMap;
  stoTripsLoading = true;
  try {
    const resp = await fetch(STO_GTFS_ZIP_URL, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`STO GTFS zip HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const zip = new AdmZip(buf);
    const tripsEntry = zip.getEntry('trips.txt');
    if (!tripsEntry) throw new Error('trips.txt not found in STO GTFS zip');
    const lines = tripsEntry.getData().toString('utf8').trim().split('\n');
    const header = parseCSVLine(lines[0].replace(/\r/g, ''));
    const idxTripId = header.indexOf('trip_id');
    const idxHeadsign = header.indexOf('trip_headsign');
    if (idxTripId < 0) throw new Error('trip_id column not found');
    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i].replace(/\r/g, ''));
      if (!cols[idxTripId]) continue;
      map[cols[idxTripId]] = idxHeadsign >= 0 ? (cols[idxHeadsign] || '') : '';
    }
    stoTripsMap = map;
    stoTripsLoadedAt = Date.now();
    // STO trips.txt loaded silently
  } catch (err) {
    console.error('STO trips.txt load failed:', err.message);
    // Keep stale cache if available
  } finally {
    stoTripsLoading = false;
  }
  return stoTripsMap;
}

// ── STO stop detection ─────────────────────────────────────────
// STO stops use alphanumeric IDs that start with letters (e.g. "AAAA", "STOP1")
// OC Transpo stops are purely numeric (e.g. "3000", "9942") or alphanumeric LRT
// platform codes (e.g. "NA998", "EE995") which are in MULTI_PLATFORM_STOPS
function isStoStop(stopId) {
  return /^[A-Za-z]/.test(String(stopId));
}

function isSTOStop(stopId) {
  const id = String(stopId);
  // If it's in our multi-platform map, it's OC Transpo
  if (MULTI_PLATFORM_STOPS[id]) return false;
  return isStoStop(id);
}

// Multi-platform transit hub stops (e.g. Rideau Centre has platforms 9942-9948)
const MULTI_PLATFORM_STOPS = {
  '9942': ['9942','9943','9944','9945','9946','9947','9948','NA998','NA999'],
  '9943': ['9942','9943','9944','9945','9946','9947','9948','NA998','NA999'],
  '9944': ['9942','9943','9944','9945','9946','9947','9948','NA998','NA999'],
  '9945': ['9942','9943','9944','9945','9946','9947','9948','NA998','NA999'],
  '9946': ['9942','9943','9944','9945','9946','9947','9948','NA998','NA999'],
  '9947': ['9942','9943','9944','9945','9946','9947','9948','NA998','NA999'],
  '9948': ['9942','9943','9944','9945','9946','9947','9948','NA998','NA999'],
  'NA998': ['9942','9943','9944','9945','9946','9947','9948','NA998','NA999'],
  'NA999': ['9942','9943','9944','9945','9946','9947','9948','NA998','NA999'],
  '10027': ['10027','10028','NA990','NA995','NA996','NA997'],
  '10028': ['10027','10028','NA990','NA995','NA996','NA997'],
  'NA990': ['10027','10028','NA990','NA995','NA996','NA997'],
  'NA995': ['10027','10028','NA990','NA995','NA996','NA997'],
  'NA996': ['10027','10028','NA990','NA995','NA996','NA997'],
  'NA997': ['10027','10028','NA990','NA995','NA996','NA997'],
  '9870': ['9870','9871','9957','9958','CJ990','CJ995'],
  '9871': ['9870','9871','9957','9958','CJ990','CJ995'],
  '9957': ['9870','9871','9957','9958','CJ990','CJ995'],
  '9958': ['9870','9871','9957','9958','CJ990','CJ995'],
  'CJ990': ['9870','9871','9957','9958','CJ990','CJ995'],
  'CJ995': ['9870','9871','9957','9958','CJ990','CJ995'],
  '9928': ['9928','9929','CA990','CA995'],
  '9929': ['9928','9929','CA990','CA995'],
  'CA990': ['9928','9929','CA990','CA995'],
  'CA995': ['9928','9929','CA990','CA995'],
  '9822': ['9822','9868','CB990','CB995'],
  '9868': ['9822','9868','CB990','CB995'],
  'CB990': ['9822','9868','CB990','CB995'],
  'CB995': ['9822','9868','CB990','CB995'],
  '9833': ['9833','9869','10004','10734','CD990','CD995'],
  '9869': ['9833','9869','10004','10734','CD990','CD995'],
  '10004': ['9833','9869','10004','10734','CD990','CD995'],
  '10734': ['9833','9869','10004','10734','CD990','CD995'],
  'CD990': ['9833','9869','10004','10734','CD990','CD995'],
  'CD995': ['9833','9869','10004','10734','CD990','CD995'],
  '10735': ['10735','10736','CD998','CD999'],
  '10736': ['10735','10736','CD998','CD999'],
  'CD998': ['10735','10736','CD998','CD999'],
  'CD999': ['10735','10736','CD998','CD999'],
  '10042': ['10042','10043','CE990','CE995'],
  '10043': ['10042','10043','CE990','CE995'],
  'CE990': ['10042','10043','CE990','CE995'],
  'CE995': ['10042','10043','CE990','CE995'],
  '9951': ['9951','9952','9953','9954','9955','AF990','AF995'],
  '9952': ['9951','9952','9953','9954','9955','AF990','AF995'],
  '9953': ['9951','9952','9953','9954','9955','AF990','AF995'],
  '9954': ['9951','9952','9953','9954','9955','AF990','AF995'],
  '9955': ['9951','9952','9953','9954','9955','AF990','AF995'],
  'AF990': ['9951','9952','9953','9954','9955','AF990','AF995'],
  'AF995': ['9951','9952','9953','9954','9955','AF990','AF995'],
  '10728': ['10728','10729','AE990','AE995'],
  '10729': ['10728','10729','AE990','AE995'],
  'AE990': ['10728','10729','AE990','AE995'],
  'AE995': ['10728','10729','AE990','AE995'],
  '10014': ['10014','10015','10016','10017','EB990','EB995'],
  '10015': ['10014','10015','10016','10017','EB990','EB995'],
  '10016': ['10014','10015','10016','10017','EB990','EB995'],
  '10017': ['10014','10015','10016','10017','EB990','EB995'],
  'EB990': ['10014','10015','10016','10017','EB990','EB995'],
  'EB995': ['10014','10015','10016','10017','EB990','EB995'],
  '10743': ['10743','10744','EC990','EC995'],
  '10744': ['10743','10744','EC990','EC995'],
  'EC990': ['10743','10744','EC990','EC995'],
  'EC995': ['10743','10744','EC990','EC995'],
  '9872': ['9872','9873','9922','9961','9963','10144','10149','EE990','EE995'],
  '9873': ['9872','9873','9922','9961','9963','10144','10149','EE990','EE995'],
  '9922': ['9872','9873','9922','9961','9963','10144','10149','EE990','EE995'],
  '9961': ['9872','9873','9922','9961','9963','10144','10149','EE990','EE995'],
  '9963': ['9872','9873','9922','9961','9963','10144','10149','EE990','EE995'],
  '10144': ['9872','9873','9922','9961','9963','10144','10149','EE990','EE995'],
  '10149': ['9872','9873','9922','9961','9963','10144','10149','EE990','EE995'],
  'EE990': ['9872','9873','9922','9961','9963','10144','10149','EE990','EE995'],
  'EE995': ['9872','9873','9922','9961','9963','10144','10149','EE990','EE995'],
};

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
  const sampleStops = entities.slice(0, 3).map(e =>
    (e?.TripUpdate?.StopTimeUpdate || []).slice(0, 1).map(s => s?.StopId ?? s?.stop_id ?? 'n/a').join('')
  );
  console.log(`[gtfs-rt-tu] entities=${entities.length} sampleStopIds=${JSON.stringify(sampleStops)}`);
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
      if (secsAway < -60 || secsAway > 5400) continue;
      const trip = tu.Trip || {};
      results.push({
        stopId,
        routeId: trip.RouteId || '?',
        tripId: String(trip.TripId || ''),
        headsign: '',
        minsAway: Math.max(0, Math.round(secsAway / 60)),
        arrivalTime: t,
        departureTime: parseInt((stu.Departure || {}).Time || 0) || t,
        scheduleRelationship: stu.ScheduleRelationship || 'SCHEDULED',
        agency: 'OC',
      });
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
  // Kick off trips map load in parallel with GTFS-RT fetch
  const tripsMapP = getSTOTripsMap();

  const stoUrl = buildStoUrl('trip');
  if (!stoUrl) {
    console.warn('STO keys not configured, skipping realtime');
    return [];
  }
  const resp = await fetch(stoUrl, {
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`STO GTFS-RT ${resp.status}`);

  const buffer = await resp.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    new Uint8Array(buffer)
  );

  const tripsMap = await tripsMapP;
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
      if (secsAway < -60 || secsAway > 5400) continue;
      const trip = tu.trip || {};
      const tripId = String(trip.tripId || '');
      const routeId = trip.routeId || '?';

      // Resolve headsign: GTFS-RT vehicle descriptor → trips.txt lookup → fallback
      let headsign = '';
      if (tu.vehicle && tu.vehicle.label) {
        headsign = tu.vehicle.label;
      }
      if (!headsign && tripId && tripsMap[tripId]) {
        headsign = tripsMap[tripId];
      }
      if (!headsign) {
        headsign = `Route ${routeId}`;
      } else {
        headsign = cleanHeadsign(headsign, routeId);
      }

      results.push({
        stopId,
        routeId,
        tripId,
        headsign,
        minsAway: Math.max(0, Math.round(secsAway / 60)),
        arrivalTime: t,
        departureTime: t,
        scheduleRelationship: 'SCHEDULED',
        agency: 'STO',
      });
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

  return unique;
}

// ── Core per-stop logic (returns response object) ─────────
async function fetchArrivalsForStop(stopId, arrivalLimit = 8) {
  const isSTO = isSTOStop(stopId);

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
    assignConfidence(base.arrivals || []);
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
        await Promise.all([ghostPromise, freshnessPromise, reliabilityPromise]);
        const arrivals = stoArrivals.map(a => ({ ...a, source: 'sto-gtfs-rt' }));
        return buildResp({ stop: stopId, stopName, arrivals, source: 'sto-gtfs-rt', agency: 'STO', ghostReports });
      }
      // STO GTFS-RT empty
    } catch (err) {
      console.warn(`[arrivals] STO GTFS-RT failed for stop ${stopId}:`, err.message);
    }
    await Promise.all([ghostPromise, freshnessPromise, reliabilityPromise]);
    return buildResp({ stop: stopId, stopName, arrivals: [], source: 'sto-gtfs-rt-empty', agency: 'STO', ghostReports });
  }

  // ── OC Transpo stop flow ───────────────────────────────────
  // Skip realtime entirely if API key is missing — go straight to static
  if (OC_TU_KEY) {
    try {
      const rtArrivals = await fetchRealtime(stopId);
      if (rtArrivals.length > 0) {
        await Promise.all([ghostPromise, freshnessPromise, reliabilityPromise]);
        const arrivals = rtArrivals.map(a => ({ ...a, source: 'gtfs-rt' }));
        return buildResp({ stop: stopId, stopName, arrivals, source: 'gtfs-rt', ghostReports });
      }
      // OC GTFS-RT empty
    } catch (err) {
      console.warn(`[arrivals] GTFS-RT failed for stop ${stopId}:`, err.message);
    }
  } else {
    console.warn(`[arrivals] OC_TRANSPO_TU_KEY not set, skipping realtime for stop ${stopId}`);
  }

  await Promise.all([ghostPromise, freshnessPromise, reliabilityPromise]);
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
