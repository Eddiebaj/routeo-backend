// api/ebevents.js  — Vercel serverless route
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const API_KEY  = 'ZDL5OYG3FB6LFG5O6P';
  const TOKEN    = 'THZPF2PNV6AADGI572CV';

  // Eventbrite public event search — API key goes in header as OAuth token
  // location.address + location.within does geo filtering server-side
  const url = [
    'https://www.eventbriteapi.com/v3/events/search/',
    '?location.address=Ottawa%2C+ON%2C+Canada',
    '&location.within=30km',
    '&expand=venue',
    '&sort_by=date',
    '&start_date.keyword=today',
    '&status=live',
  ].join('');

  try {
    // Try with private token first (works if app has right scopes)
    let resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });

    // Fallback: API key as token
    if (!resp.ok) {
      resp = await fetch(url + `&token=${API_KEY}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(500).json({ events: [], error: `Eventbrite ${resp.status}: ${errText}` });
    }

    const data = await resp.json();
    const events = (data?.events || []).slice(0, 30).map(e => ({
      id: e.id,
      name: e.name?.text || '',
      date: e.start?.local?.split('T')[0] || '',
      time: e.start?.local?.split('T')[1]?.slice(0, 5) || '',
      venue: e.venue?.name || '',
      address: e.venue?.address?.localized_address_display || '',
      url: e.url || '',
      image: e.logo?.url || null,
      free: e.is_free || false,
    }));

    res.json({ events, total: data?.pagination?.object_count || events.length });
  } catch (err) {
    res.status(500).json({ events: [], error: String(err) });
  }
}
