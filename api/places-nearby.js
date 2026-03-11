// api/places-nearby.js — Proxy Google Nearby Search
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { location, radius, type } = req.query;
  if (!location) return res.status(400).json({ error: 'Missing location' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'No GOOGLE_API_KEY env var' });

  try {
    const params = new URLSearchParams({
      location,
      radius: radius || '1500',
      key: GOOGLE_KEY,
    });
    if (type) params.set('type', type);
    const resp = await fetch(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await resp.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Nearby search error:', err);
    return res.status(500).json({ error: 'Nearby search failed', detail: err.message });
  }
}
