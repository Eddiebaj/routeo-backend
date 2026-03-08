// api/geocode.js — Google Places autocomplete + geocoding proxy for RouteO
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { input, type } = req.query;
  if (!input) return res.status(400).json({ error: 'Missing input' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'No GOOGLE_API_KEY env var' });

  try {
    if (type === 'geocode') {
      // Single address resolution (used by planner resolvePlace)
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(input + ', Ottawa, ON')}&key=${GOOGLE_KEY}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = await resp.json();
      const results = (data.results || []).slice(0, 3).map(r => ({
        placeId: r.place_id,
        label: r.formatted_address,
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
      }));
      return res.status(200).json({ results });

    } else {
      // Fast autocomplete: Places autocomplete + single geocode in parallel
      // Skips Place Details — coords come from geocode API instead
      const [placesResp, geoResp] = await Promise.all([
        fetch(
          `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&location=45.4215,-75.6972&radius=50000&strictbounds=false&components=country:ca&key=${GOOGLE_KEY}`,
          { signal: AbortSignal.timeout(4000) }
        ),
        fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(input + ', Ottawa, ON')}&key=${GOOGLE_KEY}`,
          { signal: AbortSignal.timeout(4000) }
        ),
      ]);

      const [placesData, geoData] = await Promise.all([placesResp.json(), geoResp.json()]);

      // Build a placeId→coords map from geocode results
      const coordMap = {};
      for (const r of (geoData.results || [])) {
        coordMap[r.place_id] = { lat: r.geometry.location.lat, lng: r.geometry.location.lng, label: r.formatted_address };
      }

      // Map autocomplete predictions, attaching coords where available
      const predictions = (placesData.predictions || []).slice(0, 5);
      const results = predictions.map(p => {
        const coords = coordMap[p.place_id];
        return {
          placeId: p.place_id,
          label: p.description,
          lat: coords?.lat || null,
          lng: coords?.lng || null,
        };
      });

      // Fill missing coords: for any result without coords, use first geocode result if label matches roughly
      const firstGeo = geoData.results?.[0];
      for (const r of results) {
        if (!r.lat && firstGeo) {
          r.lat = firstGeo.geometry.location.lat;
          r.lng = firstGeo.geometry.location.lng;
        }
      }

      // Also include geocode-only results that aren't in places (handles numeric addresses)
      const seen = new Set(results.map(r => r.placeId));
      for (const r of (geoData.results || []).slice(0, 2)) {
        if (!seen.has(r.place_id)) {
          results.push({ placeId: r.place_id, label: r.formatted_address, lat: r.geometry.location.lat, lng: r.geometry.location.lng });
        }
      }

      return res.status(200).json({ results: results.slice(0, 5) });
    }
  } catch (err) {
    console.error('Geocode error:', err);
    return res.status(500).json({ error: 'Geocode failed', detail: err.message });
  }
}
