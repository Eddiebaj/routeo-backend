const { checkRateLimit } = require('./_rateLimit');
const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const GTFS_URL = 'https://oct-gtfs-emasagcnfmcgeham.z01.azurefd.net/public-access/GTFSExport.zip';
const BATCH_SIZE = 500;

async function downloadBuffer(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const chunks = [];
    https.get(url, res => {
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function batchInsert(table, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw new Error(`Insert failed at row ${i} in ${table}: ${error.message}`);
  }
}

async function insertBatchWithRetry(batch, attempt = 0) {
  try {
    const { error } = await supabase.from('stop_times').upsert(batch, { onConflict: 'trip_id,stop_sequence' });
    if (error) throw error;
  } catch (e) {
    if (attempt < 3) {
      console.log(`Batch failed, retrying (${attempt + 1}/3)...`);
      await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
      return insertBatchWithRetry(batch, attempt + 1);
    }
    throw e;
  }
}

async function batchUpsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`Upsert failed at row ${i} in ${table}: ${error.message}`);
  }
}

async function seedStops(zip) {
  console.log('Parsing stops.txt...');
  const stopsRaw = zip.readAsText('stops.txt');
  const lines = stopsRaw.trim().split('\n');
  const headers = lines[0].replace(/\r/g, '').split(',');
  const idIdx = headers.indexOf('stop_id');
  const nameIdx = headers.indexOf('stop_name');
  const latIdx = headers.indexOf('stop_lat');
  const lonIdx = headers.indexOf('stop_lon');

  const stopRows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].replace(/\r/g, '').split(',');
    const stopId = cols[idIdx] || '';
    if (!stopId) continue;
    stopRows.push({
      stop_id: stopId,
      stop_name: cols[nameIdx] || '',
      stop_lat: parseFloat(cols[latIdx]) || null,
      stop_lon: parseFloat(cols[lonIdx]) || null,
    });
  }

  console.log(`Upserting ${stopRows.length} stops...`);
  await batchUpsert('stops', stopRows, 'stop_id');
  console.log('Stops seeded.');
  return stopRows.length;
}

module.exports = async (req, res) => {
  if (await checkRateLimit(req, res)) return;
  const auth = req.headers['authorization'];
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Cache-Control', 'no-store');

  try {
    console.log('Downloading GTFS zip...');
    const buffer = await downloadBuffer(GTFS_URL);
    const zip = new AdmZip(buffer);

    // ── Parse trips.txt ──────────────────────────────────────────
    console.log('Parsing trips.txt...');
    const tripsRaw = zip.readAsText('trips.txt');
    const tripLines = tripsRaw.trim().split('\n');
    const tripHeaders = tripLines[0].replace(/\r/g, '').split(',');
    const tripIdIdx    = tripHeaders.indexOf('trip_id');
    const routeIdIdx   = tripHeaders.indexOf('route_id');
    const headsignIdx  = tripHeaders.indexOf('trip_headsign');
    const serviceIdIdx = tripHeaders.indexOf('service_id');

    const tripsMap = {};
    const tripRows = [];

    for (let i = 1; i < tripLines.length; i++) {
      const cols      = tripLines[i].replace(/\r/g, '').split(',');
      const tripId    = cols[tripIdIdx]    || '';
      const routeId   = cols[routeIdIdx]   || '';
      const headsign  = cols[headsignIdx]  || '';
      const serviceId = cols[serviceIdIdx] || '';
      if (!tripId) continue;
      tripsMap[tripId] = { routeId, headsign, serviceId };
      tripRows.push({ trip_id: tripId, route_id: routeId, headsign, service_id: serviceId, agency: 'OC' });
    }

    // ── Parse stop_times.txt ─────────────────────────────────────
    console.log('Parsing stop_times.txt...');
    const stRaw     = zip.readAsText('stop_times.txt');
    const stLines   = stRaw.trim().split('\n');
    const stHeaders = stLines[0].replace(/\r/g, '').split(',');
    const stTripIdx  = stHeaders.indexOf('trip_id');
    const stStopIdx  = stHeaders.indexOf('stop_id');
    const stTimeIdx  = stHeaders.indexOf('arrival_time');
    const stSeqIdx   = stHeaders.indexOf('stop_sequence');

    const stopTimeRows = [];
    for (let i = 1; i < stLines.length; i++) {
      const cols        = stLines[i].replace(/\r/g, '').split(',');
      const tripId      = cols[stTripIdx] || '';
      const stopId      = cols[stStopIdx] || '';
      const time        = cols[stTimeIdx] || '';
      const stopSeq     = parseInt(cols[stSeqIdx], 10) || 0;
      if (!tripId || !stopId || !time) continue;

      const trip = tripsMap[tripId] || {};
      stopTimeRows.push({
        stop_id:       stopId,
        trip_id:       tripId,
        arrival_time:  time,
        stop_sequence: stopSeq,
        route_id:      trip.routeId   || '',
        headsign:      trip.headsign  || '',
        service_id:    trip.serviceId || '',
        agency:        'OC',
      });
    }

    // ── Seed stops table (upsert — safe to run anytime) ──────────
    const stopsCount = await seedStops(zip);

    // If ?stopsOnly=1, skip the heavy trips/stop_times refresh
    if (req.query.stopsOnly === '1') {
      return res.json({ ok: true, stops: stopsCount, timestamp: new Date().toISOString() });
    }

    // ── Refresh trips and stop_times ──────────────────────────────
    // Trips: upsert with onConflict to avoid delete+insert gap
    console.log(`Upserting ${tripRows.length} trips...`);
    await batchUpsert('trips', tripRows, 'trip_id');

    // stop_times: resume from where we left off, then retry on network failure
    const { count: existingCount } = await supabase
      .from('stop_times')
      .select('*', { count: 'exact', head: true });
    const startFrom = existingCount ?? 0;
    console.log(`Resuming stop_times from row ${startFrom} of ${stopTimeRows.length}...`);
    const remainingStopTimes = stopTimeRows.slice(startFrom);

    for (let i = 0; i < remainingStopTimes.length; i += BATCH_SIZE) {
      const batch = remainingStopTimes.slice(i, i + BATCH_SIZE);
      await insertBatchWithRetry(batch);
    }

    console.log('Done.');
    res.json({
      ok: true,
      stops: stopsCount,
      stop_times: stopTimeRows.length,
      trips: tripRows.length,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
