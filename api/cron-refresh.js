const { checkRateLimit } = require('./_rateLimit');
const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const GTFS_URL = 'https://oct-gtfs-emasagcnfmcgeham.z01.azurefd.net/public-access/GTFSExport.zip';
const BATCH_SIZE = 500;

function timeToMins(t) {
  if (!t) return 9999;
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

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

module.exports = async (req, res) => {
  if (checkRateLimit(req, res)) return;
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
    const stTripIdx = stHeaders.indexOf('trip_id');
    const stStopIdx = stHeaders.indexOf('stop_id');
    const stTimeIdx = stHeaders.indexOf('arrival_time');

    const stopTimeRows = [];
    for (let i = 1; i < stLines.length; i++) {
      const cols   = stLines[i].replace(/\r/g, '').split(',');
      const tripId = cols[stTripIdx] || '';
      const stopId = cols[stStopIdx] || '';
      const time   = cols[stTimeIdx] || '';
      if (!tripId || !stopId || !time) continue;

      const trip = tripsMap[tripId] || {};
      stopTimeRows.push({
        stop_id:      stopId,
        trip_id:      tripId,
        arrival_time: time,
        route_id:     trip.routeId   || '',
        headsign:     trip.headsign  || '',
        service_id:   trip.serviceId || '',
        agency:       'OC',
      });
    }

    // ── Clear existing OC data (preserve STO) ─────────────────────
    console.log('Clearing OC data...');
    const { error: delStopTimesErr } = await supabase.from('stop_times').delete().eq('agency', 'OC');
    if (delStopTimesErr) throw new Error(`Delete OC stop_times failed: ${delStopTimesErr.message}`);

    const { error: delTripsErr } = await supabase.from('trips').delete().eq('agency', 'OC');
    if (delTripsErr) throw new Error(`Delete OC trips failed: ${delTripsErr.message}`);

    // ── Insert fresh data ─────────────────────────────────────────
    console.log(`Inserting ${tripRows.length} trips...`);
    await batchInsert('trips', tripRows);

    console.log(`Inserting ${stopTimeRows.length} stop_times...`);
    await batchInsert('stop_times', stopTimeRows);

    console.log('Done.');
    res.json({
      ok: true,
      stop_times: stopTimeRows.length,
      trips: tripRows.length,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).json({ error: err.message });
  }
};
