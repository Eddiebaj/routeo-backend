// api/ebevents.js — Ticketmaster proxy endpoint for RouteO
// Proxies requests to Ticketmaster Discovery API with server-side API key.
// GET /api/ebevents?action=ticketmaster&city=Ottawa&radius=50&size=20&keyword=...&startDateTime=...&endDateTime=...
const { checkRateLimit } = require('./_rateLimit');

const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY;

// In-memory cache (15 min TTL)
let tmCache = {};
let tmCacheTs = {};
const TM_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

module.exports = async function handler(req, res) {
  if (await checkRateLimit(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900');

  const action = req.query.action || '';
  if (action !== 'ticketmaster') {
    return res.status(400).json({ error: 'action=ticketmaster required' });
  }

  if (!TICKETMASTER_API_KEY) {
    return res.status(500).json({ error: 'TICKETMASTER_API_KEY not configured' });
  }

  try {
    const {
      city = 'Ottawa',
      radius = '50',
      size = '20',
      keyword,
      startDateTime,
      endDateTime,
    } = req.query;

    // Build cache key from query params
    const cacheKey = JSON.stringify({ city, radius, size, keyword, startDateTime, endDateTime });
    if (tmCache[cacheKey] && Date.now() - (tmCacheTs[cacheKey] || 0) < TM_CACHE_TTL) {
      return res.json(tmCache[cacheKey]);
    }

    const params = new URLSearchParams({
      apikey: TICKETMASTER_API_KEY,
      city,
      radius,
      size,
      unit: 'km',
      countryCode: 'CA',
      sort: 'date,asc',
    });
    if (keyword) params.set('keyword', keyword);
    if (startDateTime) params.set('startDateTime', startDateTime);
    if (endDateTime) params.set('endDateTime', endDateTime);

    const tmUrl = `https://app.ticketmaster.com/discovery/v2/events.json?${params}`;
    const resp = await fetch(tmUrl, {
      headers: { 'User-Agent': 'RouteO/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Ticketmaster API HTTP ${resp.status}` });
    }

    const data = await resp.json();

    // Extract events with lat/lng from venue data
    const events = (data._embedded?.events || []).map(ev => {
      const venue = ev._embedded?.venues?.[0] || {};
      const loc = venue.location || {};
      return {
        id: ev.id,
        name: ev.name,
        date: ev.dates?.start?.localDate || '',
        time: ev.dates?.start?.localTime || '',
        venue: venue.name || '',
        lat: loc.latitude ? parseFloat(loc.latitude) : null,
        lng: loc.longitude ? parseFloat(loc.longitude) : null,
        url: ev.url || '',
        imageUrl: ev.images?.[0]?.url || '',
        category: ev.classifications?.[0]?.segment?.name || '',
        endDateTime: ev.dates?.end?.dateTime || '',
      };
    });

    const result = { events, totalElements: data.page?.totalElements || events.length };

    // Cache the response
    tmCache[cacheKey] = result;
    tmCacheTs[cacheKey] = Date.now();

    // Limit cache size: keep at most 50 entries
    const keys = Object.keys(tmCache);
    if (keys.length > 50) {
      const oldest = keys.sort((a, b) => (tmCacheTs[a] || 0) - (tmCacheTs[b] || 0));
      for (let i = 0; i < keys.length - 50; i++) {
        delete tmCache[oldest[i]];
        delete tmCacheTs[oldest[i]];
      }
    }

    return res.json(result);
  } catch (err) {
    console.error('Ticketmaster proxy error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
