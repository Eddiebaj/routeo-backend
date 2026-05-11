const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');
const https = require('https');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

const GTFS_URL = 'https://oct-gtfs-emasagcnfmcgeham.z01.azurefd.net/public-access/GTFSExport.zip';
const BATCH = 1000;

function download(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    https.get(url, res => {
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

// Upsert stops: only update GTFS fields, never overwrite OSM amenity columns
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
  console.log('=== RouteO GTFS Seed ===\n');

  console.log('Downloading GTFS...');
  const zip = new AdmZip(await download(GTFS_URL));

  // Parse trips.txt
  console.log('Parsing trips.txt...');
  const tripLines = zip.readAsText('trips.txt').trim().split('\n');
  const th = tripLines[0].replace(/\r/g,'').split(',');
  const [tId,tRoute,tHead,tSvc] = ['trip_id','route_id','trip_headsign','service_id'].map(k=>th.indexOf(k));
  const tripsMap = {}, tripRows = [];
  for (let i = 1; i < tripLines.length; i++) {
    const c = tripLines[i].replace(/\r/g,'').split(',');
    if (!c[tId]) continue;
    tripsMap[c[tId]] = { routeId: c[tRoute]||'', headsign: c[tHead]||'', serviceId: c[tSvc]||'' };
    tripRows.push({ trip_id:c[tId], route_id:c[tRoute]||'', headsign:c[tHead]||'', service_id:c[tSvc]||'', agency:'OC' });
  }
  console.log(`  ${tripRows.length} trips parsed`);

  // Parse stops.txt
  console.log('Parsing stops.txt...');
  const stopLines = zip.readAsText('stops.txt').trim().split('\n');
  const slh = stopLines[0].replace(/\r/g,'').split(',');
  const [slId,slCode,slName,slLat,slLon] = ['stop_id','stop_code','stop_name','stop_lat','stop_lon'].map(k=>slh.indexOf(k));
  const stopRows = [];
  for (let i = 1; i < stopLines.length; i++) {
    const c = stopLines[i].replace(/\r/g,'').split(',');
    if (!c[slId]) continue;
    stopRows.push({ stop_id:c[slId], stop_code:slCode>=0?(c[slCode]||''):'', stop_name:c[slName]||'', stop_lat:parseFloat(c[slLat])||0, stop_lon:parseFloat(c[slLon])||0, agency:'OC' });
  }
  console.log(`  ${stopRows.length} stops parsed`);

  // Upsert stops — preserve has_shelter, has_bench, has_bin (set by OSM import)
  console.log('Upserting stops (preserving amenity columns)...');
  await batchUpsertStops(stopRows);

  // Clear and re-upload OC trips only (preserve STO data)
  console.log('Clearing OC trips...');
  await supabase.from('trips').delete().eq('agency', 'OC');
  console.log('Upserting trips...');
  await batchUpsertTrips(tripRows);

  // Record last update timestamp in gtfs_metadata
  console.log('Recording GTFS freshness timestamp...');
  const { error: metaErr } = await supabase.from('gtfs_metadata').upsert(
    { key: 'oc_last_updated', value: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  if (metaErr) console.warn('  Warning: failed to update gtfs_metadata:', metaErr.message);

  console.log('\n=== Done! ===');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
