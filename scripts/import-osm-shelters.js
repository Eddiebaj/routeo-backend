#!/usr/bin/env node
/**
 * One-time import: OpenStreetMap bus stop amenities → Supabase stops table
 *
 * Queries Overpass API for bus stops in Ottawa/Gatineau bounding box,
 * matches each OSM node to the nearest Supabase stop within 20m,
 * and writes has_shelter, has_bench, has_bin flags.
 *
 * Prerequisites:
 *   ALTER TABLE stops ADD COLUMN IF NOT EXISTS has_shelter BOOLEAN DEFAULT FALSE;
 *   ALTER TABLE stops ADD COLUMN IF NOT EXISTS has_bench BOOLEAN DEFAULT FALSE;
 *   ALTER TABLE stops ADD COLUMN IF NOT EXISTS has_bin BOOLEAN DEFAULT FALSE;
 *
 * Usage:
 *   node scripts/import-osm-shelters.js
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_QUERY = `[out:json][timeout:60];(node["highway"="bus_stop"](45.2,-76.0,45.6,-75.4);node["amenity"="bus_station"](45.2,-76.0,45.6,-75.4);node["public_transport"="platform"](45.2,-76.0,45.6,-75.4););out body;`;

// Haversine distance in meters
function distMeters(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function main() {
  console.log('1. Fetching OSM bus stops from Overpass API...');
  const resp = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
  });
  if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
  const osm = await resp.json();
  const osmNodes = osm.elements || [];
  console.log(`   Found ${osmNodes.length} OSM bus stop nodes`);

  // Extract amenity info from each OSM node
  const osmStops = osmNodes.map(n => ({
    lat: n.lat,
    lon: n.lon,
    shelter: !!(n.tags?.shelter === 'yes' || n.tags?.covered === 'yes'),
    bench: !!(n.tags?.bench === 'yes'),
    bin: !!(n.tags?.bin === 'yes' || n.tags?.waste_basket === 'yes'),
  })).filter(s => s.shelter || s.bench || s.bin); // Only keep nodes with amenity data

  console.log(`   ${osmStops.length} nodes have at least one amenity tag`);

  // 2. Load all Supabase stops
  console.log('2. Loading stops from Supabase...');
  let allStops = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('stops')
      .select('stop_id,stop_lat,stop_lon')
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allStops.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  console.log(`   Loaded ${allStops.length} stops`);

  // 3. Match OSM nodes to nearest Supabase stop within 20m
  console.log('3. Matching OSM nodes to nearest stops (20m threshold)...');
  const updates = new Map(); // stop_id → { has_shelter, has_bench, has_bin }
  let matched = 0;
  let noMatch = 0;

  for (const osm of osmStops) {
    let bestDist = Infinity;
    let bestStop = null;

    for (const stop of allStops) {
      // Quick lat/lon filter (~200m box) before expensive haversine
      if (Math.abs(stop.stop_lat - osm.lat) > 0.002) continue;
      if (Math.abs(stop.stop_lon - osm.lon) > 0.003) continue;

      const d = distMeters(osm.lat, osm.lon, stop.stop_lat, stop.stop_lon);
      if (d < bestDist) {
        bestDist = d;
        bestStop = stop;
      }
    }

    if (bestStop && bestDist <= 20) {
      matched++;
      const existing = updates.get(bestStop.stop_id) || { has_shelter: false, has_bench: false, has_bin: false };
      if (osm.shelter) existing.has_shelter = true;
      if (osm.bench) existing.has_bench = true;
      if (osm.bin) existing.has_bin = true;
      updates.set(bestStop.stop_id, existing);
    } else {
      noMatch++;
    }
  }

  console.log(`   Matched: ${matched}, No match within 20m: ${noMatch}`);
  console.log(`   Unique stops to update: ${updates.size}`);

  // 4. Batch update Supabase
  console.log('4. Writing amenity data to Supabase...');
  let updated = 0;
  let errors = 0;
  const entries = [...updates.entries()];

  for (let i = 0; i < entries.length; i += 50) {
    const batch = entries.slice(i, i + 50);
    const promises = batch.map(([stopId, amenities]) =>
      supabase.from('stops').update(amenities).eq('stop_id', stopId)
    );
    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled' && !r.value.error) updated++;
      else errors++;
    }
    process.stdout.write(`   ${Math.min(i + 50, entries.length)}/${entries.length}\r`);
  }

  console.log(`\n5. Done! Updated ${updated} stops, ${errors} errors`);

  // Summary
  let shelters = 0, benches = 0, bins = 0;
  for (const a of updates.values()) {
    if (a.has_shelter) shelters++;
    if (a.has_bench) benches++;
    if (a.has_bin) bins++;
  }
  console.log(`   Shelters: ${shelters}, Benches: ${benches}, Bins: ${bins}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
