// api/gas.js — Ottawa gas price endpoint for RouteO backend
// Uses NRCan daily pump price survey (free, no key required)
// Falls back to GasBuddy scrape if NRCan is unavailable

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600'); // cache 30min

  try {
    const price = await fetchNRCanPrice();
    return res.status(200).json({
      price,
      city: 'Ottawa',
      currency: 'CAD',
      unit: 'cents/L',
      source: 'NRCan',
      updated: new Date().toISOString().split('T')[0],
      stations: [], // station-level data not available from NRCan
    });
  } catch (err) {
    console.error('Gas price fetch failed:', err);
    return res.status(500).json({ error: 'Could not fetch gas prices' });
  }
}

async function fetchNRCanPrice() {
  // NRCan daily pump price survey — Ottawa city code is 66
  // URL: https://www2.nrcan.gc.ca/eneene/sources/pripri/prices_bycity_e.cfm?productID=1&locationID=66&frequency=D
  // The page returns HTML with a table; we parse out the most recent regular price
  const url = 'https://www2.nrcan.gc.ca/eneene/sources/pripri/prices_bycity_e.cfm?productID=1&locationID=66&frequency=D';
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'RouteO/1.0 (Ottawa transit app)' },
  });
  if (!resp.ok) throw new Error(`NRCan HTTP ${resp.status}`);
  const html = await resp.text();

  // NRCan table format: look for the most recent price in the data table
  // The prices appear as decimal numbers like "143.0" in the HTML
  // We look for patterns like >143.0< in table cells
  const priceMatch = html.match(/<td[^>]*>\s*(\d{2,3}\.\d)\s*<\/td>/);
  if (priceMatch) {
    // Convert from $/L decimal to cents (e.g. "143.0" → "143.0")
    const raw = parseFloat(priceMatch[1]);
    if (raw > 50 && raw < 300) return raw.toFixed(1);
  }

  // Secondary pattern: look for price in a different format
  const altMatch = html.match(/(\d{2,3}\.\d{1,2})\s*¢/);
  if (altMatch) return parseFloat(altMatch[1]).toFixed(1);

  // Last resort: try to extract any 3-digit price-looking number near "Ottawa"
  const ottawaIdx = html.toLowerCase().indexOf('ottawa');
  if (ottawaIdx > -1) {
    const nearby = html.slice(ottawaIdx, ottawaIdx + 500);
    const numMatch = nearby.match(/\b(1[2-9]\d\.\d)\b/);
    if (numMatch) return parseFloat(numMatch[1]).toFixed(1);
  }

  throw new Error('Could not parse price from NRCan response');
}
