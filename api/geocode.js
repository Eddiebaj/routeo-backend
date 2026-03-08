// api/geocode.js — Google Places + Geocoding proxy for RouteO

const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { input, type } = req.query;
  if (!input) return res.status(400).json({ error: 'Missing input' });

  try {
    if (type === 'geocode') {
      // Direct geocoding for raw addresses
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
      // Places autocomplete
      const [placesResp, geoResp] = await Promise.all([
        fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&location=45.4215,-75.6972&radius=50000&components=country:ca&key=${GOOGLE_KEY}`, { signal: AbortSignal.timeout(5000) }),
        input.length >= 4 ? fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(input + ', Ottawa, ON')}&key=${GOOGLE_KEY}`, { signal: AbortSignal.timeout(5000) }) : Promise.resolve(null),
      ]);

      const placesData = await placesResp.json();
      const placesResults = (placesData.predictions || []).slice(0, 4).map(p => ({
        placeId: p.place_id,
        label: p.description,
      }));

      let geoResults = [];
      if (geoResp) {
        const geoData = await geoResp.json();
        geoResults = (geoData.results || []).slice(0, 2).map(r => ({
          placeId: r.place_id,
          label: r.formatted_address,
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
        }));
      }

      const seen = new Set(placesResults.map(r => r.label.toLowerCase().slice(0, 20)));
      const merged = [...placesResults, ...geoResults.filter(r => !seen.has(r.label.toLowerCase().slice(0, 20)))].slice(0, 5);
      return res.status(200).json({ results: merged });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Geocode failed', detail: err.message });
  }
}

// Place details by placeId
export async function getPlaceDetails(placeId) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=geometry,name,formatted_address&key=${GOOGLE_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json();
  const loc = data.result?.geometry?.location;
  return loc ? { lat: loc.lat, lng: loc.lng, label: data.result.formatted_address || data.result.name } : null;
}
