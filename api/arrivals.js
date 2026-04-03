const { checkRateLimit } = require('./_rateLimit');
const { buildStoUrl } = require('./_sto');
const { timeToMins } = require('./_gtfs');
const { createClient } = require('@supabase/supabase-js');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const OC_KEY = process.env.OC_TRANSPO_API_KEY;

const AdmZip = require('adm-zip');

const GTFS_RT_URL = 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tu/beta/v1/TripUpdates?format=json';
const STO_GTFS_ZIP_URL = 'https://www.contenu.sto.ca/GTFS/GTFS.zip';

// Module-level cache for OC Transpo GTFS-RT feed (shared across concurrent requests)
let rtCache = { data: null, ts: 0 };
const RT_TTL = 30000; // 30 seconds

// ── STO headsign lookup (cached in module scope, refreshed daily) ──
let stoTripsMap = {};      // { [trip_id]: headsign }
let stoTripsLoadedAt = 0;  // timestamp of last load
const STO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ── STO static schedule cache (stop_times, routes from GTFS ZIP) ──
let stoStopTimesMap = {};   // { [stop_id]: [{arrival_time, trip_id}] }
let stoRoutesMap = {};      // { [route_id]: route_short_name }
let stoTripRouteMap = {};   // { [trip_id]: route_id }
let stoStopTimesLoadedAt = 0;

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
    console.log(`STO trips.txt loaded: ${Object.keys(map).length} trips`);
  } catch (err) {
    console.error('STO trips.txt load failed:', err.message);
    // Keep stale cache if available
  }
  return stoTripsMap;
}

