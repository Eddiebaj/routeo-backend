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

    // Return a large debug chunk so we can see what's actually in the page
    // Look for any JSON blobs or script tags
    const hasServerData = html.includes('__SERVER_DATA__');
    const hasNextData = html.includes('__NEXT_DATA__');
    const hasLdJson = html.includes('application/ld+json');
    const hasEventCard = html.includes('event-card') || html.includes('eds-event-card');
    const scriptTags = (html.match(/<script[^>]*>/g) || []).length;

    // Grab a 3000 char window around any JSON blob we find
    let jsonSample = '';
    const markers = ['__SERVER_DATA__', '__NEXT_DATA__', 'application/ld+json', 'startDate', 'start_date'];
    for (const marker of markers) {
      const idx = html.indexOf(marker);
      if (idx !== -1) {
        jsonSample = `[found: ${marker} at ${idx}] ` + html.slice(Math.max(0, idx - 20), idx + 200);
        break;
      }
    }

    res.json({
      htmlLength: html.length,
      hasServerData,
      hasNextData,
      hasLdJson,
      hasEventCard,
      scriptTags,
      jsonSample: jsonSample || 'none found',
      htmlStart: html.slice(0, 300),
      htmlEnd: html.slice(-500),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
