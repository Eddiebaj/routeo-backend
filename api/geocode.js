// api/geocode.js — debug version
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { input, type } = req.query;
  if (!input) return res.status(400).json({ error: 'Missing input' });

  if (!GOOGLE_KEY) return res.status(500).json({ error: 'No GOOGLE_API_KEY env var' });

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(input + ', Ottawa, ON')}&key=${GOOGLE_KEY}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();

    // Return raw Google response for debugging
    return res.status(200).json({
      status: data.status,
      error_message: data.error_message || null,
      count: data.results?.length || 0,
      results: (data.results || []).slice(0, 3).map(r => ({
        placeId: r.place_id,
        label: r.formatted_address,
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