// ── STO stop_times + routes (cached, loaded from GTFS ZIP) ──────
async function getSTOStopTimes() {
  if (Object.keys(stoStopTimesMap).length > 0 && Date.now() - stoStopTimesLoadedAt < STO_CACHE_TTL) {
    return { stopTimes: stoStopTimesMap, routes: stoRoutesMap, tripRoutes: stoTripRouteMap };
  }
  try {
    const resp = await fetch(STO_GTFS_ZIP_URL, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`STO GTFS zip HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const zip = new AdmZip(buf);

    // Parse stop_times.txt
    const stEntry = zip.getEntry('stop_times.txt');
    if (!stEntry) throw new Error('stop_times.txt not found in STO GTFS zip');
    const stLines = stEntry.getData().toString('utf8').trim().split('\n');
    const stHeader = parseCSVLine(stLines[0].replace(/\r/g, ''));
    const idxArrival = stHeader.indexOf('arrival_time');
    const idxTrip = stHeader.indexOf('trip_id');
    const idxStop = stHeader.indexOf('stop_id');
    if (idxArrival < 0 || idxTrip < 0 || idxStop < 0) throw new Error('Required columns missing in stop_times.txt');

    const newStopTimes = {};
    for (let i = 1; i < stLines.length; i++) {
      const cols = parseCSVLine(stLines[i].replace(/\r/g, ''));
      const stopId = cols[idxStop];
      const tripId = cols[idxTrip];
      const arrTime = cols[idxArrival];
      if (!stopId || !tripId || !arrTime) continue;
      if (!newStopTimes[stopId]) newStopTimes[stopId] = [];
      newStopTimes[stopId].push({ arrival_time: arrTime, trip_id: tripId });
    }

    // Parse trips.txt for trip_id → route_id
    const trEntry = zip.getEntry('trips.txt');
    const newTripRoutes = {};
    if (trEntry) {
      const trLines = trEntry.getData().toString('utf8').trim().split('\n');
      const trHeader = parseCSVLine(trLines[0].replace(/\r/g, ''));
      const idxTrTrip = trHeader.indexOf('trip_id');
      const idxTrRoute = trHeader.indexOf('route_id');
      if (idxTrTrip >= 0 && idxTrRoute >= 0) {
        for (let i = 1; i < trLines.length; i++) {
          const cols = parseCSVLine(trLines[i].replace(/\r/g, ''));
          if (cols[idxTrTrip]) newTripRoutes[cols[idxTrTrip]] = cols[idxTrRoute] || '';
        }
      }
    }

    // Parse routes.txt for route_id → route_short_name
    const rtEntry = zip.getEntry('routes.txt');
    const newRoutes = {};
    if (rtEntry) {
      const rtLines = rtEntry.getData().toString('utf8').trim().split('\n');
      const rtHeader = parseCSVLine(rtLines[0].replace(/\r/g, ''));
      const idxRtId = rtHeader.indexOf('route_id');
      const idxRtShort = rtHeader.indexOf('route_short_name');
      if (idxRtId >= 0 && idxRtShort >= 0) {
        for (let i = 1; i < rtLines.length; i++) {
          const cols = parseCSVLine(rtLines[i].replace(/\r/g, ''));
          if (cols[idxRtId]) newRoutes[cols[idxRtId]] = cols[idxRtShort] || cols[idxRtId];
        }
      }
    }

    stoStopTimesMap = newStopTimes;
    stoTripRouteMap = newTripRoutes;
    stoRoutesMap = newRoutes;
    stoStopTimesLoadedAt = Date.now();
    console.log(`STO stop_times loaded: ${Object.keys(newStopTimes).length} stops, ${Object.keys(newTripRoutes).length} trips, ${Object.keys(newRoutes).length} routes`);
  } catch (err) {
    console.error('STO stop_times load failed:', err.message);
  }
  return { stopTimes: stoStopTimesMap, routes: stoRoutesMap, tripRoutes: stoTripRouteMap };
}

async function fetchSTOStatic(stopId) {
  const { stopTimes, routes, tripRoutes } = await getSTOStopTimes();

  const entries = stopTimes[String(stopId)] || [];
  if (!entries.length) return [];

  const ottawaNow = new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });
  const [h, m] = ottawaNow.split(':').map(Number);
  const currentMins = h * 60 + m;
  const maxMins = currentMins + 90;

  // After-midnight support (same as OC fetchStatic)
  const isAfterMidnight = h < 4;
  const afterMidnightCurrentMins = isAfterMidnight ? currentMins + 1440 : 0;
  const afterMidnightMaxMins = isAfterMidnight ? afterMidnightCurrentMins + 90 : 0;

  // Filter entries by time window
  const inWindow = entries
    .map(e => ({ ...e, mins: timeToMins(e.arrival_time) }))
    .filter(e =>
      (e.mins >= currentMins && e.mins <= maxMins) ||
      (isAfterMidnight && e.mins >= afterMidnightCurrentMins && e.mins <= afterMidnightMaxMins)
    );

  // Sort by arrival time
  inWindow.sort((a, b) => a.mins - b.mins);

  // Deduplicate by route, limit to 8
  const seen = new Set();
  const results = [];
  for (const e of inWindow) {
    const routeId = tripRoutes[e.trip_id] || '';
    const routeShort = routes[routeId] || routeId;
    const dedupKey = routeShort || e.trip_id;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Resolve headsign from stoTripsMap (already loaded by getSTOTripsMap or from cache)
    const headsign = cleanHeadsign(stoTripsMap[e.trip_id] || '', routeShort);

    results.push({
      stopId,
      routeId: routeShort,
      tripId: e.trip_id,
      headsign,
      scheduledTime: e.arrival_time,
      minsAway: isAfterMidnight && e.mins >= 1440 ? e.mins - afterMidnightCurrentMins : e.mins - currentMins,
    });
    if (results.length >= 8) break;
  }

  return results;
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

function cleanHeadsign(headsign, routeId) {
  if (!headsign || headsign.trim() === '') return `Route ${routeId}`;
  const cleaned = headsign.replace(/^\d+\s*[-–]\s*/, '').trim();
  return cleaned || `Route ${routeId}`;
}

function getTodayServiceKeyword() {
  // Use Toronto timezone — Vercel runs in UTC, which can be a different day
  const ottawaDay = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto', weekday: 'long' }).toLowerCase();
  if (ottawaDay === 'sunday') return 'sunday';
  if (ottawaDay === 'saturday') return 'saturday';
  return 'weekday';
}

function serviceMatchesToday(serviceId) {
  if (!serviceId) return true;
  return serviceId.toLowerCase().includes(getTodayServiceKeyword());
}

function getYesterdayServiceKeyword() {
  // For after-midnight trips: determine what service ran "yesterday" in Ottawa
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yDay = yesterday.toLocaleDateString('en-CA', { timeZone: 'America/Toronto', weekday: 'long' }).toLowerCase();
  if (yDay === 'sunday') return 'sunday';
  if (yDay === 'saturday') return 'saturday';
  return 'weekday';
}

// ── Fetch OC Transpo GTFS-RT feed (cached) ─────────────────────
async function fetchGtfsRtData() {
  if (rtCache.data && Date.now() - rtCache.ts < RT_TTL) {
    return rtCache.data;
  }
  const resp = await fetch(GTFS_RT_URL, {
    headers: { 'Ocp-Apim-Subscription-Key': OC_KEY },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`GTFS-RT ${resp.status}`);
  const data = await resp.json();
  rtCache = { data, ts: Date.now() };
  return data;
}

// ── Fetch OC Transpo GTFS-RT live predictions ──────────────────
async function fetchRealtime(stopId) {
  if (!OC_KEY) { console.warn('OC_TRANSPO_API_KEY not set'); return []; }
  const stopIds = MULTI_PLATFORM_STOPS[stopId] || [stopId];
  const stopSet = new Set(stopIds.map(String));

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
  if (!stoUrl) throw new Error('STO keys not configured');
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

// ── Fetch static GTFS schedule ────────────────────────────────
async function fetchStatic(stopId) {
  const ottawaNow = new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });
  const [h, m] = ottawaNow.split(':').map(Number);
  const currentMins = h * 60 + m;
  const maxMins = currentMins + 90;
  // After-midnight support: GTFS uses times like 25:30 for post-midnight trips
  // belonging to the previous calendar day's service. If it's before 4 AM,
  // also check the 24+ hour range (previous day's after-midnight trips).
  const isAfterMidnight = h < 4;
  const afterMidnightCurrentMins = isAfterMidnight ? currentMins + 1440 : 0; // e.g., 1:30 AM = 1470
  const afterMidnightMaxMins = isAfterMidnight ? afterMidnightCurrentMins + 90 : 0;
  console.log(`[fetchStatic] stopId=${stopId}, ottawaNow=${ottawaNow}, currentMins=${currentMins}, maxMins=${maxMins}${isAfterMidnight ? `, afterMidnight=${afterMidnightCurrentMins}-${afterMidnightMaxMins}` : ''}`);

  // Expand multi-platform stops (same as fetchRealtime)
  const stopIds = MULTI_PLATFORM_STOPS[stopId] || [stopId];

  // Build time range strings for server-side filtering (avoids 1000-row default limit)
  const fmtTime = (mins) => {
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    return `${hh}:${mm}:00`;
  };
  const timeFrom = fmtTime(currentMins);
  const timeTo = fmtTime(maxMins);

  // Query each platform separately and merge (avoids slow .in() on large stop_times table)
  let allData = [];
  for (const sid of stopIds) {
    // Primary time window query
    const { data: rows, error: err } = await supabase
      .from('stop_times')
      .select('arrival_time, route_id, headsign, service_id, trip_id, stop_id')
      .eq('stop_id', sid)
      .gte('arrival_time', timeFrom)
      .lte('arrival_time', timeTo)
      .order('arrival_time', { ascending: true })
      .limit(200);
    if (err) throw new Error(err.message);
    if (rows) allData.push(...rows);

    // After-midnight: also query 24+ hour range (e.g., 25:30-27:00)
    if (isAfterMidnight) {
      const amFrom = fmtTime(afterMidnightCurrentMins);
      const amTo = fmtTime(afterMidnightMaxMins);
      const { data: amRows, error: amErr } = await supabase
        .from('stop_times')
        .select('arrival_time, route_id, headsign, service_id, trip_id, stop_id')
        .eq('stop_id', sid)
        .gte('arrival_time', amFrom)
        .lte('arrival_time', amTo)
        .order('arrival_time', { ascending: true })
        .limit(100);
      if (!amErr && amRows) allData.push(...amRows);
    }
  }
  // Sort merged results by arrival time
  allData.sort((a, b) => (a.arrival_time || '').localeCompare(b.arrival_time || ''));
  const data = allData;

  console.log(`[fetchStatic] raw rows for stop ${stopId} (${stopIds.length} platforms): ${(data || []).length}`);

  const allRows = (data || []).map(row => ({ ...row, mins: timeToMins(row.arrival_time) }));
  // Normal window: e.g., 14:00-15:30 (currentMins to maxMins)
  // After-midnight window: e.g., 1:30 AM = also check 25:30 (1470-1560) from previous day's service
  const inWindow = allRows.filter(row =>
    (row.mins >= currentMins && row.mins <= maxMins) ||
    (isAfterMidnight && row.mins >= afterMidnightCurrentMins && row.mins <= afterMidnightMaxMins)
  );
  console.log(`[fetchStatic] rows in time window: ${inWindow.length}`);

  // Filter by service: normal-range trips match today's service,
  // after-midnight trips (mins >= 1440) match yesterday's service
  const todayKeyword = getTodayServiceKeyword();
  const yesterdayKeyword = getYesterdayServiceKeyword();
  let finalRows = inWindow.filter(row => {
    if (row.mins >= 1440) {
      // After-midnight trip from previous calendar day's schedule
      return row.service_id ? row.service_id.toLowerCase().includes(yesterdayKeyword) : true;
    }
    return row.service_id ? row.service_id.toLowerCase().includes(todayKeyword) : true;
  });
  console.log(`[fetchStatic] rows matching service: ${finalRows.length}`);

  const tripIds = [...new Set(finalRows.map(r => r.trip_id).filter(Boolean))];
  let tripsMap = {};
  if (tripIds.length > 0) {
    const { data: tripData } = await supabase
      .from('trips')
      .select('trip_id, headsign, route_id')
      .in('trip_id', tripIds);
    if (tripData) for (const t of tripData) tripsMap[t.trip_id] = t;
  }

  // Normalize route_id for dedup: "1-350-1" → "1-350", "42-1" → "42"
  function normalizeRouteId(rid) {
    if (!rid) return rid;
    // Strip trailing variant suffix: "1-350-1" → "1-350", "42-1" → "42"
    // Pattern: if it ends with "-{digit(s)}" and has at least one other segment, strip it
    const parts = rid.split('-');
    if (parts.length >= 3) return parts.slice(0, -1).join('-'); // "1-350-1" → "1-350"
    if (parts.length === 2 && /^\d+$/.test(parts[1]) && parts[1].length <= 2) return parts[0]; // "42-1" → "42"
    return rid;
  }

  const seen = new Set();
  return finalRows
    .filter(row => {
      // Dedup by normalized route + arrival time (prevents "1-350" and "1-350-1" duplicates)
      const key = `${normalizeRouteId(row.route_id)}-${row.arrival_time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8)
    .map(row => {
      const trip = tripsMap[row.trip_id] || {};
      return {
        stopId,
        routeId: row.route_id,
        tripId: row.trip_id,
        headsign: cleanHeadsign(trip.headsign || row.headsign || '', row.route_id),
        scheduledTime: row.arrival_time,
        minsAway: (isAfterMidnight && row.mins >= 1440) ? row.mins - afterMidnightCurrentMins : row.mins - currentMins,
      };
    });
}

module.exports = async (req, res) => {
  if (await checkRateLimit(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');

  const rawStopId = req.query.stop || req.query.stopId;
  if (!rawStopId) return res.status(400).json({ error: 'stop param required' });
  // Strip leading zeros: "0322" → "322", but keep "0" as "0"
  const stopId = rawStopId.replace(/^0+/, '') || rawStopId;

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

  // Look up stop name (best-effort, non-blocking) — try requested ID first, then platforms
  let stopName = null;
  try {
    const { data: stopRow } = await supabase.from('stops').select('stop_name').eq('stop_id', stopId).single();
    if (stopRow) stopName = stopRow.stop_name;
    if (!stopName) {
      const platforms = MULTI_PLATFORM_STOPS[stopId];
      if (platforms) {
        const { data: platRows } = await supabase.from('stops').select('stop_name').in('stop_id', platforms).limit(1);
        if (platRows?.[0]) stopName = platRows[0].stop_name;
      }
    }
  } catch (e) { console.warn('Stop name lookup error:', e.message); }

  // ── Fetch ghost reports in parallel ────────────────────────
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

  // Helper to build response with optional data warning
  const buildResp = (base) => {
    if (dataWarning) base.dataWarning = dataWarning;
    return base;
  };

  // ── STO stop flow ──────────────────────────────────────────
  if (isSTO) {
    try {
      let stoArrivals = await fetchSTORealtime(stopId);
      // Retry once after 2s if GTFS-RT returned empty
      if (stoArrivals.length === 0) {
        await new Promise(r => setTimeout(r, 2000));
        stoArrivals = await fetchSTORealtime(stopId);
        if (stoArrivals.length > 0) console.log(`[arrivals] STO GTFS-RT retry succeeded for stop ${stopId}`);
      }
      if (stoArrivals.length > 0) {
        await Promise.all([ghostPromise, freshnessPromise]);
        const arrivals = stoArrivals.map(a => ({ ...a, source: 'sto-gtfs-rt' }));
        return res.json(buildResp({ stop: stopId, stopName, arrivals, source: 'sto-gtfs-rt', agency: 'STO', ghostReports }));
      }
      console.log(`[arrivals] STO GTFS-RT empty for stop ${stopId}, falling back to static`);
    } catch (err) {
      console.warn(`[arrivals] STO GTFS-RT failed for stop ${stopId}:`, err.message);
    }
    // STO static fallback
    try {
      const staticArrivals = await fetchSTOStatic(stopId);
      const arrivals = staticArrivals.map(a => ({ ...a, source: 'sto-gtfs-static', agency: 'STO' }));
      await Promise.all([ghostPromise, freshnessPromise]);
      return res.json(buildResp({ stop: stopId, stopName, arrivals, source: 'sto-gtfs-static', agency: 'STO', ghostReports }));
    } catch (err) {
      console.error('[arrivals] STO static fallback failed:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ── OC Transpo stop flow ───────────────────────────────────
  try {
    let rtArrivals = await fetchRealtime(stopId);
    // Retry once after 2s if GTFS-RT returned empty (transient feed gap)
    if (rtArrivals.length === 0) {
      await new Promise(r => setTimeout(r, 2000));
      rtArrivals = await fetchRealtime(stopId);
      if (rtArrivals.length > 0) console.log(`[arrivals] GTFS-RT retry succeeded for stop ${stopId}`);
    }
    if (rtArrivals.length > 0) {
      await Promise.all([ghostPromise, freshnessPromise]);
      const arrivals = rtArrivals.map(a => ({ ...a, source: 'gtfs-rt' }));
      return res.json(buildResp({ stop: stopId, stopName, arrivals, source: 'gtfs-rt', ghostReports }));
    }
    console.log(`[arrivals] GTFS-RT empty for stop ${stopId}, falling back to static`);
  } catch (err) {
    console.warn(`[arrivals] GTFS-RT failed for stop ${stopId}:`, err.message);
    // Fall through to static
  }

  try {
    const staticArrivals = await fetchStatic(stopId);
    const arrivals = staticArrivals.map(a => ({ ...a, source: 'gtfs-static' }));
    await Promise.all([ghostPromise, freshnessPromise]);
    return res.json(buildResp({ stop: stopId, stopName, arrivals, source: 'gtfs-static', ghostReports }));
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};
