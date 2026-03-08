// api/511events.js  — Vercel serverless route
// Proxies 511 Ontario events API, filters to Ottawa area
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const resp = await fetch('https://511on.ca/api/v2/Events?format=json&lang=en', {
      headers: { 'User-Agent': 'RouteO/1.0' },
    });
    if (!resp.ok) throw new Error(`511 status ${resp.status}`);
    const data = await resp.json();
    const list = Array.isArray(data) ? data : (data?.Events || data?.events || []);
    const ottawa = list.filter(e => {
      const fields = [
        e.Municipality, e.municipality,
        e.County, e.county,
        e.Region, e.region,
        e.RoadwayName, e.roadway,
      ].map(v => (v || '').toLowerCase());
      return fields.some(f => f.includes('ottawa'));
    }).slice(0, 30).map(e => ({
      id: String(e.ID || e.Id || e.id || Math.random()),
      description: e.Description || e.description || e.EventType || 'Road event',
      type: e.EventType || e.eventType || e.Type || 'Event',
      road: e.RoadwayName || e.roadway || e.Name || '',
    }));
    res.json({ events: ottawa });
  } catch (err) {
    res.status(500).json({ events: [], error: String(err) });
  }
}
