// api/parks.js  — Vercel serverless route
// Tries multiple Ottawa Open Data dataset slugs for skating rinks
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const BASE = 'https://open.ottawa.ca/api/explore/v2.1/catalog/datasets';
  const slugs = [
    'outdoor-skating-rinks',
    'skating-rinks',
    'recreation-facilities',
    'parks-facilities',
  ];
  for (const slug of slugs) {
    try {
      const resp = await fetch(`${BASE}/${slug}/records?limit=40&lang=en`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const results = data?.results || [];
      if (results.length === 0) continue;
      const parks = results.map(r => ({
        name: r.facilityname || r.facility_name || r.name || r.FacilityName || r.nom || 'Facility',
        address: r.address || r.location_address || r.streetaddress || r.adresse || '',
        type: r.type || r.facility_type || 'Recreation',
      }));
      return res.json({ parks, source: slug });
    } catch {}
  }
  res.json({ parks: [], source: null });
}
