/**
 * RouteO — Local News Aggregator
 * GET /api/news          — merged feed from 5 Ottawa RSS sources
 * GET /api/news?q=keyword — filter articles by keyword
 */

const https = require('https');
const http = require('http');

// ── Shared helpers ───────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'RouteO/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))
    || xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : '';
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractThumbnail(itemXml) {
  // Try media:content url
  const mc = itemXml.match(/<media:content[^>]+url="([^"]+)"/);
  if (mc) return mc[1];
  // Try media:thumbnail url
  const mt = itemXml.match(/<media:thumbnail[^>]+url="([^"]+)"/);
  if (mt) return mt[1];
  // Try enclosure url
  const enc = itemXml.match(/<enclosure[^>]+url="([^"]+)"/);
  if (enc) return enc[1];
  // Try og:image in description
  const og = itemXml.match(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
  if (og) return og[1];
  return '';
}

// ── RSS Sources ──────────────────────────────────────────────────
const FEEDS = [
  { name: 'CBC Ottawa', url: 'https://www.cbc.ca/cmlink/rss-canada-ottawa' },
  { name: 'Ottawa Citizen', url: 'https://ottawacitizen.com/feed' },
  { name: 'Ottawa Sun', url: 'https://ottawasun.com/feed' },
  { name: 'Capital Current', url: 'https://capitalcurrent.ca/feed/' },
  { name: 'City of Ottawa', url: 'https://ottawa.ca/en/news/rss' },
];

// ── In-memory cache ──────────────────────────────────────────────
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchAllFeeds() {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const xml = await fetchUrl(feed.url);
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      return items.map((item, i) => {
        const title = stripHtml(extractTag(item, 'title'));
        const link = extractTag(item, 'link');
        const pubDate = extractTag(item, 'pubDate');
        const description = stripHtml(extractTag(item, 'description')).slice(0, 200);
        const thumbnail = extractThumbnail(item);
        return {
          id: `${feed.name.replace(/\s/g, '_')}_${i}`,
          title,
          link,
          pubDate,
          description,
          thumbnail,
          source: feed.name,
        };
      }).filter(a => a.title && a.link);
    })
  );

  const articles = [];
  const sources = [];

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      articles.push(...results[i].value);
      sources.push({ name: FEEDS[i].name, count: results[i].value.length });
    } else {
      sources.push({ name: FEEDS[i].name, count: 0, error: results[i].reason?.message || 'failed' });
    }
  }

  // Sort by pubDate descending
  articles.sort((a, b) => {
    const da = new Date(a.pubDate).getTime() || 0;
    const db = new Date(b.pubDate).getTime() || 0;
    return db - da;
  });

  return { articles: articles.slice(0, 20), sources };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');

  try {
    // Use cache if fresh
    if (cache && Date.now() - cacheTime < CACHE_TTL) {
      const q = (req.query.q || '').toLowerCase().trim();
      if (q) {
        const filtered = cache.articles.filter(a =>
          a.title.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)
        );
        return res.json({ articles: filtered, sources: cache.sources, fetchedAt: cache.fetchedAt });
      }
      return res.json(cache);
    }

    const data = await fetchAllFeeds();
    data.fetchedAt = new Date().toISOString();
    cache = data;
    cacheTime = Date.now();

    const q = (req.query.q || '').toLowerCase().trim();
    if (q) {
      const filtered = data.articles.filter(a =>
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
      return res.json({ articles: filtered, sources: data.sources, fetchedAt: data.fetchedAt });
    }

    res.json(data);
  } catch (err) {
    console.error('News feed error:', err);
    if (cache) return res.json(cache);
    res.status(500).json({ error: err.message });
  }
};
