// api/places.js — Combined Google API proxy
// Actions: autocomplete, details, photo, nearby, geocode, autocomplete-geocode
const { checkRateLimit } = require('./_rateLimit');
const { createClient } = require('@supabase/supabase-js');

const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const ALLOWED_HOSTS = ['maps.googleapis.com', 'lh3.googleusercontent.com'];
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function sanitizeRadius(raw) {
  if (raw == null || raw === '') return 1500;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return 1500;
  return Math.max(100, Math.min(50000, n));
}

module.exports = async function handler(req, res) {
  if (await checkRateLimit(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { action } = req.query;
  if (!action) return res.status(400).json({ error: 'Missing action param (autocomplete|details|photo|nearby|geocode|autocomplete-geocode)' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'No GOOGLE_API_KEY env var' });

  try {
    switch (action) {
      case 'autocomplete': {
        const { input, location, radius } = req.query;
        if (!input) return res.status(400).json({ error: 'Missing input' });
        const params = new URLSearchParams({
          input,
          location: location || '45.4215,-75.6972',
          radius: String(sanitizeRadius(radius || '50000')),
          key: GOOGLE_KEY,
        });
        const resp = await fetch(
          `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (!resp.ok) return res.status(502).json({ error: `Google API HTTP ${resp.status}` });
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
        if (!resp.ok) return res.status(502).json({ error: `Google API HTTP ${resp.status}` });
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
        const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?${params}`;
        try {
          const u = new URL(photoUrl);
          if (!ALLOWED_HOSTS.includes(u.hostname)) return res.status(400).json({ error: 'Invalid URL host' });
        } catch {
          return res.status(400).json({ error: 'Invalid URL' });
        }
        const resp = await fetch(
          photoUrl,
          { signal: AbortSignal.timeout(10000), redirect: 'follow' }
        );
        if (!resp.ok) return res.status(resp.status).json({ error: 'Photo fetch failed' });
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
          return res.status(400).json({ error: 'Invalid content type' });
        }
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
          radius: String(sanitizeRadius(radius)),
          key: GOOGLE_KEY,
        });
        if (type) params.set('type', type);
        const resp = await fetch(
          `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!resp.ok) return res.status(502).json({ error: `Google API HTTP ${resp.status}` });
        return res.status(200).json(await resp.json());
      }

      case 'geocode': {
        const { input } = req.query;
        if (!input) return res.status(400).json({ error: 'Missing input' });
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(input + ', Ottawa, ON')}&key=${GOOGLE_KEY}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return res.status(502).json({ error: `Google API HTTP ${resp.status}` });
        const data = await resp.json();
        const results = (data.results || []).slice(0, 3).map(r => ({
          placeId: r.place_id,
          label: r.formatted_address,
          lat: r.geometry?.location?.lat,
          lng: r.geometry?.location?.lng,
        }));
        return res.status(200).json({ results });
      }

      case 'autocomplete-geocode': {
        const { input } = req.query;
        if (!input) return res.status(400).json({ error: 'Missing input' });

        // If input is purely numeric, try direct stop_id lookup first
        if (/^\d{3,5}$/.test(input.trim())) {
          try {
            const { data: stopRow } = await supabase
              .from('stops')
              .select('stop_id, stop_name, stop_lat, stop_lon')
              .eq('stop_id', input.trim())
              .single();
            if (stopRow && stopRow.stop_lat && stopRow.stop_lon) {
              // Return stop as first result, then continue with Google results
              const stopResult = {
                placeId: `stop_${stopRow.stop_id}`,
                label: `Stop ${stopRow.stop_id} — ${stopRow.stop_name || 'Transit Stop'}`,
                lat: stopRow.stop_lat,
                lng: stopRow.stop_lon,
                stopId: stopRow.stop_id,
                isTransitStop: true,
              };
              // Still fetch Google results to append
              try {
                const gResp = await fetch(
                  `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&location=45.4215,-75.6972&radius=50000&strictbounds=false&components=country:ca&key=${GOOGLE_KEY}`,
                  { signal: AbortSignal.timeout(3000) }
                );
                const gData = await gResp.json();
                const googleResults = (gData.predictions || []).slice(0, 4).map(p => ({
                  placeId: p.place_id, label: p.description, lat: null, lng: null,
                }));
                return res.status(200).json({ results: [stopResult, ...googleResults].slice(0, 5) });
              } catch {
                return res.status(200).json({ results: [stopResult] });
              }
            }
          } catch (e) { console.warn('Stop lookup error:', e.message); }
        }

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

        const [placesData, geoData] = await Promise.all([
          placesResp.ok ? placesResp.json() : { predictions: [] },
          geoResp.ok ? geoResp.json() : { results: [] },
        ]);

        const coordMap = {};
        for (const r of (geoData.results || [])) {
          if (r.geometry?.location) {
            coordMap[r.place_id] = { lat: r.geometry.location.lat, lng: r.geometry.location.lng, label: r.formatted_address };
          }
        }

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

        // For results missing coordinates, fetch individually via Place Details
        const needCoords = results.filter(r => !r.lat && r.placeId);
        if (needCoords.length > 0) {
          const detailFetches = needCoords.map(r =>
            fetch(
              `https://maps.googleapis.com/maps/api/place/details/json?place_id=${r.placeId}&fields=geometry&key=${GOOGLE_KEY}`,
              { signal: AbortSignal.timeout(3000) }
            ).then(resp => { if (!resp.ok) throw new Error(`HTTP ${resp.status}`); return resp.json(); }).then(data => {
              const loc = data.result?.geometry?.location;
              if (loc) { r.lat = loc.lat; r.lng = loc.lng; }
            }).catch(() => {})
          );
          await Promise.all(detailFetches);
        }

        const seen = new Set(results.map(r => r.placeId));
        for (const r of (geoData.results || []).slice(0, 2)) {
          if (!seen.has(r.place_id) && r.geometry?.location) {
            results.push({ placeId: r.place_id, label: r.formatted_address, lat: r.geometry.location.lat, lng: r.geometry.location.lng });
          }
        }

        return res.status(200).json({ results: results.slice(0, 5) });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error(`Places ${action} error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
