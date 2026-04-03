// scripts/enrich-venues.js — One-time Foursquare enrichment for HAPPY_HOUR_VENUES
// Run with: FOURSQUARE_API_KEY=xxx node scripts/enrich-venues.js
const fs = require('fs');

const FSQ_KEY = process.env.FOURSQUARE_API_KEY;
if (!FSQ_KEY) { console.error('FOURSQUARE_API_KEY env var required'); process.exit(1); }

// Venue list extracted from lib/happyHourData.ts — name + lat/lng is all we need for matching
const VENUES = require('./venue-list.json');

async function searchFoursquare(name, lat, lng) {
  const url = `https://api.foursquare.com/v3/places/search?query=${encodeURIComponent(name)}&ll=${lat},${lng}&radius=200&limit=1&fields=fsq_id,name,hours,location,rating,photos`;
  const res = await fetch(url, {
    headers: { Authorization: FSQ_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.error(`  HTTP ${res.status} for "${name}"`);
    return null;
  }
  const data = await res.json();
  return data.results?.[0] ?? null;
}

async function enrichVenues() {
  const results = [];

  for (let i = 0; i < VENUES.length; i++) {
    const venue = VENUES[i];
    process.stdout.write(`[${i + 1}/${VENUES.length}] ${venue.name} ... `);

    if (!venue.lat || !venue.lng) {
      console.log('SKIP (no coordinates)');
      results.push({ ...venue, isVerified: false, reason: 'no coordinates' });
      continue;
    }

    // Foursquare rate limit: ~10 req/sec
    await new Promise(r => setTimeout(r, 150));

    const match = await searchFoursquare(venue.name, venue.lat, venue.lng);

    if (!match) {
      console.log('NO MATCH');
      results.push({ ...venue, isVerified: false, reason: 'no match found' });
      continue;
    }

    const isClosed = match.hours?.open_now === false && !match.hours?.regular;

    results.push({
      ...venue,
      fsqId: match.fsq_id,
      foursquareName: match.name,
      regularHours: match.hours?.regular ?? null,
      isOpenNow: match.hours?.open_now ?? null,
      rating: match.rating ?? null,
      photoUrl: match.photos?.[0]
        ? `${match.photos[0].prefix}300x200${match.photos[0].suffix}`
        : null,
      isVerified: true,
      isPermanentlyClosed: isClosed || false,
      lastVerified: new Date().toISOString().split('T')[0],
    });

    console.log(`-> ${match.name} (${match.fsq_id})${isClosed ? ' [POSSIBLY CLOSED]' : ''}`);
  }

  // Summary
  const verified = results.filter(r => r.isVerified);
  const unmatched = results.filter(r => !r.isVerified);
  const closed = results.filter(r => r.isPermanentlyClosed);

  console.log(`\n=== RESULTS ===`);
  console.log(`Verified: ${verified.length}/${results.length}`);
  console.log(`Unmatched: ${unmatched.length}`);
  console.log(`Possibly closed: ${closed.length}`);

  if (closed.length > 0) {
    console.log(`\nPossibly closed venues:`);
    closed.forEach(v => console.log(`  - ${v.name}`));
  }

  if (unmatched.length > 0) {
    console.log(`\nUnmatched venues (need manual check):`);
    unmatched.forEach(v => console.log(`  - ${v.name}: ${v.reason}`));
  }

  fs.writeFileSync(
    'scripts/enriched-venues.json',
    JSON.stringify(results, null, 2)
  );
  console.log(`\nWrote enriched data to scripts/enriched-venues.json`);
  console.log(`Review the file, then update lib/happyHourData.ts with fsqId + photoUrl fields`);
}

enrichVenues().catch(err => { console.error('Fatal:', err); process.exit(1); });
