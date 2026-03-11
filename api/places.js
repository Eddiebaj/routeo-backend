// api/places.js — Combined Google Places API proxy
// Actions: autocomplete, details, photo, nearby
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { action } = req.query;
  if (!action) return res.status(400).json({ error: 'Missing action param (autocomplete|details|photo|nearby)' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'No GOOGLE_API_KEY env var' });

  try {
    switch (action) {
      case 'autocomplete': {
        const { input, location, radius } = req.query;
        if (!input) return res.status(400).json({ error: 'Missing input' });
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
        return res.status(200).json(await resp.json());
      }

      case 'details': {
        const { place_id, fields } = req.query;
        if (!place_id) return res.status(400).json({ error: 'Missing place_id' });
        const params = new URLSearchParams({
          place_id,
          fields: fields || 'geometry,name,formatted_address',
          key: GOOGLE_KEY,
        });
        const resp = await fetch(
          `https://maps.googleapis.com/maps/api/place/details/json?${params}`,
          { signal: AbortSignal.timeout(5000) }
        );
        return res.status(200).json(await resp.json());
      }

      case 'photo': {
        const { photo_reference, maxwidth } = req.query;
        if (!photo_reference) return res.status(400).json({ error: 'Missing photo_reference' });
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
      }

      case 'nearby': {
        const { location, radius, type } = req.query;
        if (!location) return res.status(400).json({ error: 'Missing location' });
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
        return res.status(200).json(await resp.json());
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error(`Places ${action} error:`, err);
    return res.status(500).json({ error: `${action} failed`, detail: err.message });
  }
}
