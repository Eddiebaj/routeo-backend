// scripts/enrich-venues.js — One-time Foursquare v2 enrichment for HAPPY_HOUR_VENUES
// Run with: node scripts/enrich-venues.js
const fs = require('fs');

const CLIENT_ID = '1PPSNW2H05JA4C3LI1JR0BAMMBNAPEK1XEHXWLMMVWIVQJPE';
const CLIENT_SECRET = 'M0WAJWI0SGKXPBXTRLW1G0AOTCUFICZIZ3WSCGAM1AB3XFE4';
const V = '20240101';

const VENUES = require('./venue-list.json');

async function searchFoursquare(name, lat, lng) {
  const url = `https://api.foursquare.com/v2/venues/search?query=${encodeURIComponent(name)}&ll=${lat},${lng}&radius=200&limit=1&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&v=${V}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`  HTTP ${res.status} for "${name}" ${body.slice(0, 100)}`);
    return null;
  }
  const data = await res.json();
  return data.response?.venues?.[0] ?? null;
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

    results.push({
      ...venue,
      fsqId: match.id,
      foursquareName: match.name,
      category: match.categories?.[0]?.name ?? null,
      isVerified: true,
      lastVerified: new Date().toISOString().split('T')[0],
    });

    console.log(`-> ${match.name} (${match.id})`);
  }

  // Summary
  const verified = results.filter(r => r.isVerified);
  const unmatched = results.filter(r => !r.isVerified);

  console.log(`\n=== RESULTS ===`);
  console.log(`Verified: ${verified.length}/${results.length}`);
  console.log(`Unmatched: ${unmatched.length}`);

  if (unmatched.length > 0) {
    console.log(`\nUnmatched venues (need manual check):`);
    unmatched.forEach(v => console.log(`  - ${v.name}: ${v.reason}`));
  }

  fs.writeFileSync(
    'scripts/enriched-venues.json',
    JSON.stringify(results, null, 2)
  );
  console.log(`\nWrote enriched data to scripts/enriched-venues.json`);
  console.log(`Review the file, then update lib/happyHourData.ts with fsqId fields`);
}

enrichVenues().catch(err => { console.error('Fatal:', err); process.exit(1); });
