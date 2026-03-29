const { createClient } = require('@supabase/supabase-js');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const supabase = createClient(
  'https://bzvkadttywgszovbowch.supabase.co',
  'sb_publishable_UQXeqJ_OE-Zhl51qrHVF3w_UXOxKk2O'
);

const OC_KEY = process.env.OC_TRANSPO_API_KEY || 'b08f2056bef846cf8a0d1487c59b6d74';
const STO_KEY = process.env.STO_API_KEY || '047BF16E296E977027D2D8374F8CEEC1';

const AdmZip = require('adm-zip');

const GTFS_RT_URL = 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tu/beta/v1/TripUpdates?format=json';
const STO_GTFS_RT_URL = 'https://www.sto.ca/sites/default/files/opendata/gtfs_rt/TripUpdates.pb';
const STO_GTFS_ZIP_URL = 'https://www.sto.ca/sites/default/files/opendata/gtfs/google_transit.zip';

// ── STO headsign lookup (cached in module scope, refreshed daily) ──
let stoTripsMap = {};      // { [trip_id]: headsign }
let stoTripsLoadedAt = 0;  // timestamp of last load
const STO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

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
    const header = lines[0].replace(/\r/g, '').split(',');
    const idxTripId = header.indexOf('trip_id');
    const idxHeadsign = header.indexOf('trip_headsign');
    if (idxTripId < 0) throw new Error('trip_id column not found');
    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].replace(/\r/g, '').split(',');
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

// ── STO stop detection ─────────────────────────────────────────
// STO stop IDs are purely numeric and typically 5 digits starting with 1-5
function isSTOStop(stopId) {
  const id = String(stopId);
  // OC Transpo stops are numeric (4-5 digits) or alphanumeric (e.g. EE995, NA998)
  // STO stops are numeric 5-digit IDs in range 10000-59999
  if (!/^\d+$/.test(id)) return false; // alphanumeric = OC Transpo LRT platform
  const num = parseInt(id);
  return num >= 10000 && num <= 59999 && !isOCTranspoNumericStop(id);
}

// OC Transpo numeric stops are generally under 15000 or specific known ranges
// We identify STO by checking if the stop is NOT in OC Transpo's known ranges
function isOCTranspoNumericStop(stopId) {
  const num = parseInt(stopId);
  // OC Transpo bus stops are typically 1000-14999
  // STO stops are typically 15000-59999
  // This is a best-effort heuristic — static GTFS seeding is the proper fix
  if (num >= 1000 && num <= 14999) return true;
  return false;
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

function timeToMins(t) {
  if (!t) return 9999;
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + (parts[1] || 0);
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

// ── Fetch OC Transpo GTFS-RT live predictions ──────────────────
async function fetchRealtime(stopId) {
  const stopIds = MULTI_PLATFORM_STOPS[stopId] || [stopId];
  const stopSet = new Set(stopIds.map(String));

  const resp = await fetch(GTFS_RT_URL, {
    headers: { 'Ocp-Apim-Subscription-Key': OC_KEY },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`GTFS-RT ${resp.status}`);
  const data = await resp.json();

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

  const resp = await fetch(STO_GTFS_RT_URL, {
    headers: { 'apikey': STO_KEY },
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
  console.log(`[fetchStatic] stopId=${stopId}, ottawaNow=${ottawaNow}, currentMins=${currentMins}, maxMins=${maxMins}`);

  // Expand multi-platform stops (same as fetchRealtime)
  const stopIds = MULTI_PLATFORM_STOPS[stopId] || [stopId];

  // Query each platform separately and merge (avoids slow .in() on large stop_times table)
  let allData = [];
  for (const sid of stopIds) {
    const { data: rows, error: err } = await supabase
      .from('stop_times')
      .select('arrival_time, route_id, headsign, service_id, trip_id, stop_id')
      .eq('stop_id', sid)
      .order('arrival_time', { ascending: true });
    if (err) throw new Error(err.message);
    if (rows) allData.push(...rows);
  }
  // Sort merged results by arrival time
  allData.sort((a, b) => (a.arrival_time || '').localeCompare(b.arrival_time || ''));
  const data = allData;
  const error = null;

  if (error) throw new Error(error.message);
  console.log(`[fetchStatic] raw rows for stop ${stopId} (${stopIds.length} platforms): ${(data || []).length}`);

  const allRows = (data || []).map(row => ({ ...row, mins: timeToMins(row.arrival_time) }));
  const inWindow = allRows.filter(row => row.mins >= currentMins && row.mins <= maxMins);
  console.log(`[fetchStatic] rows in time window: ${inWindow.length}`);

  // Filter by today's service — do NOT fall back to wrong-day schedules
  let finalRows = inWindow.filter(row => serviceMatchesToday(row.service_id));
  console.log(`[fetchStatic] rows matching today's service: ${finalRows.length}`);

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
        minsAway: row.mins - currentMins,
      };
    });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const rawStopId = req.query.stop || req.query.stopId;
  if (!rawStopId) return res.status(400).json({ error: 'stop param required' });
  // Strip leading zeros: "0322" → "322", but keep "0" as "0"
  const stopId = rawStopId.replace(/^0+/, '') || rawStopId;

  const isSTO = isSTOStop(stopId);

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
  } catch {}

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

  // ── STO stop flow ──────────────────────────────────────────
  if (isSTO) {
    try {
      const stoArrivals = await fetchSTORealtime(stopId);
      if (stoArrivals.length > 0) {
        await ghostPromise;
        return res.json({ stop: stopId, stopName, arrivals: stoArrivals, source: 'sto-gtfs-rt', agency: 'STO', ghostReports });
      }
    } catch (err) {
      console.error('STO GTFS-RT failed:', err.message);
    }
    // STO static fallback
    try {
      const staticArrivals = await fetchStatic(stopId);
      await ghostPromise;
      return res.json({ stop: stopId, stopName, arrivals: staticArrivals, source: 'gtfs-static', agency: 'STO', ghostReports });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── OC Transpo stop flow ───────────────────────────────────
  try {
    const rtArrivals = await fetchRealtime(stopId);
    if (rtArrivals.length > 0) {
      await ghostPromise;
      return res.json({ stop: stopId, stopName, arrivals: rtArrivals, source: 'gtfs-rt', ghostReports });
    }
  } catch {
    // GTFS-RT failed, fall through to static
  }

  try {
    const staticArrivals = await fetchStatic(stopId);
    await ghostPromise;
    return res.json({ stop: stopId, stopName, arrivals: staticArrivals, source: 'gtfs-static', ghostReports });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
