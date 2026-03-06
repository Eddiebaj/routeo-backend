/**
 * RouteO — Service Alerts API
 * GET /api/alerts
 * Fetches OC Transpo RSS alerts feed and returns clean JSON
 */

const https = require('https');

const RSS_URL = 'https://www.octranspo.com/en/alerts/rss';

function fetchRSS(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Extract text between XML tags
function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`)
  ) || xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : '';
}

// Parse route numbers out of title/description e.g. "Route 95", "Routes 1, 2, 95"
function extractRoutes(text) {
  const matches = text.match(/[Rr]outes?\s+([\d,\s]+)/g) || [];
  const routes = [];
  for (const m of matches) {
    const nums = m.match(/\d+/g) || [];
    routes.push(...nums);
  }
  return [...new Set(routes)];
}

// Strip HTML tags from description
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Categorize alert
function categorize(title) {
  const t = title.toLowerCase();
  if (t.includes('elevator') || t.includes('accessibility')) return 'accessibility';
  if (t.includes('detour') || t.includes('divert')) return 'detour';
  if (t.includes('cancel') || t.includes('suspend')) return 'cancellation';
  if (t.includes('delay')) return 'delay';
  if (t.includes('lrt') || t.includes('o-train') || t.includes('line 1') || t.includes('line 2')) return 'lrt';
  return 'general';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300'); // cache 5 min on Vercel edge

  try {
    const xml = await fetchRSS(RSS_URL);

    // Split into individual items
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

    const alerts = itemMatches.map((item, index) => {
      const title       = stripHtml(extractTag(item, 'title'));
      const description = stripHtml(extractTag(item, 'description'));
      const link        = extractTag(item, 'link');
      const pubDate     = extractTag(item, 'pubDate');
      const routes      = extractRoutes(title + ' ' + description);
      const category    = categorize(title);

      return {
        id:          index,
        title,
        description: description.slice(0, 300) + (description.length > 300 ? '...' : ''),
        link,
        pubDate,
        routes,
        category,
      };
    });

    res.json({
      ok: true,
      count: alerts.length,
      alerts,
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Alerts error:', err);
    res.status(500).json({ error: err.message });
  }
};
