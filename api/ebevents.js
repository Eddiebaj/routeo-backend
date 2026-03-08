module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const resp = await fetch(
      'https://www.eventbrite.ca/d/canada--ottawa/events/?page=1',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-CA,en;q=0.9',
        },
      }
    );

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    let events = [];

    const sdStart = html.indexOf('window.__SERVER_DATA__ = ');
    if (sdStart !== -1) {
      const jsonStart = html.indexOf('{', sdStart);
      let depth = 0, jsonEnd = -1;
      for (let i = jsonStart; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
      }
      if (jsonEnd !== -1) {
        const sd = JSON.parse(html.slice(jsonStart, jsonEnd));
        const jsonld = sd.jsonld || [];
        for (const block of jsonld) {
          if (block['@type'] === 'ItemList' && block.itemListElement) {
            for (const el of block.itemListElement) {
              const item = el.item || el;
              if (!item.name) continue;
              events.push({
                id: String(item.url ? item.url.split('/').filter(Boolean).pop() : Math.random()),
                name: item.name || '',
                date: (item.startDate && item.startDate.split('T')[0]) || item.startDate || '',
                time: (item.startDate && item.startDate.includes('T')) ? item.startDate.split('T')[1].slice(0, 5) : '',
                venue: (item.location && item.location.name) || '',
                address: (item.location && item.location.address && item.location.address.streetAddress) || '',
                url: item.url || '',
                image: item.image || (item.photo && item.photo.url) || null,
                free: item.isAccessibleForFree || false,
                category: 'Event',
              });
            }
          }
        }
      }
    }

    // Filter: keep only events with an Ottawa/Gatineau address or a .ca URL
    // Remove events with no address AND a non-CA eventbrite domain (those are global spam)
    const OTTAWA_KEYWORDS = ['ottawa', 'gatineau', 'kanata', 'nepean', 'barrhaven', 'gloucester', 'orleans', 'vanier'];
    events = events.filter(e => {
      const addr = (e.address + ' ' + e.venue).toLowerCase();
      const hasOttawaAddr = OTTAWA_KEYWORDS.some(k => addr.includes(k));
      const isCaUrl = e.url.includes('eventbrite.ca/') || e.url.includes('eventbrite.com/e/');
      const hasNoAddr = !e.address && !e.venue;
      // Keep if it has an Ottawa address, or if it's a .ca URL with no address (might be online Ottawa event)
      // Drop if no address AND non-CA domain (global junk)
      if (hasNoAddr && !e.url.includes('eventbrite.ca')) return false;
      if (e.address && !hasOttawaAddr) return false;
      return true;
    });

    // Deduplicate by id
    const seen = new Set();
    events = events.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    // Sort by date
    events.sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1);

    res.json({ events: events.slice(0, 30), count: events.length });
  } catch (err) {
    res.status(500).json({ events: [], error: String(err) });
  }
};
