// api/places-details.js — Proxy Google Place Details
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { place_id, fields } = req.query;
  if (!place_id) return res.status(400).json({ error: 'Missing place_id' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'No GOOGLE_API_KEY env var' });

  try {
    const params = new URLSearchParams({
      place_id,
      fields: fields || 'geometry,name,formatted_address',
      key: GOOGLE_KEY,
    });
    const resp = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?${params}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await resp.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Place details error:', err);
    return res.status(500).json({ error: 'Details failed', detail: err.message });
  }
}
