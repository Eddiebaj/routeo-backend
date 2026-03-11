// api/places-photo.js — Proxy Google Place Photos (returns image binary)
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { photo_reference, maxwidth } = req.query;
  if (!photo_reference) return res.status(400).json({ error: 'Missing photo_reference' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'No GOOGLE_API_KEY env var' });

  try {
    const params = new URLSearchParams({
      photo_reference,
      maxwidth: maxwidth || '400',
      key: GOOGLE_KEY,
    });
    const resp = await fetch(
      `https://maps.googleapis.com/maps/api/place/photo?${params}`,
      { signal: AbortSignal.timeout(10000), redirect: 'follow' }
    );
    if (!resp.ok) return res.status(resp.status).json({ error: 'Photo fetch failed' });

    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await resp.arrayBuffer());
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('Place photo error:', err);
    return res.status(500).json({ error: 'Photo failed', detail: err.message });
  }
}
