/**
 * RouteO — Local News Aggregator
 * GET /api/news          — merged feed from 6 Ottawa RSS sources
 * GET /api/news?q=keyword — filter articles by keyword
 */

const https = require('https');
const http = require('http');

// ── Shared helpers ───────────────────────────────────────────────
function fetchUrl(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'RouteO/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Fetch with retry — retries up to `retries` times with exponential backoff
 */
async function fetchWithRetry(url, retries = 2, baseDelay = 1000) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchUrl(url);
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
      }
    }
  }
  throw lastErr;
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
  // Try enclosure url (image types only)
  const enc = itemXml.match(/<enclosure[^>]+url="([^"]+)"[^>]+type="image/);
  if (enc) return enc[1];
  // Try enclosure url without type check
  const enc2 = itemXml.match(/<enclosure[^>]+url="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
  if (enc2) return enc2[1];
  // Try img src in description/content
  const img = itemXml.match(/<img[^>]+src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
  if (img) return img[1];
  // Try image tag (Atom feeds)
  const imgTag = itemXml.match(/<image[^>]*>([^<]+)<\/image>/);
  if (imgTag && imgTag[1].startsWith('http')) return imgTag[1].trim();
  return '';
}

// ── RSS Sources ──────────────────────────────────────────────────
const FEEDS = [
  { name: 'CBC Ottawa', url: 'https://www.cbc.ca/cmlink/rss-canada-ottawa', critical: true },
  { name: 'Ottawa Citizen', url: 'https://ottawacitizen.com/feed', critical: true },
  { name: 'Ottawa Sun', url: 'https://ottawasun.com/feed', critical: false },
  { name: 'Capital Current', url: 'https://capitalcurrent.ca/feed/', critical: false },
  { name: 'City of Ottawa', url: 'https://ottawa.ca/en/news/rss', critical: false },
  { name: 'Apt613', url: 'https://apt613.ca/feed/', critical: false },
];

// ── Per-feed failure tracking for adaptive retries ───────────────
const feedFailures = {};

// ── In-memory cache ──────────────────────────────────────────────
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchAllFeeds() {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const failures = feedFailures[feed.name] || 0;
      // Critical feeds or feeds that haven't failed recently get more retries
      const retries = feed.critical ? 2 : (failures >= 3 ? 0 : 1);
      const xml = await fetchWithRetry(feed.url, retries);
      // Reset failure counter on success
      feedFailures[feed.name] = 0;
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
      // Track failures for adaptive retry logic
      feedFailures[FEEDS[i].name] = (feedFailures[FEEDS[i].name] || 0) + 1;
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
