// api/ebevents.js — Scrapes Eventbrite's public Ottawa browse page
// The search API was killed in 2020 with no replacement for public event discovery.
// Eventbrite embeds a __SERVER_DATA__ JSON blob in every browse page — we parse that.

export default async function handler(req, res) {
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

    // Eventbrite embeds all page data in window.__SERVER_DATA__ or a next-data script
    let events = [];

    // Strategy 1: look for __SERVER_DATA__ JSON blob
    const sdMatch = html.match(/window\.__SERVER_DATA__\s*=\s*(\{.+?\});\s*<\/script>/s);
    if (sdMatch) {
      try {
        const sd = JSON.parse(sdMatch[1]);
        const results = sd?.search_data?.events?.results
          || sd?.data?.events
          || [];
        events = results.slice(0, 30).map(e => ({
          id: String(e.id || e.eid || Math.random()),
          name: e.name || e.title || '',
          date: e.start_date || e.start?.local?.split('T')[0] || '',
          time: e.start_time || e.start?.local?.split('T')[1]?.slice(0, 5) || '',
          venue: e.venue?.name || e.primary_venue?.name || '',
          address: e.venue?.address?.localized_address_display || '',
          url: e.url || `https://www.eventbrite.ca/e/${e.id}`,
          image: e.image?.url || e.logo?.url || null,
          free: e.is_free || false,
          category: e.tags?.[0]?.display_name || 'Event',
        }));
      } catch {}
    }

    // Strategy 2: look for next.js __NEXT_DATA__ JSON blob (newer Eventbrite)
    if (events.length === 0) {
      const ndMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
      if (ndMatch) {
        try {
          const nd = JSON.parse(ndMatch[1]);
          // Traverse next data to find events array
          const pageProps = nd?.props?.pageProps || {};
          const results = pageProps?.events || pageProps?.searchResults?.events || [];
          events = results.slice(0, 30).map((e: any) => ({
            id: String(e.id || Math.random()),
            name: e.name || e.title || '',
            date: e.start_date || '',
            time: e.start_time || '',
            venue: e.venue?.name || '',
            address: e.venue?.address?.localized_address_display || '',
            url: e.url || '',
            image: e.image?.url || null,
            free: e.is_free || false,
            category: e.primary_organizer?.name || 'Event',
          }));
        } catch {}
      }
    }

    // Strategy 3: extract structured data from ld+json schema
    if (events.length === 0) {
      const ldMatches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      for (const m of ldMatches) {
        try {
          const ld = JSON.parse(m[1]);
          const items = Array.isArray(ld) ? ld : [ld];
          for (const item of items) {
            if (item['@type'] !== 'Event') continue;
            events.push({
              id: String(item.url?.split('/').pop() || Math.random()),
              name: item.name || '',
              date: item.startDate?.split('T')[0] || '',
              time: item.startDate?.split('T')[1]?.slice(0, 5) || '',
              venue: item.location?.name || '',
              address: item.location?.address?.streetAddress || '',
              url: item.url || '',
              image: item.image || null,
              free: item.offers?.price === 0 || item.offers?.price === '0',
              category: item.eventAttendanceMode ? 'Event' : 'Event',
            });
          }
        } catch {}
      }
      events = events.slice(0, 30);
    }

    res.json({ events, count: events.length, strategy: events.length > 0 ? 'parsed' : 'failed' });
  } catch (err) {
    res.status(500).json({ events: [], error: String(err) });
  }
}
