/**
 * RouteO — Service Alerts + LRT Status API
 * GET /api/alerts           — OC Transpo RSS alerts
 * GET /api/alerts?action=lrt — OccasionalTransport.ca LRT station status
 */

const { checkRateLimit } = require('./_rateLimit');
const https = require('https');

// ── Shared helpers ───────────────────────────────────────────────
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'RouteO/1.0' } }, (res) => {
      let data = '';
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) { req.destroy(); return reject(new Error('Response body too large')); }
        data += chunk;
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
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

const STO_ALERTS_URL = 'https://www.sto.ca/rss-alertes';

async function handleAlerts(res) {
  // Fetch OC Transpo and STO alerts in parallel
  const [ocResult, stoResult] = await Promise.allSettled([
    fetchUrl(RSS_URL),
    fetchUrl(STO_ALERTS_URL),
  ]);

  const alerts = [];

  // Parse OC Transpo alerts
  if (ocResult.status === 'fulfilled') {
    const xml = ocResult.value;
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    for (let i = 0; i < itemMatches.length; i++) {
      const item = itemMatches[i];
      const title       = stripHtml(extractTag(item, 'title'));
      const description = stripHtml(extractTag(item, 'description'));
      const link        = extractTag(item, 'link');
      const pubDate     = extractTag(item, 'pubDate');
      const routes      = extractRoutes(title + ' ' + description);
      const category    = categorize(title);
      alerts.push({
        id: i, title,
        description: description.slice(0, 300) + (description.length > 300 ? '...' : ''),
        link, pubDate, routes, category, agency: 'OC',
      });
    }
  }

  // Parse STO alerts
  if (stoResult.status === 'fulfilled') {
    const stoXml = stoResult.value;
    const stoItems = stoXml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    const ocCount = alerts.length;
    for (let i = 0; i < stoItems.length; i++) {
      const item = stoItems[i];
      const title       = stripHtml(extractTag(item, 'title'));
      const description = stripHtml(extractTag(item, 'description'));
      const link        = extractTag(item, 'link');
      const pubDate     = extractTag(item, 'pubDate');
      const routes      = extractRoutes(title + ' ' + description);
      const category    = categorize(title);
      alerts.push({
        id: ocCount + i, title: `[STO] ${title}`,
        description: description.slice(0, 300) + (description.length > 300 ? '...' : ''),
        link, pubDate, routes, category, agency: 'STO',
      });
    }
  }

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

function parseStations(html, stations, prefix) {
  // Station buttons use Bootstrap: bg-success = ok, bg-danger = disrupted
  // IDs: stationDetails{Key} (Line 1), stationDetails2{Key} (Line 2), stationDetails4{Key} (Line 4)
  return stations.map(s => {
    const id = prefix + s.key;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match the button that targets this station's accordion
    const re = new RegExp('class="accordion-button\\s+([^"]*)"[^>]*?#stationDetails' + esc, 'i');
    const m = html.match(re);
    const classes = m ? m[1].toLowerCase() : '';
    const bad = classes.includes('bg-danger');
    return { code: s.code, name: s.name, ok: !bad };
  });
}

function parseIncidents(html) {
  const incidents = [];
  const seen = new Set();

  // Split by card-header boundaries (each incident is a Bootstrap card)
  const cards = html.split(/card-header[^>]*id="heading/gi);
  for (let i = 1; i < cards.length; i++) {
    const card = cards[i];

    // Extract hours from btn-social span: <span class="btn-social mt-1">23h</span>
    const timeMatch = card.match(/btn-social[^>]*>(\d{1,4}(?:\.\d)?)h<\//i);
    if (!timeMatch) continue;
    const hoursAgo = parseFloat(timeMatch[1]);
    if (hoursAgo > 720) continue; // skip >30 days

    // Extract affected stations — those with alert-danger class
    const affectedStations = [];
    const dangerMatches = card.match(/alert-danger[^>]*>([A-Z]{2,3})</g) || [];
    for (const dm of dangerMatches) {
      const code = dm.match(/>([A-Z]{2,3})/);
      if (code) affectedStations.push(code[1]);
    }

    // Extract description from text-uppercase text-secondary div
    const descMatch = card.match(/text-uppercase text-secondary[^>]*>([^<]+)</);
    let desc = descMatch ? descMatch[1].trim() : '';
    if (desc.length < 10 || seen.has(desc)) continue;
    seen.add(desc);

    incidents.push({ hoursAgo, description: desc, affectedStations: [...new Set(affectedStations)] });
  }
  incidents.sort((a, b) => a.hoursAgo - b.hoursAgo);
  return incidents.slice(0, 15);
}

async function handleLrt(res) {
  if (lrtCache && Date.now() - lrtCacheTime < LRT_CACHE_TTL) {
    return res.status(200).json(lrtCache);
  }

  const html = await fetchUrl('https://occasionaltransport.ca/');
  // IDs: stationDetails{Key} (L1), stationDetails2{Key} (L2), stationDetails4{Key} (L4)
  const line1Stations = parseStations(html, LINE1, '');
  const line2Stations = parseStations(html, LINE2, '2');
  const line4Stations = parseStations(html, LINE4, '4');

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
  if (checkRateLimit(req, res)) return;
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
    res.status(500).json({ error: 'Internal server error' });
  }
};
