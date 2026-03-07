const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');
const https = require('https');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://bzvkadttywgszovbowch.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_UQXeqJ_OE-Zhl51qrHVF3w_UXOxKk2O'
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

async function batchInsert(table, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + BATCH));
    if (error) throw new Error(`${table} insert failed at ${i}: ${error.message}`);
    process.stdout.write(`\r  ${table}: ${Math.min(i+BATCH, rows.length)}/${rows.length}`);
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
    tripRows.push({ trip_id:c[tId], route_id:c[tRoute]||'', headsign:c[tHead]||'', service_id:c[tSvc]||'' });
  }
  console.log(`  ${tripRows.length} trips parsed`);

  // Parse stops.txt
  console.log('Parsing stops.txt...');
  const stopLines = zip.readAsText('stops.txt').trim().split('\n');
  const slh = stopLines[0].replace(/\r/g,'').split(',');
  const [slId,slName,slLat,slLon] = ['stop_id','stop_name','stop_lat','stop_lon'].map(k=>slh.indexOf(k));
  const stopRows = [];
  for (let i = 1; i < stopLines.length; i++) {
    const c = stopLines[i].replace(/\r/g,'').split(',');
    if (!c[slId]) continue;
    stopRows.push({ stop_id:c[slId], stop_name:c[slName]||'', lat:parseFloat(c[slLat])||0, lng:parseFloat(c[slLon])||0 });
  }
  console.log(`  ${stopRows.length} stops parsed`);

  // Parse stop_times.txt
  console.log('Parsing stop_times.txt...');
  const stLines = zip.readAsText('stop_times.txt').trim().split('\n');
  const sh = stLines[0].replace(/\r/g,'').split(',');
  const [sTrp,sStop,sTime] = ['trip_id','stop_id','arrival_time'].map(k=>sh.indexOf(k));
  const stRows = [];
  for (let i = 1; i < stLines.length; i++) {
    const c = stLines[i].replace(/\r/g,'').split(',');
    if (!c[sTrp]||!c[sStop]||!c[sTime]) continue;
    const t = tripsMap[c[sTrp]]||{};
    stRows.push({ stop_id:c[sStop], trip_id:c[sTrp], arrival_time:c[sTime], route_id:t.routeId||'', headsign:t.headsign||'', service_id:t.serviceId||'' });
  }
  console.log(`  ${stRows.length} stop_times parsed`);

  // Clear and re-upload stops
  console.log('Clearing stops...');
  await supabase.from('stops').delete().neq('stop_id','');
  console.log('Uploading stops...');
  await batchInsert('stops', stopRows);

  // Clear and re-upload trips
  console.log('Clearing trips...');
  await supabase.from('trips').delete().neq('trip_id','');
  console.log('Uploading trips...');
  await batchInsert('trips', tripRows);

  // Clear and re-upload stop_times
  console.log('Clearing stop_times...');
  await supabase.from('stop_times').delete().neq('id', 0);
  console.log('Uploading stop_times...');
  await batchInsert('stop_times', stRows);

  console.log('\n=== Done! ===');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
