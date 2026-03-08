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
    let strategy = 'none';

    // Extract __SERVER_DATA__ by finding the start and balancing braces
    const sdStart = html.indexOf('window.__SERVER_DATA__ = ');
    if (sdStart !== -1) {
      const jsonStart = html.indexOf('{', sdStart);
      // Walk forward balancing braces to find the end of the JSON object
      let depth = 0;
      let jsonEnd = -1;
      for (let i = jsonStart; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') {
          depth--;
          if (depth === 0) { jsonEnd = i + 1; break; }
        }
      }

      if (jsonEnd !== -1) {
        try {
          const sd = JSON.parse(html.slice(jsonStart, jsonEnd));

          // The jsonld field contains the event list
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
                  category: (item.organizer && item.organizer.name) || 'Event',
                });
              }
            }
          }

          // Also try search_data path
          if (events.length === 0) {
            const results = (sd.search_data && sd.search_data.events && sd.search_data.events.results) || [];
            for (const e of results) {
              events.push({
                id: String(e.id || Math.random()),
                name: e.name || e.title || '',
                date: e.start_date || '',
                time: e.start_time || '',
                venue: (e.venue && e.venue.name) || (e.primary_venue && e.primary_venue.name) || '',
                address: (e.venue && e.venue.address && e.venue.address.localized_address_display) || '',
                url: e.url || '',
                image: (e.image && e.image.url) || null,
                free: e.is_free || false,
                category: (e.tags && e.tags[0] && e.tags[0].display_name) || 'Event',
              });
            }
          }

          strategy = events.length > 0 ? 'SERVER_DATA' : 'SERVER_DATA_empty';
        } catch (e) {
          strategy = 'parse_error:' + e.message.slice(0, 80);
        }
      }
    }

    // Fallback: ld+json structured data in <script> tags
    if (events.length === 0) {
      const ldRegex = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/g;
      let m;
      while ((m = ldRegex.exec(html)) !== null) {
        try {
          const ld = JSON.parse(m[1]);
          const items = Array.isArray(ld) ? ld : [ld];
          for (const block of items) {
            const list = block['@type'] === 'ItemList' ? (block.itemListElement || []) : [{ item: block }];
            for (const el of list) {
              const item = el.item || el;
              if (item['@type'] !== 'Event' || !item.name) continue;
              events.push({
                id: String((item.url && item.url.split('/').filter(Boolean).pop()) || Math.random()),
                name: item.name || '',
                date: (item.startDate && item.startDate.split('T')[0]) || '',
                time: (item.startDate && item.startDate.includes('T')) ? item.startDate.split('T')[1].slice(0, 5) : '',
                venue: (item.location && item.location.name) || '',
                address: (item.location && item.location.address && item.location.address.streetAddress) || '',
                url: item.url || '',
                image: item.image || null,
                free: item.isAccessibleForFree || false,
                category: 'Event',
              });
            }
          }
        } catch (e) {}
      }
      if (events.length > 0) strategy = 'LD_JSON';
    }

    events = events.slice(0, 30);
    res.json({ events, count: events.length, strategy });
  } catch (err) {
    res.status(500).json({ events: [], error: String(err) });
  }
};
