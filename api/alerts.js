/**
 * RouteO — Service Alerts + LRT Status API
 * GET /api/alerts           — OC Transpo RSS alerts
 * GET /api/alerts?action=lrt — OccasionalTransport.ca LRT station status
 */

const https = require('https');

// ── Shared helpers ───────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'RouteO/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════
// OC Transpo RSS Alerts
// ══════════════════════════════════════════════════════════════════
const RSS_URL = 'https://www.octranspo.com/en/alerts/rss';

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`)
  ) || xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : '';
}

function extractRoutes(text) {
  const matches = text.match(/[Rr]outes?\s+([\d,\s]+)/g) || [];
  const routes = [];
  for (const m of matches) {
    const nums = m.match(/\d+/g) || [];
    routes.push(...nums);
  }
  return [...new Set(routes)];
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function categorize(title) {
  const t = title.toLowerCase();
  if (t.includes('elevator') || t.includes('accessibility')) return 'accessibility';
  if (t.includes('detour') || t.includes('divert')) return 'detour';
  if (t.includes('cancel') || t.includes('suspend')) return 'cancellation';
  if (t.includes('delay')) return 'delay';
  if (t.includes('lrt') || t.includes('o-train') || t.includes('line 1') || t.includes('line 2')) return 'lrt';
  return 'general';
}

async function handleAlerts(res) {
  const xml = await fetchUrl(RSS_URL);
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  const alerts = itemMatches.map((item, index) => {
    const title       = stripHtml(extractTag(item, 'title'));
    const description = stripHtml(extractTag(item, 'description'));
    const link        = extractTag(item, 'link');
    const pubDate     = extractTag(item, 'pubDate');
    const routes      = extractRoutes(title + ' ' + description);
    const category    = categorize(title);
    return {
      id: index, title,
      description: description.slice(0, 300) + (description.length > 300 ? '...' : ''),
      link, pubDate, routes, category,
    };
  });

  res.json({ ok: true, count: alerts.length, alerts, fetchedAt: new Date().toISOString() });
}

// ══════════════════════════════════════════════════════════════════
// LRT Status from OccasionalTransport.ca
// ══════════════════════════════════════════════════════════════════
const LINE1 = [
  { code: 'TP', name: "Tunney's Pasture", key: 'Tunneys_Pasture' },
  { code: 'BAY', name: 'Bayview', key: 'Bayview' },
  { code: 'PIM', name: 'Pimisi', key: 'Pimisi' },
  { code: 'LYN', name: 'Lyon', key: 'Lyon' },
  { code: 'PAR', name: 'Parliament', key: 'Parliament' },
  { code: 'RDU', name: 'Rideau', key: 'Rideau' },
  { code: 'UOT', name: 'uOttawa', key: 'uOttawa' },
  { code: 'LEE', name: 'Lees', key: 'Lees' },
  { code: 'HRD', name: 'Hurdman', key: 'Hurdman' },
  { code: 'TMB', name: 'Tremblay', key: 'Tremblay' },
  { code: 'STL', name: 'St-Laurent', key: 'St_Laurent' },
  { code: 'CYR', name: 'Cyrville', key: 'Cyrville' },
  { code: 'BLA', name: 'Blair', key: 'Blair' },
];
const LINE2 = [
  { code: 'BAY', name: 'Bayview', key: 'Bayview2' },
  { code: 'ITA', name: 'Corso Italia', key: 'Corso_Italia' },
  { code: 'DOW', name: "Dow's Lake", key: 'Dows_Lake' },
  { code: 'CAR', name: 'Carleton', key: 'Carleton' },
  { code: 'MNB', name: "Mooney's Bay", key: 'Mooneys_Bay' },
  { code: 'WLK', name: 'Walkley', key: 'Walkley' },
  { code: 'GBO', name: 'Greenboro', key: 'Greenboro' },
  { code: 'SKY', name: 'South Keys', key: 'South_Keys2' },
  { code: 'LTR', name: 'Leitrim', key: 'LeTrim' },
  { code: 'BOW', name: 'Bowesville', key: 'Bowesville' },
  { code: 'LMB', name: 'Limebank', key: 'Limebank' },
];
const LINE4 = [
  { code: 'SKY', name: 'South Keys', key: 'South_Keys4' },
  { code: 'UPL', name: 'Uplands', key: 'Uplands' },
  { code: 'YOW', name: 'Airport', key: 'Airport' },
];

let lrtCache = null;
let lrtCacheTime = 0;
const LRT_CACHE_TTL = 5 * 60 * 1000;

function parseStations(html, stations) {
  return stations.map(s => {
    const esc = s.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc + '[\\s\\S]{0,400}', 'i');
    const m = html.match(re);
    const ctx = m ? m[0].toLowerCase() : '';
    const bad = ctx.includes('red') || ctx.includes('bad') || ctx.includes('disrupted') ||
                ctx.includes('not running') || ctx.includes('closed');
    return { code: s.code, name: s.name, ok: !bad };
  });
}

function parseIncidents(html) {
  const incidents = [];
  const seen = new Set();
  // Look for time markers like "23h" or "213h ago" followed by descriptive text
  const blocks = html.split(/(?=\d{1,4}(?:\.\d)?h\s)/gi);
  for (const block of blocks) {
    const timeMatch = block.match(/^(\d{1,4}(?:\.\d)?)h\s/i);
    if (!timeMatch) continue;
    const hoursAgo = parseFloat(timeMatch[1]);
    if (hoursAgo > 720) continue; // skip >30 days

    // Extract line codes like L1TPBAYPIMLYNPAR
    const lineCodes = block.match(/L[124][A-Z]{2,}/g) || [];
    const affectedStations = [];
    for (const lc of lineCodes) {
      const codes = lc.substring(2);
      for (let i = 0; i < codes.length; i += 3) {
        const c = codes.substring(i, Math.min(i + 3, codes.length));
        if (c.length >= 2) affectedStations.push(c);
      }
    }

    // Extract description — take text after the line codes, clean it
    let desc = block.replace(/^[\d.]+h\s*/i, '').replace(/L[124][A-Z]+/g, '').replace(/<[^>]*>/g, '');
    desc = desc.replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
    // Take first sentence-like chunk (up to 300 chars)
    desc = desc.substring(0, 300).replace(/\s+\S*$/, '').trim();
    if (desc.length < 15 || seen.has(desc)) continue;
    seen.add(desc);

    incidents.push({ hoursAgo, description: desc, affectedStations: [...new Set(affectedStations)] });
  }
  incidents.sort((a, b) => a.hoursAgo - b.hoursAgo);
  return incidents.slice(0, 10);
}

async function handleLrt(res) {
  if (lrtCache && Date.now() - lrtCacheTime < LRT_CACHE_TTL) {
    return res.status(200).json(lrtCache);
  }

  const html = await fetchUrl('https://occasionaltransport.ca/');
  const line1Stations = parseStations(html, LINE1);
  const line2Stations = parseStations(html, LINE2);
  const line4Stations = parseStations(html, LINE4);

  const result = {
    line1: { status: line1Stations.some(s => !s.ok) ? 'disrupted' : 'running', stations: line1Stations },
    line2: { status: line2Stations.some(s => !s.ok) ? 'disrupted' : 'running', stations: line2Stations },
    line4: { status: line4Stations.some(s => !s.ok) ? 'disrupted' : 'running', stations: line4Stations },
    incidents: parseIncidents(html),
    fetchedAt: new Date().toISOString(),
  };

  lrtCache = result;
  lrtCacheTime = Date.now();
  return res.status(200).json(result);
}

// ══════════════════════════════════════════════════════════════════
// Handler — routes by ?action=
// ══════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');

  try {
    if (req.query.action === 'lrt') {
      return await handleLrt(res);
    }
    return await handleAlerts(res);
  } catch (err) {
    console.error('Alerts/LRT error:', err);
    if (req.query.action === 'lrt' && lrtCache) return res.status(200).json(lrtCache);
    res.status(500).json({ error: err.message });
  }
};
