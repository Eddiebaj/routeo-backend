const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');
const https = require('https');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

const STO_GTFS_URL = 'https://contenu.sto.ca/GTFS/GTFS.zip';
const BATCH = 1000;

function download(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', chunk => {
        chunks.push(chunk);
        received += chunk.length;
        if (total) process.stdout.write(`\rDownloading... ${Math.round(received/total*100)}%`);
      });
      res.on('end', () => { console.log('\nDone.'); resolve(Buffer.concat(chunks)); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Parse CSV line handling quoted fields (STO stop names contain commas)
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}


async function batchUpsertTrips(rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from('trips').upsert(rows.slice(i, i + BATCH), {
      onConflict: 'trip_id',
      ignoreDuplicates: false,
    });
    if (error) throw new Error(`trips upsert failed at ${i}: ${error.message}`);
    process.stdout.write(`\r  trips: ${Math.min(i+BATCH, rows.length)}/${rows.length}`);
  }
  console.log();
}

async function batchUpsertStops(rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from('stops').upsert(rows.slice(i, i + BATCH), {
      onConflict: 'stop_id',
      ignoreDuplicates: false,
    });
    if (error) throw new Error(`stops upsert failed at ${i}: ${error.message}`);
    process.stdout.write(`\r  stops: ${Math.min(i+BATCH, rows.length)}/${rows.length}`);
  }
  console.log();
}

async function main() {
  console.log('=== RouteO STO GTFS Seed ===\n');

  console.log('Downloading STO GTFS...');
  const zip = new AdmZip(await download(STO_GTFS_URL));

  // Verify agency
  const agencyTxt = zip.readAsText('agency.txt');
  console.log('Agency info:', agencyTxt.trim().split('\n')[1]);

  // Parse trips.txt
  console.log('Parsing trips.txt...');
  const tripLines = zip.readAsText('trips.txt').trim().split('\n');
  const th = tripLines[0].replace(/\r/g, '').split(',');
  const [tRoute, tSvc, tId, tHead] = ['route_id', 'service_id', 'trip_id', 'trip_headsign'].map(k => th.indexOf(k));
  const tripsMap = {}, tripRows = [];
  for (let i = 1; i < tripLines.length; i++) {
    const c = parseCSVLine(tripLines[i].replace(/\r/g, ''));
    if (!c[tId]) continue;
    tripsMap[c[tId]] = { routeId: c[tRoute] || '', headsign: c[tHead] || '', serviceId: c[tSvc] || '' };
    tripRows.push({
      trip_id: c[tId],
      route_id: c[tRoute] || '',
      headsign: c[tHead] || '',
      service_id: c[tSvc] || '',
      agency: 'STO',
    });
  }
  console.log(`  ${tripRows.length} trips parsed`);

  // Parse stops.txt
  console.log('Parsing stops.txt...');
  const stopLines = zip.readAsText('stops.txt').trim().split('\n');
  const slh = stopLines[0].replace(/\r/g, '').split(',');
  const [slId, slCode, slName, slLat, slLon] = ['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon'].map(k => slh.indexOf(k));
  const stopRows = [];
  for (let i = 1; i < stopLines.length; i++) {
    const c = parseCSVLine(stopLines[i].replace(/\r/g, ''));
    if (!c[slId]) continue;
    stopRows.push({
      stop_id:   c[slId],
      stop_code: slCode >= 0 ? (c[slCode] || '') : '',
      stop_name: c[slName] || '',
      stop_lat:  parseFloat(c[slLat]) || 0,
      stop_lon:  parseFloat(c[slLon]) || 0,
      agency: 'STO',
    });
  }
  console.log(`  ${stopRows.length} stops parsed`);

  // Upsert STO stops (preserves amenity columns for any existing)
  console.log('Upserting STO stops...');
  await batchUpsertStops(stopRows);

  // Clear STO trips
  console.log('Clearing existing STO trips...');
  const { error: delTrips } = await supabase.from('trips').delete().eq('agency', 'STO');
  if (delTrips) console.warn('  Warning deleting STO trips:', delTrips.message);

  // Upload STO trips
  console.log('Upserting STO trips...');
  await batchUpsertTrips(tripRows);

  // Verify counts
  console.log('\nVerifying...');
  const { data: stopCounts } = await supabase.from('stops').select('agency').then(r => {
    const counts = {};
    (r.data || []).forEach(s => { counts[s.agency] = (counts[s.agency] || 0) + 1; });
    return { data: counts };
  });
  console.log('Stop counts by agency:', JSON.stringify(stopCounts));

  const { count: stoTrips } = await supabase.from('trips').select('*', { count: 'exact', head: true }).eq('agency', 'STO');
  const { count: ocTrips } = await supabase.from('trips').select('*', { count: 'exact', head: true }).eq('agency', 'OC');
  console.log(`Trip counts: OC=${ocTrips}, STO=${stoTrips}`);

  // Record last update timestamp in gtfs_metadata
  console.log('Recording STO GTFS freshness timestamp...');
  const { error: metaErr } = await supabase.from('gtfs_metadata').upsert(
    { key: 'sto_last_updated', value: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  if (metaErr) console.warn('  Warning: failed to update gtfs_metadata:', metaErr.message);

  console.log('\n=== Done! ===');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
