const CATEGORIES = [
  { label: 'Music',          slug: 'music',                    color: '#6c3fc7' },
  { label: 'Food & Drink',   slug: 'food-and-drink',           color: '#1a7a4a' },
  { label: 'Arts & Culture', slug: 'performing-and-visual-arts', color: '#b5450b' },
  { label: 'Health',         slug: 'health',                   color: '#0077b6' },
  { label: 'Sports',         slug: 'sports-and-fitness',       color: '#006400' },
  { label: 'Business',       slug: 'business',                 color: '#444' },
  { label: 'Community',      slug: 'community',                color: '#0077a0' },
  { label: 'Family',         slug: 'family-and-education',     color: '#e67e22' },
  { label: 'Science & Tech', slug: 'science-and-tech',         color: '#2c3e7a' },
  { label: 'Hobbies',        slug: 'hobbies',                  color: '#7b5ea7' },
];

const OTTAWA_KEYWORDS = ['ottawa', 'gatineau', 'kanata', 'nepean', 'barrhaven', 'gloucester', 'orleans', 'vanier', 'manotick', 'osgoode'];
const PLACES_API_KEY = 'AIzaSyCKwAVVCbxHKsKViJ4Dq0ZQ5r6k-arue3E';

const parsePage = (html, category) => {
  const events = [];
  const sdStart = html.indexOf('window.__SERVER_DATA__ = ');
  if (sdStart === -1) return events;
  const jsonStart = html.indexOf('{', sdStart);
  let depth = 0, jsonEnd = -1;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
  }
  if (jsonEnd === -1) return events;
  try {
    const sd = JSON.parse(html.slice(jsonStart, jsonEnd));
    for (const block of (sd.jsonld || [])) {
      if (block['@type'] === 'ItemList' && block.itemListElement) {
        for (const el of block.itemListElement) {
          const item = el.item || el;
          if (!item.name) continue;
          events.push({
            id: String(item.url ? item.url.split('/').filter(Boolean).pop() : Math.random()),
            name: item.name || '',
            date: (item.startDate && item.startDate.split('T')[0]) || '',
            time: (item.startDate && item.startDate.includes('T')) ? item.startDate.split('T')[1].slice(0, 5) : '',
            venue: (item.location && item.location.name) || '',
            address: (item.location && item.location.address && item.location.address.streetAddress) || '',
            url: item.url || '',
            image: item.image || null,
            free: item.isAccessibleForFree || false,
            category: category.label,
          });
        }
      }
    }
  } catch {}
  return events;
};

const fetchCategoryPage = async (category) => {
  try {
    const resp = await fetch(
      `https://www.eventbrite.ca/d/canada--ottawa/${category.slug}--events/`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html', 'Accept-Language': 'en-CA,en;q=0.9' } }
    );
    if (!resp.ok) return [];
    return parsePage(await resp.text(), category);
  } catch { return []; }
};

// Geocode a single address via Google — done server-side so mobile client does zero geocoding
const geocode = async (address) => {
  try {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address + ', Ottawa, ON')}&key=${PLACES_API_KEY}`
    );
    const d = await r.json();
    const loc = d.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch { return null; }
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    // Fetch all categories in parallel
    const pages = await Promise.all(CATEGORIES.map(cat => fetchCategoryPage(cat)));
    let events = pages.flat();

    // Filter to Ottawa only
    events = events.filter(e => {
      const text = (e.address + ' ' + e.venue + ' ' + e.name).toLowerCase();
      return OTTAWA_KEYWORDS.some(k => text.includes(k)) || e.url.includes('eventbrite.ca/');
    });

    // Deduplicate
    const seen = new Set();
    events = events.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });

    // Sort by date
    events.sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1);
    events = events.slice(0, 80);

    // Geocode upcoming events (today + next 2 days) server-side
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
    const upcomingDates = new Set();
    for (let i = 0; i < 3; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      upcomingDates.add(d.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }));
    }
    for (const e of events) {
      if (upcomingDates.has(e.date)) {
        const query = e.address || e.venue || '';
        if (query) {
          const coords = await geocode(query);
          if (coords) { e.lat = coords.lat; e.lng = coords.lng; }
        }
      }
    }

    res.json({ events, count: events.length, categories: CATEGORIES.map(c => c.label) });
  } catch (err) {
    res.status(500).json({ events: [], error: String(err) });
  }
};
