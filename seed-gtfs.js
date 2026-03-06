/**
 * RouteO — Local GTFS Seed Script
 * Run with: node seed-gtfs.js
 * Uploads stop_times and trips directly to Supabase from your machine.
 */

const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');
const https = require('https');

const supabase = createClient(
  'https://bzvkadttywgszovbowch.supabase.co',
  'sb_publishable_UQXeqJ_OE-Zhl51qrHVF3w_UXOxKk2O'
);

const GTFS_URL = 'https://oct-gtfs-emasagcnfmcgeham.z01.azurefd.net/public-access/GTFSExport.zip';
const BATCH_SIZE = 1000;

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    https.get(url, res => {
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', chunk => {
        chunks.push(chunk);
        received += chunk.length;
        if (total) process.stdout.write(`\rDownloading... ${Math.round(received / total * 100)}%`);
      });
      res.on('end', () => { console.log('\nDownload complete.'); resolve(Buffer.concat(chunks)); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function batchInsert(table, rows) {
  let uploaded = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw new Error(`Insert failed at row ${i} in ${table}: ${error.message}`);
    uploaded += batch.length;
    process.stdout.write(`\r  Uploading ${table}... ${uploaded} / ${rows.length}`);
  }
  console.log(`\n  Done — ${uploaded} rows inserted into ${table}.`);
}

async function main() {
  console.log('=== RouteO GTFS Seed ===\n');

  // 1. Download
  console.log('Downloading GTFS zip...');
  const buffer = await downloadBuffer(GTFS_URL);
  const zip = new AdmZip(buffer);

  // 2. Parse trips.txt
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
    tripRows.push({ trip_id: tripId, route_id: routeId, headsign, service_id: serviceId });
  }
  console.log(`  Parsed ${tripRows.length} trips.`);

  // 3. Parse stop_times.txt
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
    });
  }
  console.log(`  Parsed ${stopTimeRows.length} stop_times.`);

  // 4. Upload trips
  console.log('Uploading trips...');
  await batchInsert('trips', tripRows);

  // 5. Upload stop_times
  console.log('Uploading stop_times...');
  await batchInsert('stop_times', stopTimeRows);

  console.log('\n=== Seed complete! ===');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
