// api/places-autocomplete.js — Proxy Google Places Autocomplete
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { input, location, radius } = req.query;
  if (!input) return res.status(400).json({ error: 'Missing input' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'No GOOGLE_API_KEY env var' });

  try {
    const params = new URLSearchParams({
      input,
      location: location || '45.4215,-75.6972',
      radius: radius || '50000',
      key: GOOGLE_KEY,
    });
    const resp = await fetch(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await resp.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Places autocomplete error:', err);
    return res.status(500).json({ error: 'Autocomplete failed', detail: err.message });
  }
}
