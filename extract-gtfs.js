const AdmZip = require('adm-zip');
const fs = require('fs');

console.log('Loading zip...');
const zip = new AdmZip('./gtfs.zip');

// Parse trips.txt
console.log('Parsing trips...');
const tripsRaw = zip.readAsText('trips.txt');
const tripLines = tripsRaw.trim().split('\n');
const tripHeaders = tripLines[0].replace(/\r/g, '').split(',');
const tripIdIdx = tripHeaders.indexOf('trip_id');
const routeIdIdx = tripHeaders.indexOf('route_id');
const headsignIdx = tripHeaders.indexOf('trip_headsign');
const serviceIdIdx = tripHeaders.indexOf('service_id');

const trips = {};
for (let i = 1; i < tripLines.length; i++) {
  const cols = tripLines[i].replace(/\r/g, '').split(',');
  trips[cols[tripIdIdx]] = {
    routeId: cols[routeIdIdx],
    headsign: cols[headsignIdx] || '',
    serviceId: cols[serviceIdIdx] || '',
  };
}
console.log(`Loaded ${Object.keys(trips).length} trips`);

// Parse stop_times.txt
console.log('Parsing stop_times (this may take a moment)...');
const stRaw = zip.readAsText('stop_times.txt');
const stLines = stRaw.trim().split('\n');
const stHeaders = stLines[0].replace(/\r/g, '').split(',');
const stTripIdx = stHeaders.indexOf('trip_id');
const stStopIdx = stHeaders.indexOf('stop_id');
const stTimeIdx = stHeaders.indexOf('arrival_time');

const stopTimes = {};
for (let i = 1; i < stLines.length; i++) {
  const cols = stLines[i].replace(/\r/g, '').split(',');
  const stopId = cols[stStopIdx];
  if (!stopTimes[stopId]) stopTimes[stopId] = [];
  stopTimes[stopId].push({
    tripId: cols[stTripIdx],
    time: cols[stTimeIdx],
  });
}
console.log(`Loaded stop times for ${Object.keys(stopTimes).length} stops`);

// Show sample stop IDs to verify
const sampleStops = Object.keys(stopTimes).slice(0, 20);
console.log('Sample stop IDs:', sampleStops);

// Check specific stops we care about
const testStops = ['9872', '9873', 'EE995', 'EE990', 'NA995', 'NA990', 'CD995'];
for (const s of testStops) {
  const count = (stopTimes[s] || []).length;
  console.log(`Stop ${s}: ${count} entries`);
}

// Write full data
fs.writeFileSync('./data/stopTimes.json', JSON.stringify(stopTimes));
fs.writeFileSync('./data/trips.json', JSON.stringify(trips));
console.log('Done! Written to data/');
