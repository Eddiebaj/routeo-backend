const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabase = createClient(
  'https://bzvkadttywgszovbowch.supabase.co',
  'sb_publishable_UQXeqJ_OE-Zhl51qrHVF3w_UXOxKk2O'
);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const START_FROM = 3566500;

async function main() {
  console.log('Loading data...');
  const stopTimes = JSON.parse(fs.readFileSync('./data/stopTimes.json'));
  const trips = JSON.parse(fs.readFileSync('./data/trips.json'));

  const rows = [];
  for (const stopId of Object.keys(stopTimes)) {
    for (const entry of stopTimes[stopId]) {
      const trip = trips[entry.tripId] || {};
      rows.push({
        stop_id: stopId,
        trip_id: entry.tripId,
        arrival_time: entry.time,
        route_id: trip.routeId || '',
        headsign: trip.headsign || '',
        service_id: trip.serviceId || '',
      });
    }
  }

  console.log(`Total rows: ${rows.length}, resuming from ${START_FROM}`);

  const BATCH_SIZE = 200;

  for (let i = START_FROM; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    let retries = 3;
    while (retries > 0) {
      const { error } = await supabase.from('stop_times').insert(batch);
      if (!error) break;
      retries--;
      console.log(`Retry at row ${i}... (${retries} left)`);
      await sleep(2000);
      if (retries === 0) {
        console.error(`Failed at row ${i}:`, error.message);
        process.exit(1);
      }
    }
    if ((i - START_FROM) % 10000 === 0) console.log(`Uploaded up to row ${i}...`);
    await sleep(50); // 50ms delay between batches
  }

  console.log('Done!');
}

main().catch(console.error);