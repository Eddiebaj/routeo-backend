// api/ebevents.js  — Vercel serverless route
// Eventbrite server-side proxy (avoids CORS + token-in-URL deprecation)
const EVENTBRITE_KEY = process.env.EVENTBRITE_KEY || 'THZPF2PNV6AADGI572CV';
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const resp = await fetch(
      'https://www.eventbriteapi.com/v3/events/search/?location.address=Ottawa%2C+ON%2C+Canada&location.within=30km&expand=venue&sort_by=date&start_date.keyword=today',
      { headers: { 'Authorization': `Bearer ${EVENTBRITE_KEY}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) throw new Error(`Eventbrite ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const events = (data?.events || []).slice(0, 30).map(e => ({
      id: e.id,
      name: e.name?.text || '',
      date: e.start?.local?.split('T')[0] || '',
      venue: e.venue?.name || '',
      url: e.url || '',
      image: e.logo?.url || null,
    }));
    res.json({ events });
  } catch (err) {
    res.status(500).json({ events: [], error: String(err) });
  }
}
