// api/ebevents.js — CommonJS (no ESM in this project)
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

    // Strategy 1: window.__SERVER_DATA__
    const sdMatch = html.match(/window\.__SERVER_DATA__\s*=\s*(\{[\s\S]+?\});\s*<\/script>/);
    if (sdMatch) {
      try {
        const sd = JSON.parse(sdMatch[1]);
        const results = (sd && sd.search_data && sd.search_data.events && sd.search_data.events.results) || [];
        if (results.length > 0) {
          strategy = 'SERVER_DATA';
          events = results.slice(0, 30).map(e => ({
            id: String(e.id || Math.random()),
            name: e.name || e.title || '',
            date: e.start_date || '',
            time: e.start_time || '',
            venue: (e.venue && e.venue.name) || (e.primary_venue && e.primary_venue.name) || '',
            address: (e.venue && e.venue.address && e.venue.address.localized_address_display) || '',
            url: e.url || '',
            image: (e.image && e.image.url) || (e.logo && e.logo.url) || null,
            free: e.is_free || false,
            category: (e.tags && e.tags[0] && e.tags[0].display_name) || 'Event',
          }));
        }
      } catch (e) {}
    }

    // Strategy 2: __NEXT_DATA__
    if (events.length === 0) {
      const ndMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
      if (ndMatch) {
        try {
          const nd = JSON.parse(ndMatch[1]);
          const pageProps = (nd && nd.props && nd.props.pageProps) || {};
          const results = pageProps.events
            || (pageProps.searchResults && pageProps.searchResults.events)
            || (pageProps.initialData && pageProps.initialData.events)
            || [];
          if (results.length > 0) {
            strategy = 'NEXT_DATA';
            events = results.slice(0, 30).map(e => ({
              id: String(e.id || Math.random()),
              name: e.name || e.title || '',
              date: e.start_date || (e.start && e.start.local && e.start.local.split('T')[0]) || '',
              time: e.start_time || (e.start && e.start.local && e.start.local.split('T')[1] && e.start.local.split('T')[1].slice(0, 5)) || '',
              venue: (e.venue && e.venue.name) || '',
              address: (e.venue && e.venue.address && e.venue.address.localized_address_display) || '',
              url: e.url || '',
              image: (e.image && e.image.url) || (e.logo && e.logo.url) || null,
              free: e.is_free || false,
              category: (e.category && e.category.name) || 'Event',
            }));
          }
        } catch (e) {}
      }
    }

    // Strategy 3: ld+json structured data
    if (events.length === 0) {
      const ldRegex = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/g;
      let m;
      while ((m = ldRegex.exec(html)) !== null) {
        try {
          const ld = JSON.parse(m[1]);
          const items = Array.isArray(ld) ? ld : [ld];
          for (const item of items) {
            if (item['@type'] !== 'Event') continue;
            events.push({
              id: String((item.url && item.url.split('/').filter(Boolean).pop()) || Math.random()),
              name: item.name || '',
              date: (item.startDate && item.startDate.split('T')[0]) || '',
              time: (item.startDate && item.startDate.split('T')[1] && item.startDate.split('T')[1].slice(0, 5)) || '',
              venue: (item.location && item.location.name) || '',
              address: (item.location && item.location.address && item.location.address.streetAddress) || '',
              url: item.url || '',
              image: item.image || null,
              free: (item.offers && (item.offers.price === 0 || item.offers.price === '0')) || false,
              category: 'Event',
            });
          }
          if (events.length > 0) strategy = 'LD_JSON';
        } catch (e) {}
      }
      events = events.slice(0, 30);
    }

    // Debug: return a snippet of html if nothing parsed
    const debugSnippet = events.length === 0
      ? html.slice(0, 500)
      : null;

    res.json({ events, count: events.length, strategy, debug: debugSnippet });
  } catch (err) {
    res.status(500).json({ events: [], error: String(err) });
  }
};
